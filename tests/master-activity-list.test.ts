import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

const theme = { fg: (_color: string, text: string) => text };
const NOW = 1_000_000;

type Spec = { name: string; launch?: number; status?: string; tool?: string; args?: unknown; review?: [number, number, number]; started?: number; settled?: [number, "done" | "failed"] };

function facts(specs: Spec[]) {
	const workers = specs.map((spec) => ({
		name: spec.name, role: "工程师", status: spec.status ?? "working", sessionPath: `/s/${spec.name}`, cwd: "/p",
	}));
	const byPath = <T>(pick: (spec: Spec) => T | undefined) =>
		new Map(specs.flatMap((spec) => { const value = pick(spec); return value === undefined ? [] : [[`/s/${spec.name}`, value] as const]; }));
	return {
		workers,
		launchOrder: new Map(specs.map((spec, index) => [spec.name, spec.launch ?? index] as const)),
		currentTools: new Map(specs.flatMap((spec) => spec.tool ? [[`/s/${spec.name}`, new Map([["1", { tool: spec.tool, args: spec.args, startedAt: NOW }]])] as const] : [])),
		reviewProgress: byPath((spec) => spec.review && { kind: "review" as const, round: spec.review[0], settled: spec.review[1], total: spec.review[2] }),
		runStartedAt: byPath((spec) => spec.started),
		settled: byPath((spec) => spec.settled && { at: spec.settled[0], kind: spec.settled[1] }),
	};
}

async function lines(specs: Spec[], width = 72, limit = 4) {
	const { activityLines } = await loadFirecodeModule("master/activity-list.ts") as any;
	const out = activityLines(facts(specs), NOW, width, theme, limit);
	return { text: out.lines.map((line: string) => stripVTControlCharacters(line)) as string[], animating: out.animating as boolean };
}

const idle = (name: string, kind: "done" | "failed", agoMs: number): Spec =>
	({ name, status: "idle", started: NOW - 60_000, settled: [NOW - agoMs, kind] });

test("上榜规则：只列运行与审查，落定行 ✓ 停 10 秒、✗ 停 30 秒，之后移除；无落定事实的空闲子代理不列", async () => {
	expect((await lines([])).text).toEqual([]);
	const { text } = await lines([
		{ name: "a", tool: "read", args: { path: "/p/src/a.ts" }, started: NOW - 12_000 },
		{ name: "c", status: "reviewing", review: [2, 1, 3], started: NOW - 5_000 },
		idle("d", "done", 9_000),
		idle("e", "failed", 29_000),
		idle("gone-ok", "done", 11_000),
		idle("gone-fail", "failed", 31_000),
		{ name: "reloaded", status: "idle" },
	], 72, 10);
	expect(text.length).toBe(4);
	expect(text[0]).toMatch(/^ {2}\S a {2}工程师 · 读取 \.\/src\/a\.ts\s+12s $/u);
	expect(text[1]).toMatch(/c .*审查第 2 轮 · 1\/3 通过\s+5\.0s $/u);
	expect(text[2]).toMatch(/✓ d .*已返回\s+51s $/u);
	expect(text[3]).toMatch(/✗ e .*失败\s+31s $/u);
	expect((await lines([{ name: "b" }])).text[0]).toContain("思考中");
});

test("行一律按启动顺序；超过上限时末行 +N；上限随终端高度，全局展开显示全部", async () => {
	const specs: Spec[] = [
		{ name: "r1" }, { name: "v1", status: "reviewing" }, idle("d1", "done", 1_000),
		{ name: "r2" }, { name: "v2", status: "reviewing" }, idle("d2", "failed", 1_000),
	];
	const names = (text: string[]) => text.map((line) => line.match(/ ([a-z]\d) /u)?.[1]);
	const capped = (await lines(specs, 72, 4)).text;
	expect(names(capped)).toEqual(["r1", "v1", "d1", undefined]);
	expect(capped.at(-1)).toBe("    … +3 个");
	expect(names((await lines(specs, 72, Infinity)).text)).toEqual(["r1", "v1", "d1", "r2", "v2", "d2"]);

	const { visibleRows } = await loadFirecodeModule("master/activity-list.ts") as any;
	expect(visibleRows(undefined, false)).toBe(4);
	expect(visibleRows(20, false)).toBe(4);
	expect(visibleRows(60, false)).toBe(10);
	expect(visibleRows(60, true)).toBe(Infinity);
});

test("行序以启动序为准：并发 start 入池顺序不同、落定或状态变化后都不跳", async () => {
	// 池里的数组顺序是 b、a、c（并发 start 越过 await 的先后），启动序是 a、b、c。
	const pool = (a: Spec): Spec[] => [{ name: "b", launch: 2 }, a, { name: "c", launch: 3 }];
	const names = async (specs: Spec[]) => (await lines(specs, 72, 10)).text.map((line) => line.match(/ (a|b|c) /u)?.[1]);
	expect(await names(pool({ name: "a", launch: 1 }))).toEqual(["a", "b", "c"]);
	expect(await names(pool({ name: "a", launch: 1, status: "reviewing" }))).toEqual(["a", "b", "c"]);
	expect(await names(pool({ ...idle("a", "done", 1_000), launch: 1 }))).toEqual(["a", "b", "c"]);
	expect((await lines(pool({ name: "a", launch: 1 }), 72, 2)).text.map((line) => line.match(/ (a|b|c) /u)?.[1])).toEqual(["a", undefined]);
});

test("动效：有行在动才要求时钟，全部静止则不要", async () => {
	expect((await lines([{ name: "a" }])).animating).toBe(true);
	expect((await lines([idle("a", "done", 500)])).animating).toBe(true);
	expect((await lines([idle("a", "done", 5_000)])).animating).toBe(false);
	expect((await lines([])).animating).toBe(false);
});

test("列表组件静止后不再重绘，落定行到期自动移除", async () => {
	const { ActivityList } = await loadFirecodeModule("master/activity-list.ts") as any;
	let renders = 0;
	let current = facts([{ name: "a" }]);
	const list = new ActivityList({ requestRender: () => renders++ }, theme, () => current, () => 4);
	list.sync();
	await Bun.sleep(250);
	expect(renders).toBeGreaterThan(0);
	current = facts([{ name: "a", status: "idle", settled: [Date.now() - 9_800, "done"] }]);
	list.sync();
	const afterSync = renders;
	expect(list.render(72).length).toBe(1);
	await Bun.sleep(150);
	expect(renders).toBe(afterSync);
	await Bun.sleep(400);
	expect(renders).toBe(afterSync + 1);
	expect(list.render(72)).toEqual([]);
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

test("窄屏先截短动作（保留开头带 …），放不下再丢角色；审查行同规则", async () => {
	const long: Spec = { name: "fix-auth", tool: "bash", args: { command: "bun test tests/master-activity-list.test.ts" }, started: NOW - 72_000 };
	const review: Spec = { name: "repo-scan", status: "reviewing", review: [2, 1, 3], started: NOW - 130_000 };
	for (const width of [72, 56, 40]) {
		for (const [spec, head] of [[long, "操作 $"], [review, "审查"]] as const) {
			const [line] = (await lines([spec], width)).text;
			expect(line.length).toBeLessThanOrEqual(width);
			if (width <= 40 || (spec === long && width <= 56)) expect(line).toMatch(/工程师 · .*…/u);
			expect(line).toContain(head);
		}
	}
	const narrow = (await lines([long], 30)).text[0];
	expect(narrow).not.toContain("工程师");
	expect(narrow).toMatch(/操作.*…/u);
	expect(narrow).toContain("1m12s");
});
