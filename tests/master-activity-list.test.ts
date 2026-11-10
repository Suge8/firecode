import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { loadFirecodeModule } from "./loader.ts";
import { until } from "./until.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
const NOW = 1_000_000_000;
const MINUTE = 60_000;
/** 用例里的卡住时限（生产默认见 timing.ts）。 */
const STALL_MS = 5 * MINUTE;

type Spec = {
	name: string;
	status?: string;
	tool?: string;
	args?: unknown;
	review?: [number, number, number];
	started?: number;
	output?: number;
	settled?: [number, "done" | "failed" | "interrupted", string?];
};

function facts(specs: Spec[]) {
	return {
		workers: specs.map((spec) => ({
			worker: { name: spec.name, role: "工程师", status: spec.status ?? "working", sessionPath: `/s/${spec.name}`, cwd: "/p" },
			tool: spec.tool ? { tool: spec.tool, args: spec.args } : undefined,
			review: spec.review && { kind: "review" as const, round: spec.review[0], settled: spec.review[1], total: spec.review[2] },
			startedAt: spec.started ?? (spec.status === "idle" ? undefined : NOW - 10_000),
			quietSince: spec.output,
			settled: spec.settled && { at: spec.settled[0], kind: spec.settled[1], ...(spec.settled[2] ? { note: spec.settled[2] } : {}) },
		})),
		stallMs: STALL_MS,
	};
}

async function list(specs: Spec[] | (() => Spec[]), options: { limit?: number; now?: number } = {}) {
	const { ActivityList } = await loadFirecodeModule("master/activity-list.ts") as any;
	let renders = 0;
	const opened: string[] = [];
	const component = new ActivityList(
		{ requestRender: () => renders++ },
		theme,
		() => facts(typeof specs === "function" ? specs() : specs),
		() => options.limit ?? 4,
		(name: string) => opened.push(name),
	);
	const realNow = Date.now;
	const at = <T>(fn: () => T) => {
		if (options.now === undefined) return fn();
		Date.now = () => options.now!;
		try { return fn(); } finally { Date.now = realNow; }
	};
	return {
		component,
		opened,
		get renders() { return renders; },
		text: (width = 72): string[] => at(() => component.render(width)).map((line: string) => stripVTControlCharacters(line)),
		click: (y: number, width = 72) => at(() => component.handleMouse({
			type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width, height: 20, shift: false, alt: false, ctrl: false,
		})),
	};
}

/** 子代理行取名字；折叠行取“标记 计数”（后面的名字预览不算）。 */
const names = (lines: string[]) => lines.map((line) => line.match(/^ {2}\S ([a-z][a-z0-9-]*) /u)?.[1]
	?? line.match(/^ {2}(\S) +(\+\d+ 个在跑|\d+ 个已完成|\d+ 个空闲|收起)/u)?.slice(1).join(" ") ?? line.trim());
const done = (name: string, agoMs = 2 * MINUTE): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "done"] });
const interrupted = (name: string, agoMs = 2 * MINUTE): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "interrupted"] });
const failed = (name: string, agoMs = 2 * MINUTE, note?: string): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "failed", note] });

test("分组与顺序：失败、卡住置顶，然后在跑与审查，最后一行合计已完成", async () => {
	const view = await list([
		{ name: "run-a", tool: "read", args: { path: "/p/src/a.ts" }, output: NOW - 1_000 },
		done("done-a", MINUTE),
		{ name: "rev-a", status: "reviewing", review: [2, 1, 3], output: NOW - 1_000 },
		{ name: "stuck-a", started: NOW - 7 * MINUTE, output: NOW - 6 * MINUTE },
		failed("fail-a"),
		done("done-b", MINUTE),
		{ name: "reloaded", status: "idle" },
	], { limit: 10, now: NOW });
	const text = view.text();
	expect(names(text)).toEqual(["fail-a", "stuck-a", "run-a", "rev-a", "✓ 2 个已完成", "· 1 个空闲"]);
	expect(text[0]).toMatch(/✗ fail-a .*失败/u);
	expect(text[1]).toContain("思考中 · 6 分钟无输出");
	expect(text[2]).toMatch(/run-a .*读取 \.\/src\/a\.ts/u);
	expect(text[3]).toContain("审查第 2 轮 · 1/3 通过");
});

