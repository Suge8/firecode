import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

const theme = { fg: (_color: string, text: string) => text };
const NOW = 1_000_000;

type Spec = { name: string; status?: string; disposition?: string; tool?: string; args?: unknown; review?: [number, number, number]; started?: number; settled?: [number, "done" | "failed"] };

function facts(specs: Spec[]) {
	const workers = specs.map((spec) => ({
		name: spec.name, role: "工程师", status: spec.status ?? "working", sessionPath: `/s/${spec.name}`, cwd: "/p",
		...(spec.disposition ? { disposition: spec.disposition } : {}),
	}));
	const byPath = <T>(pick: (spec: Spec) => T | undefined) =>
		new Map(specs.flatMap((spec) => { const value = pick(spec); return value === undefined ? [] : [[`/s/${spec.name}`, value] as const]; }));
	return {
		workers,
		currentTools: new Map(specs.flatMap((spec) => spec.tool ? [[`/s/${spec.name}`, new Map([["1", { tool: spec.tool, args: spec.args, startedAt: NOW }]])] as const] : [])),
		reviewProgress: byPath((spec) => spec.review && { kind: "review" as const, round: spec.review[0], settled: spec.review[1], total: spec.review[2] }),
		runStartedAt: byPath((spec) => spec.started),
		settled: byPath((spec) => spec.settled && { at: spec.settled[0], kind: spec.settled[1] }),
	};
}

async function lines(specs: Spec[], width = 72) {
	const { activityLines } = await loadFirecodeModule("master/activity-list.ts") as any;
	const out = activityLines(facts(specs), NOW, width, theme);
	return { text: out.lines.map((line: string) => stripVTControlCharacters(line)) as string[], animating: out.animating as boolean };
}

test("上榜规则：运行、审查、待发落显示，已发落/已 ack 的空闲不显示，无子代理 0 行", async () => {
	expect((await lines([])).text).toEqual([]);
	const { text } = await lines([
		{ name: "a", tool: "read", args: { path: "/p/src/a.ts" }, started: NOW - 12_000 },
		{ name: "c", status: "reviewing", review: [2, 1, 3], started: NOW - 5_000 },
		{ name: "d", status: "idle", disposition: "pending", started: NOW - 60_000, settled: [NOW - 30_000, "done"] },
		{ name: "e", status: "idle", disposition: "pending", started: NOW - 20_000, settled: [NOW - 5_000, "failed"] },
		{ name: "f", status: "idle" },
	]);
	expect(text.length).toBe(4);
	expect(text[0]).toMatch(/^ {2}\S a {2}工程师 · 读取 \.\/src\/a\.ts\s+12s $/u);
	expect(text[1]).toMatch(/c .*审查第 2 轮 · 1\/3 通过\s+5\.0s $/u);
	expect(text[2]).toMatch(/✓ d .*已返回，待发落\s+30s $/u);
	expect(text[3]).toMatch(/✗ e .*失败\s+15s $/u);
	expect((await lines([{ name: "b" }])).text[0]).toContain("思考中");
});

test("超过 4 行：待发落先留、其次审查、最后运行；保留行按启动顺序；末行 +N", async () => {
	const { text } = await lines([
		{ name: "r1" }, { name: "v1", status: "reviewing" },
		{ name: "d1", status: "idle", disposition: "pending", settled: [NOW, "done"] },
		{ name: "r2" }, { name: "v2", status: "reviewing" },
		{ name: "d2", status: "idle", disposition: "pending", settled: [NOW, "failed"] },
	]);
	const names = text.slice(0, 3).map((line) => line.match(/ ([a-z]\d) /u)![1]);
	expect(names).toEqual(["v1", "d1", "d2"]);
	expect(text.length).toBe(4);
	expect(text.at(-1)).toBe("    … +3 个");
});

test("动效：有行在动才要求时钟，全部静止则不要", async () => {
	expect((await lines([{ name: "a" }])).animating).toBe(true);
	expect((await lines([{ name: "a", status: "idle", disposition: "pending", settled: [NOW - 500, "done"] }])).animating).toBe(true);
	expect((await lines([{ name: "a", status: "idle", disposition: "pending", settled: [NOW - 5_000, "done"] }])).animating).toBe(false);
	expect((await lines([])).animating).toBe(false);
});

test("列表组件只在有动效时订阅时钟，静止后不再触发重绘", async () => {
	const { ActivityList } = await loadFirecodeModule("master/activity-list.ts") as any;
	let renders = 0;
	let current = facts([{ name: "a" }]);
	const list = new ActivityList({ requestRender: () => renders++ }, theme, () => current);
	list.sync();
	await Bun.sleep(250);
	expect(renders).toBeGreaterThan(0);
	current = facts([{ name: "a", status: "idle", disposition: "pending", settled: [Date.now() - 60_000, "done"] }]);
	list.sync();
	const settledAt = renders;
	await Bun.sleep(250);
	expect(renders).toBe(settledAt);
	list.dispose();
});

test("当前动作与工具行同一套动作词 + 目标，不显示工具原名", async () => {
	const { text } = await lines([
		{ name: "e", tool: "edit", args: { path: "/p/tools/line.ts" } },
		{ name: "b", tool: "bash", args: { command: "bun test" } },
		{ name: "w", tool: "write", args: { file_path: "/p/x.md", content: "a\nb" } },
	]);
	expect(text[0]).toContain("工程师 · 修改 ./tools/line.ts");
	expect(text[1]).toContain("工程师 · 操作 $ bun test");
	expect(text[2]).toContain("工程师 · 写入 ./x.md");
	expect(text.join("")).not.toMatch(/\b(edit|bash|write)\b/u);
});
