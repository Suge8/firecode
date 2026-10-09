import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { loadFirecodeModule } from "./loader.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
/** 着色主题：把语义色写成可见标签，断言“黄色”“红色”这类语义而不是 ANSI。 */
const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bg: (color: string, text: string) => `{${color}}${text}{/${color}}` };
const NOW = 1_000_000_000;
const MINUTE = 60_000;

type Spec = {
	name: string;
	/** 档案里的启动序；省略时按列出顺序。 */
	launch?: number;
	status?: string;
	tool?: string;
	args?: unknown;
	review?: [number, number, number];
	started?: number;
	output?: number;
	settled?: [number, "done" | "failed" | "interrupted", string?];
};

function facts(specs: Spec[]) {
	const workers = specs.map((spec, index) => ({
		name: spec.name, role: "工程师", status: spec.status ?? "working", sessionPath: `/s/${spec.name}`, cwd: "/p", launch: spec.launch ?? index,
	}));
	const byPath = <T>(pick: (spec: Spec) => T | undefined) =>
		new Map(specs.flatMap((spec) => { const value = pick(spec); return value === undefined ? [] : [[`/s/${spec.name}`, value] as const]; }));
	return {
		workers,
		currentTools: new Map(specs.flatMap((spec) => spec.tool ? [[`/s/${spec.name}`, new Map([["1", { tool: spec.tool, args: spec.args, startedAt: NOW }]])] as const] : [])),
		reviewProgress: byPath((spec) => spec.review && { kind: "review" as const, round: spec.review[0], settled: spec.review[1], total: spec.review[2] }),
		runStartedAt: byPath((spec) => spec.started ?? (spec.status === "idle" ? undefined : NOW - 10_000)),
		lastOutputAt: byPath((spec) => spec.output),
		settled: byPath((spec) => spec.settled && { at: spec.settled[0], kind: spec.settled[1], ...(spec.settled[2] ? { note: spec.settled[2] } : {}) }),
	};
}

async function list(specs: Spec[] | (() => Spec[]), options: { limit?: number; paint?: typeof theme; now?: number } = {}) {
	const { ActivityList } = await loadFirecodeModule("master/activity-list.ts") as any;
	let renders = 0;
	const opened: string[] = [];
	const component = new ActivityList(
		{ requestRender: () => renders++ },
		options.paint ?? theme,
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
		raw: (width = 72): string[] => at(() => component.render(width)),
		click: (y: number, width = 72) => at(() => component.handleMouse({
			type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width, height: 20, shift: false, alt: false, ctrl: false,
		})),
	};
}

/** 子代理行取名字；折叠行取“标记 计数”（后面的名字预览不算）。 */
const names = (lines: string[]) => lines.map((line) => line.match(/^ {2}\S ([a-z][a-z0-9-]*) /u)?.[1]
	?? line.match(/^ {2}(\S) +(\+\d+ 个在跑|\d+ 个已完成|\d+ 个空闲|收起)/u)?.slice(1).join(" ") ?? line.trim());
const done = (name: string, agoMs = 2 * MINUTE, note?: string): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "done", note] });
const interrupted = (name: string, agoMs = 2 * MINUTE): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "interrupted"] });
const failed = (name: string, agoMs = 2 * MINUTE, note?: string): Spec =>
	({ name, status: "idle", started: NOW - agoMs - 30_000, settled: [NOW - agoMs, "failed", note] });

