#!/usr/bin/env bun
// 汇总 run.ts 的结果：每次运行一行，再按（任务，变体）出均值与范围。
//   bun summary.ts [变体,变体…] [--tasks t3-research,t7-audit]
// 主/Worker 花费取各自会话记录里的 usage；“期间工具调用”= 指挥官第一次 start 之后到第一个结果送达之前自己调的工具次数（派出后有没有自己重做）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { entryCost, jsonlFiles, parseList, readJsonl, WORK } from "./lib.ts";

interface Row {
	variant: string;
	task: string;
	run: number;
	status: string;
	wall: number;
	firstEnd: number;
	workers: number[];
	roles: string[];
	mainCost: number;
	workerCost: number;
	during: number | undefined;
}

const ROLE = /role\s*:\s*["']([^"']+)["']/g;
const START = /action\s*:\s*["']start["']/;

function startsOf(main: any[]): { at: number; roles: string[] }[] {
	return main.flatMap((e) => {
		if (e.message?.role !== "assistant") return [];
		return e.message.content.flatMap((c: any) => {
			if (c.type !== "toolCall") return [];
			const at = Date.parse(e.timestamp);
			if (c.name === "subagents" && c.arguments.action === "start") return [{ at, roles: [c.arguments.role] }];
			const code: string = c.name === "codemode" ? c.arguments.code ?? "" : "";
			return START.test(code) ? [{ at, roles: [...code.matchAll(ROLE)].map((m) => m[1]!) }] : [];
		});
	});
}

function analyze(dir: string): Row {
	const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
	const main = readJsonl(result.sessionFile);
	const workerLogs = jsonlFiles(join(dir, "sessions", "subagents")).map(readJsonl);
	const starts = startsOf(main);
	const firstStart = starts[0]?.at;
	const firstEvent = main.find((e) => e.customType === "firecode-master-pending-event");
	const eventAt = firstEvent ? Date.parse(firstEvent.timestamp) : Infinity;
	const calls = main.filter((e) => e.message?.role === "assistant").flatMap((e) => e.message.content.filter((c: any) => c.type === "toolCall").map(() => Date.parse(e.timestamp)));
	return {
		variant: result.variant, task: result.task, run: result.run, status: result.status,
		wall: result.wallSec, firstEnd: result.agentEndsSec[0] ?? result.wallSec,
		workers: workerLogs.map((log) => log.filter((e) => e.customType === "firecode-round").reduce((sum, e) => sum + e.data.elapsed / 1000, 0)),
		roles: [...new Set(starts.flatMap((s) => s.roles))],
		mainCost: entryCost(main), workerCost: workerLogs.reduce((sum, log) => sum + entryCost(log), 0),
		during: firstStart === undefined ? undefined : calls.filter((t) => t > firstStart && t < eventAt).length,
	};
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const range = (xs: number[], digits = 0) => `${mean(xs).toFixed(digits)}［${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}］`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tasks: { type: "string" } } });
const runsRoot = join(WORK, "runs");
const variants = parseList(positionals[0]) ?? (existsSync(runsRoot) ? readdirSync(runsRoot) : []);
const wanted = parseList(values.tasks);
const rows: Row[] = variants
	.flatMap((v) => (existsSync(join(runsRoot, v)) ? readdirSync(join(runsRoot, v)).map((d) => join(runsRoot, v, d)) : []))
	.filter((dir) => existsSync(join(dir, "result.json")))
	.map(analyze)
	.filter((r) => !wanted || wanted.includes(r.task))
	.sort((a, b) => a.task.localeCompare(b.task) || a.variant.localeCompare(b.variant) || a.run - b.run);

console.log("| 任务 | 变体 | # | 状态 | 墙钟 s | 首回合归还 s | Worker 数（各自运行 s） | 角色 | 总花费 $（主 / Worker） | 期间工具调用 |\n|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
	const total = r.mainCost + r.workerCost;
	console.log(`| ${r.task} | ${r.variant} | ${r.run} | ${r.status} | ${r.wall.toFixed(0)} | ${r.firstEnd.toFixed(0)} | ${r.workers.length}${r.workers.length ? `（${r.workers.map((w) => w.toFixed(0)).join(" / ")}）` : ""} | ${r.roles.join("/") || "—"} | ${total.toFixed(2)}（${r.mainCost.toFixed(2)} / ${r.workerCost.toFixed(2)}） | ${r.during ?? "—"} |`);
}

console.log("\n| 任务 | 变体 | n | 墙钟 s 均值［范围］ | 总花费 $ 均值［范围］ | 每次派出数 |\n|---|---|---|---|---|---|");
const keys = [...new Set(rows.map((r) => `${r.task}\t${r.variant}`))];
for (const key of keys) {
	const [task, variant] = key.split("\t");
	const group = rows.filter((r) => r.task === task && r.variant === variant && r.status === "settled");
	if (!group.length) continue;
	console.log(`| ${task} | ${variant} | ${group.length} | ${range(group.map((r) => r.wall))} | ${range(group.map((r) => r.mainCost + r.workerCost), 2)} | ${group.map((r) => r.workers.length).join("、")} |`);
}
console.log("\n只统计 status=settled 的运行；stopped/timeout/exited 的数字是截断值。");