test("被中断不是失败：不画 ✗、写“被中断”，与失败、卡住同在置顶那一组（失败在前）", async () => {
	const view = await list([
		{ name: "run-a", output: NOW - 1_000 },
		{ name: "stuck-a", started: NOW - 9 * MINUTE },
		interrupted("halt"),
		failed("fail-a"),
	], { now: NOW });
	const text = view.text(160);
	expect(names(text)).toEqual(["fail-a", "halt", "stuck-a", "run-a"]);
	expect(text[1]).toContain("被中断");
	expect(text[1]).not.toContain("✗");
});

test("卡住：working 到卡住时限没有任何输出时保留动作文字，追加“· N 分钟无输出”；有输出立即恢复", async () => {
	const silentSince = NOW - 5 * MINUTE;
	const stuck = await list([{ name: "slow", started: silentSince - MINUTE, output: silentSince, tool: "bash", args: { command: "sleep 330" } }], { now: NOW });
	expect(stuck.text(160)[0]).toContain("操作 $ sleep 330 · 5 分钟无输出");

	// 从没有输出时按本次运行起点算。
	const never = await list([{ name: "slow", started: NOW - 6 * MINUTE }], { now: NOW });
	expect(never.text()[0]).toContain("思考中 · 6 分钟无输出");

	const recovered = await list([{ name: "slow", started: silentSince - MINUTE, output: NOW - 1_000, tool: "bash", args: { command: "bun test" } }], { now: NOW });
	expect(recovered.text()[0]).toContain("操作 $ bun test");
	expect(recovered.text()[0]).not.toContain("无输出");
	const fresh = await list([{ name: "fast", started: NOW - 4 * MINUTE }], { now: NOW });
	expect(fresh.text()[0]).toContain("思考中");
});

test("行数上限只约束在跑的行：失败与卡住永远可见，超出折成“+N 个在跑”", async () => {
	const running = Array.from({ length: 6 }, (_, index) => ({ name: `run-${index}`, output: NOW - 1_000 }));
	const view = await list([
		...running,
		failed("fail-a"),
		failed("fail-b"),
		{ name: "stuck-a", started: NOW - 9 * MINUTE },
		done("done-a"),
	], { limit: 4, now: NOW });
	expect(names(view.text())).toEqual([
		"fail-a", "fail-b", "stuck-a", "run-0", "run-1", "run-2", "· +3 个在跑", "✓ 1 个已完成",
	]);
});

test("点击“+N 个在跑”展开全部、再点收起；点子代理行打开它的全过程视图", async () => {
	const running = Array.from({ length: 6 }, (_, index) => ({ name: `run-${index}`, output: NOW - 1_000 }));
	const view = await list(running, { limit: 4, now: NOW });
	const rowOf = (label: string) => view.text().findIndex((line) => line.includes(label));

	expect(view.click(rowOf("+3 个在跑"))).toMatchObject({ handled: true });
	expect(names(view.text()).filter((line) => line.startsWith("run-"))).toHaveLength(6);
	expect(rowOf("+3 个在跑")).toBe(-1);
	view.click(rowOf("收起"));
	expect(names(view.text())).toEqual(["run-0", "run-1", "run-2", "· +3 个在跑"]);

	expect(view.click(0)).toMatchObject({ handled: true });
	expect(view.opened).toEqual(["run-0"]);
});

test("任意宽度下每行不超宽；宽屏动作文字按行宽显示，不先硬截 40 列", async () => {
	const longCommand = "bun test tests/master-activity-list.test.ts tests/master-integration.test.ts";
	const rows: Spec[] = [
		{ name: "fix-auth", tool: "bash", args: { command: longCommand }, output: NOW - 1_000, started: NOW - 72_000 },
		{ name: "scan", tool: "read", args: { path: "/p/a.ts" }, output: NOW - 1_000 },
	];
	expect((await list(rows, { now: NOW })).text(140)[0]).toContain(`操作 $ ${longCommand}`);
	for (const width of [140, 72, 48, 36])
		for (const line of (await list(rows, { now: NOW })).text(width)) expect(line.length).toBeLessThanOrEqual(width);
});

test("动画时钟只在有行在动时订阅：只剩失败行与已完成合计时静止不重绘", async () => {
	let specs: Spec[] = [{ name: "a", output: Date.now() }];
	const view = await list(() => specs);
	view.component.sync();
	await until(() => view.renders > 1);
	specs = [failed("a", 5_000), done("b", 5_000)].map((spec) => ({ ...spec, settled: [Date.now() - 5_000, spec.settled![1]] as Spec["settled"] }));
	view.component.sync();
	const settled = view.renders;
	await Bun.sleep(250);
	expect(view.renders).toBe(settled);
	view.component.dispose();
});
