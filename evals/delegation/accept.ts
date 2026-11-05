#!/usr/bin/env bun
// impl 组的隐藏验收：不看 Worker 自己写的测试，直接按需求调它改过的导出函数。
//   bun accept.ts <任务> <repo>   → 最后一行打印 {"total":N,"failed":[未通过的用例名]}
// repo/node_modules 由 worker.ts 链到宿主源码。以 TZ=Asia/Shanghai 跑：本地 0 点与 UTC 0 点差 8 小时，按 UTC 解析日期的实现会挂。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [task, repo] = process.argv.slice(2) as [string, string];
type Check = (name: string, run: () => unknown) => void;

/** 导入失败（没导出、语法错）时所有用例按失败计，不中断。 */
async function load(path: string): Promise<any> {
	try {
		return await import(join(repo, path));
	} catch {
		return {};
	}
}

async function duration(check: Check): Promise<void> {
	const { formatDuration: f } = await load("format.ts");
	const H = 3_600_000;
	const cases: Array<[number, string]> = [[25.5 * H, "1d1h30m"], [24 * H, "1d"], [24 * H + 25_000, "1d25s"], [48 * H + 180_000, "2d3m"], [3 * H, "3h"], [59_000, "59s"], [9_900, "9.9s"], [24 * H - 400, "1d"]];
	for (const [ms, want] of cases) check(want + "←" + ms, () => f(ms) === want);
}

