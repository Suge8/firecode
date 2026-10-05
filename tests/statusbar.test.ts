import { afterEach, expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { contextColor } from "../theme.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

/** 同名事件保留全部处理器（busy.ts 与 statusbar 都订阅生命周期事件），按注册顺序依次调用。 */
const chain = (previous: Function | undefined, next: Function): Function =>
	previous ? (...args: unknown[]) => { previous(...args); return next(...args); } : next;

test("输入框外壳：标题即时取首条消息，状态嵌进上下边框，独立底栏 0 行", async () => {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const events = new Map<string, Function>();
	const bus = new Map<string, Function>();
	let footer: any;
	let editor: any;
	let name: string | undefined;
	let entries: any[] = [];
	const workingVisible: boolean[] = [];
	const statuses = new Map<string, string>([["pi-openai-native-fast", "fast"]]);
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		isIdle: () => true,
		model: { id: "test-model", reasoning: true, contextWindow: 200_000 },
		getContextUsage: () => ({ percent: 42.3, contextWindow: 200_000 }),
		sessionManager: { getSessionName: () => name, getBranch: () => entries },
		ui: {
			setWorkingVisible: (visible: boolean) => workingVisible.push(visible),
			setFooter(factory: any) {
				footer = factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => statuses });
			},
			setEditorComponent(factory: any) {
				editor = factory?.(
					{ requestRender() {}, terminal: { rows: 40 } },
					{ borderColor: (text: string) => text, selectList: {} },
					{ matches: () => false },
				);
			},
		},
	};
	registerStatusBar({
		on: (event: string, fn: Function) => events.set(event, chain(events.get(event), fn)),
		events: { on: (channel: string, fn: Function) => bus.set(channel, fn) },
		getThinkingLevel: () => "medium",
	});
	events.get("session_start")!({}, ctx);
	const plain = (line: string) => stripVTControlCharacters(line);
	const bottom = (width = 100) => plain(editor.render(width).at(-1));
	const top = (width = 100) => plain(editor.render(width)[0]);

	expect(footer.render(100)).toEqual([]);
	expect(workingVisible).toEqual([false]);
	expect(bottom()).toContain("新会话");
	expect(bottom()).toContain("test-model/medium Fast · 42.3%/200k");

	const message = { role: "user", content: [{ type: "text", text: "优化插件状态栏和工具展示" }] };
	events.get("message_start")!({ message }, ctx);
	expect(bottom()).toContain("─ 优化插件状态栏和工具展示 ─");
	const long = { role: "user", content: "把 refresh token 的竞态修掉。顺便看看 lint" };
	entries = [{ type: "message", message: long }];
	events.get("session_tree")!({}, ctx);
	expect(bottom(110)).toContain("─ 把 refresh token 的竞态修掉。 ─");
	expect(bottom(52)).toMatch(/^─ 把 \S+… ─+ test-model/u);
	name = "完整的自定义会话名称";
	events.get("session_info_changed")!({}, ctx);
	expect(bottom()).toContain(name);
	name = undefined;
	entries = [];
	events.get("session_tree")!({}, ctx);
	expect(bottom()).toContain("新会话");

	expect(top()).not.toContain("处理中");
	events.get("agent_start")!({}, ctx);
	expect(top()).toMatch(/处理中 \d/u);
	let progress = { stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 1 };
	bus.get("herdr:blocked")!({ active: true, label: "对抗审查进行中", progress: () => progress });
	expect(top()).toMatch(/处理中 \S+ · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 审查 第2轮 1\/3 · 1 阻断 /u);
	// 审查字形是金色盲文转圈点，与火苗同一字符族，靠金色区分。
	expect(editor.render(100)[0]).toMatch(/\x1b\[38;2;255;195;61m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
	progress = { stage: "reviewing", round: 2, passed: 3, total: 3, blocked: 0 };
	expect(top()).toContain("审查 第2轮 3/3 ─");
	statuses.set("watcher", "观察员");
	statuses.set("master", "指挥官");
	expect(top()).toEndWith(" 观察员 指挥官 ─");
	events.get("agent_end")!({ messages: [] }, ctx);
	events.get("agent_settled")!({}, ctx);
	expect(top()).not.toContain("处理中");
	expect(top()).toContain("审查 第2轮 3/3");
	progress = { stage: "summarizing", round: 2, passed: 0, total: 0, blocked: 0 };
	expect(top()).toContain("审查 第2轮 总结中");
	bus.get("herdr:blocked")!({ active: false });
	expect(top()).not.toContain("审查");

	for (let width = 1; width <= 120; width++)
		for (const line of editor.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	events.get("session_shutdown")!({}, ctx);
	expect(footer).toBeUndefined();
	expect(editor).toBeUndefined();
});

test("审查期间上边框只显示一处审查进度，窄屏逐级退让：先丢轮次，再丢审查字样，最后只留计数", async () => {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const events = new Map<string, Function>();
	const bus = new Map<string, Function>();
	let editor: any;
	const statuses = new Map([["master", "指挥官"]]);
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		isIdle: () => true,
		model: { id: "gpt-5.5", reasoning: true, contextWindow: 1_000_000 },
		getContextUsage: () => ({ percent: 12, contextWindow: 1_000_000 }),
		sessionManager: { getSessionName: () => "修复登录态偶发失效", getBranch: () => [] },
		ui: {
			setWorkingVisible() {},
			setFooter(factory: any) { factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => statuses }); },
			setEditorComponent(factory: any) {
				editor = factory?.({ requestRender() {}, terminal: { rows: 40 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
			},
		},
	};
	registerStatusBar({ on: (event: string, fn: Function) => events.set(event, chain(events.get(event), fn)), events: { on: (channel: string, fn: Function) => bus.set(channel, fn) }, getThinkingLevel: () => "high" });
	events.get("session_start")!({}, ctx);
	events.get("agent_start")!({}, ctx);
	bus.get("herdr:blocked")!({ active: true, label: "对抗审查进行中", progress: () => ({ stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 1 }) });
	const top = (width: number) => stripVTControlCharacters(editor.render(width)[0]);
	const glyph = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";
	expect(top(110)).toMatch(new RegExp(`^─ \\S+ 处理中 \\S+ · ${glyph} 审查 第2轮 1/3 · 1 阻断 ─+ 指挥官 ─$`, "u"));
	expect(top(52)).toMatch(new RegExp(`^─ \\S+ 处理中 \\S+ · ${glyph} 审查 1/3 · 1 阻断 ─+ 指挥官 ─$`, "u"));
	expect(top(47)).toMatch(new RegExp(`^─ \\S+ 处理中 \\S+ · ${glyph} 1/3 · 1 阻断 ─+ 指挥官 ─$`, "u"));
	expect(top(30)).toMatch(new RegExp(`^─ \\S+ \\S+ · ${glyph} 1/3 ─+ 指挥官 ─$`, "u"));
	for (let width = 1; width <= 120; width++) expect(visibleWidth(editor.render(width)[0])).toBeLessThanOrEqual(width);
	expect(stripVTControlCharacters(editor.render(110).at(-1))).toContain("12.0%/1M");
});

test("上下文低占用保持灰色，仅接近既有阈值时警告", () => {
	expect(contextColor(0)).toBe("dim");
	expect(contextColor(49.9)).toBe("dim");
	expect(contextColor(50)).toBe("warning");
	expect(contextColor(75)).toBe("error");
	expect(contextColor(undefined)).toBe("muted");
});

test("输入框边框按宽度退让：下边框先裁标题、再省容量、最后裁模型，Fast 与百分比保留", async () => {
	const { bottomBorder } = await loadFirecodeModule("statusbar/render.js") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const parts = { title: "修复登录态偶发失效", model: "opus-4.7", think: "/high", fast: "", percent: "23%", capacity: "/1M" };
	const line = (text: string) => text;
	const draw = (width: number, over = {}) => stripVTControlCharacters(bottomBorder(width, { ...parts, ...over }, line));

	for (const width of [110, 72]) expect(draw(width)).toMatch(/^─ 修复登录态偶发失效 ─{2,} opus-4\.7\/high · 23%\/1M ─$/u);
	expect(draw(40)).toMatch(/^─ 修复登录… ─{2,} opus-4\.7\/high · 23%\/1M ─$/u);
	expect(draw(26)).toMatch(/^─{3,} opus-4\.7\/high · 23% ─$/u);
	expect(draw(26, { fast: "Fast" })).toMatch(/Fast · 23% ─$/u);
	for (let width = 0; width <= 120; width++)
		for (const fast of ["", "Fast"]) {
			const text = bottomBorder(width, { ...parts, fast }, line);
			expect(visibleWidth(text)).toBeLessThanOrEqual(width);
			if (width >= 20) expect(stripVTControlCharacters(text)).toContain("23%");
		}
});

test("输入框上边框：状态在左，观察员与指挥官在右，宽度不够时先省审查字样、处理中、审查计数", async () => {
	const { topBorder } = await loadFirecodeModule("statusbar/render.js") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const parts = {
		mark: "FFF", word: "处理中", elapsed: "12s", review: ["◈ 审查 2/3", "◈ 2/3"],
		watcher: "观察员", master: "指挥官", glow: 0,
	};
	const line = (text: string) => text;
	const draw = (width: number, over = {}) => stripVTControlCharacters(topBorder(width, { ...parts, ...over }, line));

	for (const width of [110, 72]) expect(draw(width)).toMatch(/^─ FFF 处理中 12s · ◈ 审查 2\/3 ─{2,} 观察员 指挥官 ─$/u);
	expect(draw(40)).toMatch(/^─ FFF 处理中 12s · ◈ 2\/3 ─{2,} 指挥官 ─$/u);
	expect(draw(26)).toMatch(/^─ FFF 12s ─{2,} 指挥官 ─$/u);
	const idle = { mark: "", word: "", elapsed: "", review: [] };
	expect(draw(110, idle)).toMatch(/^─{2,} 观察员 指挥官 ─$/u);
	expect(draw(30, { ...idle, watcher: "", master: "" })).toBe("─".repeat(30));
	for (let width = 0; width <= 120; width++)
		for (const over of [{}, idle, { watcher: "" }, { master: "" }])
			expect(visibleWidth(topBorder(width, { ...parts, ...over }, line))).toBeLessThanOrEqual(width);
});

test("上边框三态：处理中 / 等待 N 个子代理（计时自会话变忙起连续累计，中途输入与结果唤醒都不重置）/ 全部落定且歇下才定格", async () => {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts") as any;
	const bus = new Map<string, Function>();
	let editor: any;
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		isIdle: () => true,
		model: { id: "test-model", reasoning: false, contextWindow: 200_000 },
		getContextUsage: () => ({ percent: 1, contextWindow: 200_000 }),
		sessionManager: { getSessionName: () => undefined, getBranch: () => [] },
		ui: {
			setWorkingVisible() {},
			setFooter(factory: any) { factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => new Map() }); },
			setEditorComponent(factory: any) {
				editor = factory?.({ requestRender() {}, terminal: { rows: 40 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
			},
		},
	};
	// 同名事件保留全部处理器：busy.ts 与 statusbar 都订阅生命周期事件。
	const handlers = new Map<string, Function[]>();
	registerStatusBar({
		on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		events: { on: (channel: string, fn: Function) => bus.set(channel, fn) },
		getThinkingLevel: () => "off",
	});
	const events = { get: (event: string) => (...args: unknown[]) => handlers.get(event)?.forEach((fn) => fn(...args)) };
	events.get("session_start")!({}, ctx);
	const top = () => stripVTControlCharacters(editor.render(100)[0]);
	try {
		setSystemTime(new Date(1_000_000));
		events.get("agent_start")!({}, ctx);
		setSystemTime(new Date(1_005_000));
		expect(top()).toMatch(/处理中 5\.0s/u);

		// 指挥官回合结束，两个子代理在飞：保持运行态，计时不重置、不定格。
		bus.get("firecode:workers")!({ inFlight: 2 });
		setSystemTime(new Date(1_065_000));
		events.get("agent_end")!({ messages: [] }, ctx);
		events.get("agent_settled")!({}, ctx);
		expect(top()).toMatch(/等待 2 个子代理 1m5s/u);
		expect(top()).not.toContain("处理中");
		bus.get("firecode:workers")!({ inFlight: 1 });
		expect(top()).toMatch(/等待 1 个子代理 1m5s/u);
		// 等待期间用户补一句话：是给任务加话，不是开新一轮，计时不归零。
		events.get("input")?.({ source: "interactive" }, ctx);
		expect(top()).toMatch(/等待 1 个子代理 1m5s/u);

		// 结果送达唤醒指挥官：回到处理中，计时仍从会话变忙起连续累计。
		setSystemTime(new Date(1_070_000));
		events.get("agent_start")!({}, ctx);
		expect(top()).toMatch(/处理中 1m10s/u);
		bus.get("firecode:workers")!({ inFlight: 0 });
		expect(top()).toMatch(/处理中 1m10s/u);
		setSystemTime(new Date(1_080_000));
		events.get("agent_end")!({ messages: [] }, ctx);
		events.get("agent_settled")!({}, ctx);
		expect(top()).toContain("1m20s");
		expect(top()).not.toMatch(/处理中|等待/u);

		// 落定结果一直留在边框，直到下一轮开始。
		setSystemTime(new Date(1_200_000));
		expect(top()).toMatch(/✓ 1m20s/u);
		events.get("agent_start")!({}, ctx);
		expect(top()).not.toContain("1m20s");
		expect(top()).toMatch(/处理中 0\.0s/u);
	} finally {
		setSystemTime();
	}
});

test("上边框落定态：均速跟在耗时后，中断与请求失败写明终态", async () => {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts") as any;
	const events = new Map<string, Function[]>();
	let editor: any;
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		isIdle: () => true,
		model: { id: "test-model", reasoning: false, contextWindow: 200_000 },
		getContextUsage: () => ({ percent: 1, contextWindow: 200_000 }),
		sessionManager: { getSessionName: () => undefined, getBranch: () => [] },
		ui: {
			setWorkingVisible() {},
			setFooter(factory: any) { factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => new Map() }); },
			setEditorComponent(factory: any) {
				editor = factory?.({ requestRender() {}, terminal: { rows: 40 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
			},
		},
	};
	registerStatusBar({
		on: (event: string, fn: Function) => events.set(event, [...(events.get(event) ?? []), fn]),
		events: { on() {} },
		getThinkingLevel: () => "off",
	});
	const emit = (name: string, event = {}) => events.get(name)?.forEach((fn) => fn(event, ctx));
	emit("session_start");
	const top = () => stripVTControlCharacters(editor.render(100)[0]);
	const round = (at: number, output: number, stopReason: string) => {
		setSystemTime(new Date(at));
		emit("agent_start");
		emit("before_provider_request");
		setSystemTime(new Date(at + 10_000));
		emit("message_end", { message: { role: "assistant", usage: { output }, stopReason } });
		emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		emit("agent_settled");
		setSystemTime(new Date(at + 20_000));
	};
	try {
		round(0, 420, "stop");
		expect(top()).toMatch(/^─ ✓ 10s · 42 tps ─+$/u);
		round(100_000, 100, "aborted");
		expect(top()).toMatch(/^─ ✗ 已中断 10s ─+$/u);
		round(200_000, 0, "error");
		expect(top()).toMatch(/^─ ✗ 请求失败 10s ─+$/u);
	} finally {
		setSystemTime();
	}
});