test("分组与顺序：失败、卡住置顶，然后在跑与审查，最后一行合计已完成", async () => {
	const view = await list([
		{ name: "run-a", launch: 1, tool: "read", args: { path: "/p/src/a.ts" }, output: NOW - 1_000 },
		done("done-a", MINUTE),
		{ name: "rev-a", launch: 3, status: "reviewing", review: [2, 1, 3], output: NOW - 1_000 },
		{ name: "stuck-a", launch: 4, started: NOW - 7 * MINUTE, output: NOW - 6 * MINUTE },
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

test("失败行与已完成合计不随时间消失：一小时后仍在", async () => {
	const later = await list([failed("fail-a", 60 * MINUTE), interrupted("halt", 60 * MINUTE), done("done-a", 60 * MINUTE)], { now: NOW });
	expect(names(later.text())).toEqual(["fail-a", "halt", "✓ 1 个已完成"]);
});

test("被中断不是失败：静态黄色标记、不画 ✗，与失败、卡住同在置顶那一组（失败在前）", async () => {
	const specs: Spec[] = [
		{ name: "run-a", output: NOW - 1_000 },
		{ name: "stuck-a", started: NOW - 9 * MINUTE },
		interrupted("halt"),
		failed("fail-a"),
	];
	const view = await list(specs, { paint: tagged, now: NOW });
	const raw = view.raw(160);
	expect(names(raw.map((line) => stripVTControlCharacters(line).replace(/<\/?[a-z]+>/gu, "")))).toEqual(["fail-a", "halt", "stuck-a", "run-a"]);
	const halt = raw[1];
	expect(halt).toMatch(/^ {2}<warning>[^✗<]<\/warning> /u);
	expect(halt).toContain("<warning>被中断</warning>");
	expect(halt).not.toContain("✗");
	const later = await list(specs, { paint: tagged, now: NOW + 1_234 });
	expect(later.raw(160)[1].slice(0, 22)).toBe(halt.slice(0, 22));
});

test("卡住：working 五分钟没有任何输出时保留动作文字，追加黄色“· N 分钟无输出”，字形静止；有输出立即恢复", async () => {
	const silentSince = NOW - 5 * MINUTE;
	const stuck = await list([{ name: "slow", started: silentSince - MINUTE, output: silentSince, tool: "bash", args: { command: "sleep 330" } }], { paint: tagged, now: NOW });
	const [line] = stuck.raw(160);
	const plain = stripVTControlCharacters(line).replace(/<\/?[a-z]+>/gu, "");
	expect(plain).toContain("操作 $ sleep 330 · 5 分钟无输出");
	expect(line).toMatch(/^ {2}<warning>\S<\/warning> /u);
	expect(line).toContain("<warning> · 5 分钟无输出</warning>");
	const later = await list([{ name: "slow", started: silentSince - MINUTE, output: silentSince, tool: "bash", args: { command: "sleep 330" } }], { paint: tagged, now: NOW + 1_234 });
	expect(later.raw(160)[0].slice(0, 22)).toBe(line.slice(0, 22));

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

test("点击“+N 个在跑”展开全部、再点收起；点“✓ N 个已完成”列出名字与本次运行耗时、再点收起", async () => {
	const running = Array.from({ length: 6 }, (_, index) => ({ name: `run-${index}`, output: NOW - 1_000 }));
	const view = await list([...running, done("done-a", 2 * MINUTE, "刷新改为单飞。"), done("done-b")], { limit: 4, now: NOW });
	const rowOf = (label: string) => view.text().findIndex((line) => line.includes(label));

	expect(view.click(rowOf("+3 个在跑"))).toMatchObject({ handled: true });
	expect(names(view.text()).filter((line) => line.startsWith("run-"))).toHaveLength(6);
	expect(rowOf("+3 个在跑")).toBe(-1);
	view.click(rowOf("收起"));
	expect(names(view.text())).toEqual(["run-0", "run-1", "run-2", "· +3 个在跑", "✓ 2 个已完成"]);

	view.click(rowOf("2 个已完成"));
	const opened = view.text();
	const doneRows = opened.slice(rowOf("2 个已完成") + 1);
	expect(doneRows.map((line) => line.match(/(done-[ab])/u)?.[1])).toEqual(["done-a", "done-b"]);
	for (const line of doneRows) expect(line).toMatch(/30s $/u);
	// 展开行是结果首句，不是千篇一律的“已返回”；没有结果文字时才退回“已返回”。
	expect(doneRows[0]).toContain("刷新改为单飞。");
	expect(doneRows[1]).toContain("已返回");
	view.click(rowOf("2 个已完成"));
	expect(names(view.text()).at(-1)).toBe("✓ 2 个已完成");
	expect(view.text().some((line) => /^ {2}\S done-a /u.test(line))).toBe(false);

	// 子代理行（含展开后的已完成行）点击打开它的全过程视图。
	expect(view.click(0)).toMatchObject({ handled: true });
	expect(view.opened).toEqual(["run-0"]);
});

test("空闲子代理合成“N 个空闲”：与“✓ N 个已完成”同样排版（标记字形、缩进），展开行不重复“空闲”，按档案里的启动序", async () => {
	const view = await list([
		{ name: "run-a", output: NOW - 1_000 },
		{ name: "p6", status: "idle", launch: 6 },
		{ name: "p1", status: "idle", launch: 1 },
		{ name: "p3", status: "idle", launch: 3 },
	], { now: NOW });
	const rowOf = (label: string) => view.text().findIndex((line) => line.includes(label));
	expect(view.text()[1]).toMatch(/^ {2}\S {2}3 个空闲 +p1 · p3 · p6$/u);
	expect(view.click(rowOf("3 个空闲"))).toMatchObject({ handled: true });
	const rows = view.text().slice(rowOf("3 个空闲") + 1);
	expect(rows.map((line) => line.match(/ (p\d) /u)?.[1])).toEqual(["p1", "p3", "p6"]);
	for (const line of rows) expect(line).not.toContain("空闲");
	view.click(rowOf("3 个空闲"));
	expect(view.text()).toHaveLength(2);
});

test("窄屏名字列让位给动作：动作至少留出能认的宽度，名字放不下才截短带 …", async () => {
	const rows: Spec[] = [
		{ name: "fix-auth-refresh-x-long", tool: "bash", args: { command: "sleep 330" }, output: NOW - 1_000 },
		{ name: "lint", tool: "bash", args: { command: "sleep 100" }, output: NOW - 1_000 },
	];
	const text = (await list(rows, { now: NOW })).text(40);
	expect(text[0]).toMatch(/fix-auth-ref.*…/u);
	expect(text[0]).toContain("操作 $ slee");
	expect(text[1]).toContain("操作 $ slee");
	for (const line of text) expect(line.length).toBeLessThanOrEqual(40);
});

test("窄屏整表统一丢角色；宽屏动作文字按行宽显示，不先硬截 40 列", async () => {
	const longCommand = "bun test tests/master-activity-list.test.ts tests/master-integration.test.ts";
	const rows: Spec[] = [
		{ name: "fix-auth", tool: "bash", args: { command: longCommand }, output: NOW - 1_000, started: NOW - 72_000 },
		{ name: "scan", tool: "read", args: { path: "/p/a.ts" }, output: NOW - 1_000 },
	];
	const wide = (await list(rows, { now: NOW })).text(140);
	expect(wide[0]).toContain(`操作 $ ${longCommand}`);
	for (const width of [140, 72, 48, 36]) {
		const text = (await list(rows, { now: NOW })).text(width);
		for (const line of text) expect(line.length).toBeLessThanOrEqual(width);
		const withRole = text.filter((line) => line.includes("工程师")).length;
		expect([0, text.length]).toContain(withRole);
		expect(text[0]).toContain("1m12s");
	}
	const narrow = (await list(rows, { now: NOW })).text(36);
	expect(narrow.some((line) => line.includes("工程师"))).toBe(false);
	expect(narrow[0]).toMatch(/操作.*…/u);
});

test("当前动作与工具行同一套动作词 + 目标，不显示工具原名", async () => {
	const text = (await list([
		{ name: "e", tool: "edit", args: { path: "/p/tools/line.ts" }, output: NOW },
		{ name: "b", tool: "bash", args: { command: "bun test" }, output: NOW },
		{ name: "w", tool: "write", args: { file_path: "/p/x.md", content: "a\nb" }, output: NOW },
	], { now: NOW })).text();
	expect(text[0]).toContain("工程师 · 修改 ./tools/line.ts");
	expect(text[1]).toContain("工程师 · 操作 $ bun test");
	expect(text[2]).toContain("工程师 · 写入 ./x.md");
	expect(text.join("")).not.toMatch(/\b(edit|bash|write)\b/u);
});

test("动画时钟只在有行在动时订阅：只剩失败行与已完成合计时静止不重绘", async () => {
	let specs: Spec[] = [{ name: "a", output: Date.now() }];
	const view = await list(() => specs);
	view.component.sync();
	await Bun.sleep(250);
	expect(view.renders).toBeGreaterThan(1);
	specs = [failed("a", 5_000), done("b", 5_000)].map((spec) => ({ ...spec, settled: [Date.now() - 5_000, spec.settled![1]] as Spec["settled"] }));
	view.component.sync();
	const settled = view.renders;
	await Bun.sleep(250);
	expect(view.renders).toBe(settled);
	view.component.dispose();
});

test("名字列按剩余空间分配：72 列放得下就不截名字", async () => {
	const rows: Spec[] = [
		{ name: "fix-auth-refresh", tool: "bash", args: { command: "sleep 30" }, output: NOW - 1_000 },
		{ name: "e2e-checkout-flow", tool: "bash", args: { command: "sleep 40" }, output: NOW - 1_000 },
	];
	const text = (await list(rows, { now: NOW })).text(72);
	expect(text[0]).toContain("fix-auth-refresh ");
	expect(text[1]).toContain("e2e-checkout-flow ");
	expect(text[1]).toContain("操作 $ sleep 40");
});

test("卡住行右侧不再显示总耗时（避免与“N 分钟无输出”两个时长并排看混）；窄屏动作放不下有效信息时整段丢掉，只留名字与提醒", async () => {
	const stuck: Spec = { name: "slow", started: NOW - 6 * MINUTE, output: NOW - 5 * MINUTE, tool: "bash", args: { command: "sleep 330 && echo slow-done" } };
	const others: Spec[] = [{ name: "repo-scan", tool: "read", args: { path: "/p/master/index.ts" }, output: NOW - 1_000 }];
	const [wide] = (await list([stuck, ...others], { now: NOW })).text(160);
	expect(wide).toContain("操作 $ sleep 330 && echo slow-done · 5 分钟无输出");
	expect(wide).not.toMatch(/6m\s*$/u);
	const [narrow] = (await list([stuck, ...others], { now: NOW })).text(40);
	expect(narrow).toMatch(/^ {2}\S slow\s+5(?: 分钟|m )无输出\s*$/u);
});

/** 胶囊：计数两侧各一格空白，铺工具行同族的中性暗底。 */
const CHIP = (text: string) => `{toolPendingBg}${text}{/toolPendingBg}`;
const chipOf = (line: string) => line.match(/\{toolPendingBg\}(.*?)\{\/toolPendingBg\}/u)?.[1].replace(/<\/?\w+>/gu, "");

test("折叠行的可点提示：计数做成带中性暗底的胶囊（两侧各一格空白），后面暗色列出被折叠的名字；标记沿用（在跑暗色 ·、已完成绿 ✓、空闲暗色 ·），没有下划线、… 与箭头", async () => {
	const running = Array.from({ length: 6 }, (_, index) => ({ name: `run-${index}`, output: NOW - 1_000 }));
	const view = await list([...running, done("types"), done("pen"), { name: "writer", status: "idle" }, { name: "nap", status: "idle" }],
		{ limit: 4, now: NOW, paint: tagged });
	// 着色标签本身占宽度，放宽到不截断。
	const raw = view.raw(300);
	const fold = (count: string) => raw.find((line) => chipOf(line) === ` ${count} `)!;
	expect(fold("+3 个在跑")).toMatch(/^ {2}<dim>·<\/dim> \{toolPendingBg\}/u);
	expect(fold("+3 个在跑")).toContain("<dim>run-3 · run-4 · run-5</dim>");
	expect(fold("2 个已完成")).toContain("<dim>types · pen</dim>");
	expect(fold("2 个空闲")).toMatch(/^ {2}<dim>·<\/dim> \{toolPendingBg\}/u);
	expect(fold("2 个空闲")).toContain("<dim>writer · nap</dim>");
	for (const count of ["+3 个在跑", "2 个已完成", "2 个空闲"]) {
		expect(fold(count)).not.toMatch(/\x1b\[4/u);
		expect(stripVTControlCharacters(fold(count).replace(/<\/?\w+>|\{\/?\w+\}/gu, ""))).not.toMatch(/[…▸▾▶▼›>]/u);
	}
	// 计数后的名字列对齐。
	const text = view.text(300).map((line) => line.replace(/<\/?\w+>|\{\/?\w+\}/gu, ""));
	const column = (needle: string) => {
		const line = text.find((entry) => entry.includes(needle))!;
		return Bun.stringWidth(line.slice(0, line.indexOf(needle)));
	};
	expect(column("run-3")).toBe(column("types"));
	expect(column("types")).toBe(column("writer"));
});

test("胶囊底色用背景关闭序列收尾、不带全量重置：任意宽度截断都不掐断底色，也不漏到后面的名字", async () => {
	const ansi = { fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`, bg: (_color: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m` };
	const view = await list([{ name: "writer", status: "idle" }, { name: "nap", status: "idle" }], { now: NOW, paint: ansi });
	for (const width of [4, 6, 9, 12, 40]) {
		const [line] = view.raw(width);
		expect(line).not.toContain("\x1b[0m");
		const open = line.indexOf("\x1b[48;5;236m");
		expect(open).toBeGreaterThanOrEqual(0);
		expect(line.indexOf("\x1b[49m", open)).toBeGreaterThan(open);
		expect(line.slice(line.indexOf("\x1b[49m", open))).not.toContain("\x1b[48");
	}
});

test("折叠行名字按宽度少列，不在名字中间截断；展开后收起行同样做成胶囊，已展开的分组不再预览名字", async () => {
	const running = Array.from({ length: 8 }, (_, index) => ({ name: `worker-${index}`, output: NOW - 1_000 }));
	const view = await list([...running, done("types")], { limit: 4, now: NOW });
	const plain = (width: number) => view.text(width);
	const line = plain(40).find((entry) => entry.includes("+5 个在跑"))!;
	const listed = line.slice(line.indexOf("worker-")).split(" · ");
	expect(listed.length).toBeGreaterThan(0);
	expect(listed.length).toBeLessThan(5);
	for (const name of listed) expect(name).toMatch(/^worker-[3-7]$/u);
	expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);

	view.click(plain(40).indexOf(line));
	const painted = await list([...running, done("types")], { limit: 4, now: NOW, paint: tagged });
	painted.click(painted.text(300).findIndex((entry) => entry.includes("+5 个在跑")), 300);
	expect(painted.raw(300).some((entry) => chipOf(entry) === " 收起 ")).toBe(true);
	view.click(plain(100).findIndex((entry) => entry.includes("1 个已完成")));
	const header = plain(100).find((entry) => entry.includes("1 个已完成"))!;
	expect(header).not.toContain("types");
	expect(plain(100).some((entry) => /^ {2}\S types /u.test(entry))).toBe(true);
});