async function stats(check: Check): Promise<void> {
	const mod = await load("session/stats.ts");
	const DAY = 86_400_000;
	const NOW = Date.parse("2026-03-10T04:00:00Z");
	const local = (date: string) => Date.parse(date + "T00:00:00+08:00");
	const parse = (args: string | undefined) => mod.parseTokensArgs(args, NOW);
	const same = (got: any, want: { from?: number; to: number; groupBy: string }) => got.from === want.from && got.to === want.to && got.groupBy === want.groupBy;
	const throws = (args: string) => {
		try {
			parse(args);
			return false;
		} catch {
			return true;
		}
	};

	check("parse:空=30天", () => same(parse(undefined), { from: NOW - 30 * DAY, to: NOW, groupBy: "model" }) && same(parse("  "), { from: NOW - 30 * DAY, to: NOW, groupBy: "model" }));
	check("parse:7/7d/--days/-d", () => ["7", "7d", "--days 7", "-d 7"].every((a) => same(parse(a), { from: NOW - 7 * DAY, to: NOW, groupBy: "model" })));
	check("parse:0=全部", () => same(parse("0"), { to: NOW, groupBy: "model" }));
	check("parse:since本地0点", () => same(parse("--since 2026-03-01"), { from: local("2026-03-01"), to: NOW, groupBy: "model" }));
	check("parse:until含当天", () => same(parse("--since 2026-03-01 --until 2026-03-01"), { from: local("2026-03-01"), to: local("2026-03-02"), groupBy: "model" }));
	check("parse:until跨月", () => same(parse("--until 2026-02-28 --since 2026-02-01"), { from: local("2026-02-01"), to: local("2026-03-01"), groupBy: "model" }));
	check("parse:--by组合", () => same(parse("-d 7 --by day"), { from: NOW - 7 * DAY, to: NOW, groupBy: "day" }) && same(parse("--by day --since 2026-03-01"), { from: local("2026-03-01"), to: NOW, groupBy: "day" }) && same(parse("--by model 0"), { to: NOW, groupBy: "model" }));
	check("parse:错-天数与日期并用", () => throws("7 --since 2026-03-01") && throws("--days 7 --until 2026-03-01"));
	check("parse:错-非法日期", () => throws("--since 2026-02-30") && throws("--since 2026-3-1") && throws("--since"));
	check("parse:错-since晚于until", () => throws("--since 2026-03-02 --until 2026-03-01"));
	check("parse:错-未知参数", () => throws("--foo") && throws("--by week") && throws("abc"));

	// 会话目录：a.jsonl 有各种记录；sub/b.jsonl 只有窗口外的；c.txt 不是会话文件。
	const dir = mkdtempSync(join(tmpdir(), "stats-accept-"));
	mkdirSync(join(dir, "sub"));
	const usage = (input: number, output: number, cost: number, extra: object = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost }, ...extra });
	const assistant = (model: string, ts: number | undefined, u: object) => ({ type: "message", message: { role: "assistant", provider: "p", model, usage: u, ...(ts === undefined ? {} : { timestamp: ts }) } });
	const FROM = local("2026-03-01");
	const TO = local("2026-03-03");
	const lines = [
		assistant("m1", FROM, usage(10, 1, 0.1)), // 恰好在起点：计入，本地 03-01
		assistant("m1", local("2026-03-02") + 30 * 60_000, usage(20, 2, 0.2)), // UTC 是 03-01 16:30，本地 03-02
		assistant("m2", TO - 1, usage(30, 3, 0.3, { totalTokens: 1000 })), // 本地 03-02 末尾
		assistant("m2", TO, usage(40, 4, 0.4)), // 恰好在终点：不计
		assistant("m1", FROM - 1, usage(50, 5, 0.5)), // 起点前：不计，本地 02-28
		{ type: "message", timestamp: "2026-03-01T17:00:00.000Z", message: { role: "toolResult", usage: usage(7, 0, 0.07) } }, // 只有条目时间戳，本地 03-02 01:00
		assistant("m3", undefined, usage(60, 6, 0.6)), // 没有时间戳
		{ type: "compaction", timestamp: "2026-03-01T01:00:00.000Z", usage: usage(5, 5, 0.05) }, // 本地 03-01
		"{not json",
	];
	writeFileSync(join(dir, "a.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
	writeFileSync(join(dir, "sub", "b.jsonl"), JSON.stringify(assistant("m1", FROM - DAY, usage(1, 1, 1))) + "\n");
	writeFileSync(join(dir, "c.txt"), JSON.stringify(assistant("m1", FROM, usage(1, 1, 1))) + "\n");

	const collect = (query: object) => mod.collectUsage(dir, query);
	// 每组比 requests,input,output,tokens,cost
	const totals = (t: any) => t && [t.requests, t.input, t.output, t.tokens, Number(t.cost.toFixed(4))].join(",");
	const groups = (r: any) => Object.fromEntries([...r.groups.entries()].map(([k, v]: [string, unknown]) => [k, totals(v)]));
	const eq = (a: object, b: object) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

	check("collect:按模型、左闭右开", () => {
		const r = collect({ from: FROM, to: TO, groupBy: "model" });
		return r.scanned === 2 && r.matched === 1 && totals(r.overall) === "3,72,11,1050,0.72" && eq(groups(r), { "p/m1": "2,30,3,33,0.3", "p/m2": "1,30,3,1000,0.3", "tools/summaries": "0,12,5,17,0.12" });
	});
	check("collect:按天、本地日期", () => eq(groups(collect({ from: FROM, to: TO, groupBy: "day" })), { "2026-03-01": "1,15,6,21,0.15", "2026-03-02": "2,57,5,1029,0.57" }));
	check("collect:无起点、无时间戳归unknown", () => {
		const r = collect({ to: TO, groupBy: "day" });
		return r.matched === 2 && eq(groups(r), { unknown: "1,60,6,66,0.6", "2026-02-28": "2,51,6,57,1.5", "2026-03-01": "1,15,6,21,0.15", "2026-03-02": "2,57,5,1029,0.57" });
	});
}

async function cacheHitRate(check: Check): Promise<void> {
	const { cacheHitRate: f } = await load("session/stats.ts");
	const totals = (input: number, cacheRead: number) => ({ requests: 1, input, output: 0, cacheRead, cacheWrite: 0, tokens: input + cacheRead, cost: 0 });
	check("cache:25%", () => f(totals(75, 25)) === 0.25);
	check("cache:全命中", () => f(totals(0, 10)) === 1);
	check("cache:零命中", () => f(totals(10, 0)) === 0);
	check("cache:分母0", () => f(totals(0, 0)) === undefined);
}

async function bytes(check: Check): Promise<void> {
	const { formatBytes: f } = await load("bytes.ts");
	const GB = 1024 ** 3;
	const cases: Array<[number, string]> = [[0, "0B"], [1023, "1023B"], [1024, "1KB"], [1100, "1.1KB"], [1536, "1.5KB"], [10240, "10KB"], [1048576, "1MB"], [1.5 * GB, "1.5GB"], [5 * GB, "5GB"], [2048 * GB, "2048GB"], [-1, "?"], [NaN, "?"], [Infinity, "?"]];
	for (const [n, want] of cases) check("bytes:" + want + "←" + n, () => f(n) === want);
}

const SUITES: Record<string, (check: Check) => Promise<void>> = {
	"impl-duration": duration,
	"impl-stats": stats,
	parallel3: async (check) => {
		await duration(check);
		await cacheHitRate(check);
		await bytes(check);
	},
};
const cases: Array<[string, () => unknown]> = [];
await SUITES[task]!((name, run) => cases.push([name, run]));
const failed = cases.filter(([, run]) => {
	try {
		return run() !== true;
	} catch {
		return true;
	}
}).map(([name]) => name);
console.log("\n" + JSON.stringify({ total: cases.length, failed }));
