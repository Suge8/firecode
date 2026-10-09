import { expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { fakePi } from "./fake-pi.ts";
import { PI_TUI_URL, loadFirecodeModule } from "./loader.ts";

const FLAME3 = "[\u2800-\u28ff]{3}";

/** 会话分支里的人类消息与轮记录（生产中轮记录由记录器在歇下边沿写入）。 */
const humanEntry = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const roundEntry = (data: Record<string, unknown>) =>
	({ type: "custom", customType: "firecode-round", data, timestamp: new Date().toISOString() });

/** 记录器写下轮记录后在进程内总线上发布的频道：订阅方此刻读分支一定已含这条记录。 */
const ROUND_RECORDED = "firecode:round-recorded";

/** 装上真正的记录器：它写进会话的轮记录落进分支，再发布“已写入”。 */
async function recordRounds(pi: any, branch: unknown[]) {
	const { registerRoundRecorder } = await loadFirecodeModule("round.ts") as any;
	pi.appendEntry = (customType: string, data: Record<string, unknown>) => { branch.push(roundEntry(data)); };
	registerRoundRecorder(pi);
}

interface MountOptions {
	moduleOptions?: Parameters<typeof loadFirecodeModule>[1];
	model?: { id: string; reasoning: boolean; contextWindow: number };
	percent?: number | null;
	/** footer 主题：默认不着色；着色用例换成会标出颜色名的替身。 */
	theme?: { fg: (color: string, text: string) => string };
	name?: () => string | undefined;
	branch?: () => unknown[];
	statuses?: Map<string, string>;
	keybindings?: unknown;
	ui?: Record<string, unknown>;
	pi?: Record<string, unknown>;
}

/** 外壳的宿主替身：注册后由 start() 发 session_start，editor/footer 是宿主拿到的组件。 */
async function mount(options: MountOptions = {}) {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts", options.moduleOptions) as any;
	const statuses = options.statuses ?? new Map<string, string>();
	let footer: any;
	let editor: any;
	const theme = options.theme ?? { fg: (_color: string, text: string) => text };
	const model = options.model ?? { id: "test-model", reasoning: false, contextWindow: 200_000 };
	const ctx = {
		isIdle: () => true,
		model,
		getContextUsage: () => ({ percent: options.percent === undefined ? 1 : options.percent, contextWindow: model.contextWindow }),
		sessionManager: { getSessionName: options.name ?? (() => undefined), getBranch: options.branch ?? (() => []) },
		ui: {
			setWorkingVisible() {},
			setFooter(factory: any) { footer = factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => statuses }); },
			setEditorComponent(factory: any) {
				editor = factory?.({ requestRender() {}, terminal: { rows: 40 } }, { borderColor: (text: string) => text, selectList: {} }, options.keybindings ?? { matches: () => false });
			},
			...options.ui,
		},
	};
	const fake = fakePi(options.pi);
	registerStatusBar(fake.pi);
	return {
		fake, ctx, statuses,
		footer: () => footer,
		editor: () => editor,
		start: () => fake.fire("session_start", {}, ctx),
		top: (width = 100) => stripVTControlCharacters(editor.render(width)[0]),
		bottom: (width = 100) => stripVTControlCharacters(editor.render(width).at(-1)),
	};
}


test("输入框外壳：标题即时取首条消息，状态嵌进上下边框，独立底栏 0 行", async () => {
	let name: string | undefined;
	let entries: any[] = [];
	const workingVisible: boolean[] = [];
	const host = await mount({
		model: { id: "test-model", reasoning: true, contextWindow: 200_000 },
		percent: 42.3,
		name: () => name,
		branch: () => entries,
		statuses: new Map([["pi-openai-native-fast", "fast"]]),
		ui: { setWorkingVisible: (visible: boolean) => workingVisible.push(visible) },
		pi: { getThinkingLevel: () => "medium" },
	});
	const { visibleWidth } = await import(PI_TUI_URL) as any;
	const { fake, ctx, statuses, top, bottom } = host;
	host.start();
	const editor = host.editor();

	expect(host.footer().render(100)).toEqual([]);
	expect(workingVisible).toEqual([false]);
	expect(bottom()).toContain("新会话");
	expect(bottom()).toContain("test-model/medium Fast · 42.3%/200k");

	const message = { role: "user", content: [{ type: "text", text: "优化插件状态栏和工具展示" }] };
	fake.fire("message_start", { message }, ctx);
	expect(bottom()).toContain("─ 优化插件状态栏和工具展示 ─");
	const long = { role: "user", content: "把 refresh token 的竞态修掉。顺便看看 lint" };
	entries = [{ type: "message", message: long }];
	fake.fire("session_tree", {}, ctx);
	expect(bottom(110)).toContain("─ 把 refresh token 的竞态修掉。 ─");
	// 窄屏先省容量再裁标题。
	expect(bottom(52)).toMatch(/^─ 把 refresh.*… ─+ test-model\/medium Fast · 42\.3% ─$/u);
	name = "完整的自定义会话名称";
	fake.fire("session_info_changed", {}, ctx);
	expect(bottom()).toContain(name);
	name = undefined;
	entries = [];
	fake.fire("session_tree", {}, ctx);
	expect(bottom()).toContain("新会话");

	expect(top()).not.toContain("处理中");
	fake.fire("agent_start", {}, ctx);
	expect(top()).toMatch(/处理中 \d/u);
	let progress = { stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 1 };
	fake.pi.events.emit("firecode:review", { active: true, progress: () => progress });
	expect(top()).toMatch(/^─ [\u2800-\u28ff]{3} \S+ · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 审查 第2轮 1\/3 · 1 阻断 /u);
	// 审查字形是金色盲文转圈点，与火苗同一字符族，靠金色区分。
	expect(editor.render(100)[0]).toMatch(/\x1b\[38;2;255;195;61m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
	progress = { stage: "reviewing", round: 2, passed: 3, total: 3, blocked: 0 };
	expect(top()).toContain("审查 第2轮 3/3 ─");
	statuses.set("watcher", "观察员");
	statuses.set("master", "指挥官");
	expect(top()).toEndWith(" 观察员 指挥官 ─");
	fake.fire("agent_end", { messages: [] }, ctx);
	fake.fire("agent_settled", {}, ctx);
	expect(top()).not.toContain("处理中");
	expect(top()).toContain("审查 第2轮 3/3");
	progress = { stage: "summarizing", round: 2, passed: 0, total: 0, blocked: 0 };
	expect(top()).toContain("审查 第2轮 总结中");
	fake.pi.events.emit("firecode:review", { active: false });
	expect(top()).not.toContain("审查");

	for (let width = 1; width <= 120; width++)
		for (const line of editor.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	fake.fire("session_shutdown", {}, ctx);
	expect(host.footer()).toBeUndefined();
	expect(host.editor()).toBeUndefined();
});

test("审查期间上边框只显示一处审查进度（不写“处理中”），窄屏逐级退让：先丢阻断数，再丢票数，最后整段让给指挥官标记", async () => {
	const { visibleWidth } = await import(PI_TUI_URL) as any;
	const { fake, ctx, editor: getEditor, start, top } = await mount({
		model: { id: "gpt-5.5", reasoning: true, contextWindow: 1_000_000 },
		percent: 12,
		name: () => "修复登录态偶发失效",
		statuses: new Map([["master", "指挥官"]]),
		pi: { getThinkingLevel: () => "high" },
	});
	start();
	const editor = getEditor();
	fake.fire("agent_start", {}, ctx);
	fake.pi.events.emit("firecode:review", { active: true, progress: () => ({ stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 1 }) });
	const glyph = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";
	expect(top(110)).toMatch(new RegExp(`^─ ${FLAME3} \\S+ · ${glyph} 审查 第2轮 1/3 · 1 阻断 ─+ 指挥官 ─$`, "u"));
	expect(top(46)).toMatch(new RegExp(`^─ ${FLAME3} \\S+ · ${glyph} 审查 第2轮 1/3 ─+ 指挥官 ─$`, "u"));
	expect(top(40)).toMatch(new RegExp(`^─ ${FLAME3} \\S+ · ${glyph} 审查 第2轮 ─+ 指挥官 ─$`, "u"));
	expect(top(36)).toMatch(new RegExp(`^─ ${FLAME3} \\S+ ─+ 指挥官 ─$`, "u"));
	for (let width = 1; width <= 120; width++) expect(visibleWidth(editor.render(width)[0])).toBeLessThanOrEqual(width);
});

test("上下文低占用保持灰色，仅接近既有阈值时警告", async () => {
	const colorOf = async (percent: number | null) => {
		const host = await mount({ percent, theme: { fg: (color, text) => `<${color}>${text}` } });
		host.start();
		return /<(\w+)>(?:[\d.]+%|\?)/u.exec(host.bottom(120))?.[1];
	};
	expect(await colorOf(0)).toBe("dim");
	expect(await colorOf(49.9)).toBe("dim");
	expect(await colorOf(50)).toBe("warning");
	expect(await colorOf(75)).toBe("error");
	expect(await colorOf(null)).toBe("muted");
});

test("输入框边框按宽度退让：下边框先省容量、再让预设名、再裁标题、最后裁模型，Fast 与百分比保留", async () => {
	const { bottomBorder } = await loadFirecodeModule("statusbar/render.js") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const parts = { title: "修复登录态偶发失效", preset: "", model: "opus-4.7", think: "/high", fast: "", percent: "23%", capacity: "/1M" };
	const line = (text: string) => text;
	const draw = (width: number, over = {}) => stripVTControlCharacters(bottomBorder(width, { ...parts, ...over }, line));

	for (const width of [110, 72]) expect(draw(width)).toMatch(/^─ 修复登录态偶发失效 ─{2,} opus-4\.7\/high · 23%\/1M ─$/u);
	expect(draw(110, { preset: "Deep" })).toMatch(/^─ 修复登录态偶发失效 ─{2,} Deep · opus-4\.7\/high · 23%\/1M ─$/u);
	expect(draw(52, { preset: "Deep" })).toMatch(/^─ 修复登录态偶发失效 ─{2,} Deep · opus-4\.7\/high · 23% ─$/u);
	expect(draw(45, { preset: "Deep" })).toMatch(/^─ 修复登录态偶发失效 ─{2,} opus-4\.7\/high · 23% ─$/u);
	expect(draw(40)).toMatch(/^─ 修复登录态偶… ─{2,} opus-4\.7\/high · 23% ─$/u);
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
	const branch: unknown[] = [humanEntry("开工")];
	const { fake, ctx, start, top } = await mount({ branch: () => branch });
	await recordRounds(fake.pi, branch);
	start();
	try {
		setSystemTime(new Date(1_000_000));
		fake.fire("agent_start", {}, ctx);
		setSystemTime(new Date(1_005_000));
		expect(top()).toMatch(/处理中 5\.0s/u);

		// 指挥官回合结束，两个子代理在飞：保持运行态，计时不重置、不定格。
		fake.pi.events.emit("firecode:workers", { inFlight: 2 });
		setSystemTime(new Date(1_065_000));
		fake.fire("agent_end", { messages: [] }, ctx);
		fake.fire("agent_settled", {}, ctx);
		expect(top()).toMatch(/等待 2 个子代理 1m5s/u);
		expect(top()).not.toContain("处理中");
		fake.pi.events.emit("firecode:workers", { inFlight: 1 });
		expect(top()).toMatch(/等待 1 个子代理 1m5s/u);
		// 等待期间用户补一句话：是给任务加话，不是开新一轮，计时不归零。
		fake.fire("input", { source: "interactive" }, ctx);
		expect(top()).toMatch(/等待 1 个子代理 1m5s/u);

		// 结果送达唤醒指挥官：回到处理中，计时仍从会话变忙起连续累计。
		setSystemTime(new Date(1_070_000));
		fake.fire("agent_start", {}, ctx);
		expect(top()).toMatch(/处理中 1m10s/u);
		fake.pi.events.emit("firecode:workers", { inFlight: 0 });
		expect(top()).toMatch(/处理中 1m10s/u);
		setSystemTime(new Date(1_080_000));
		fake.fire("agent_end", { messages: [] }, ctx);
		fake.fire("agent_settled", {}, ctx);
		expect(top()).toContain("1m20s");
		expect(top()).not.toMatch(/处理中|等待/u);

		// 落定结果一直留在边框，直到下一轮开始。
		setSystemTime(new Date(1_200_000));
		expect(top()).toMatch(/✓ 1m20s/u);
		fake.fire("agent_start", {}, ctx);
		expect(top()).not.toContain("1m20s");
		expect(top()).toMatch(/处理中 0\.0s/u);
	} finally {
		setSystemTime();
	}
});

test("上边框落定态：均速跟在耗时后，中断与请求失败写明终态", async () => {
	const branch: unknown[] = [];
	const { fake, ctx, start, top } = await mount({ branch: () => branch });
	await recordRounds(fake.pi, branch);
	const emit = (name: string, event = {}) => fake.fire(name, event, ctx);
	start();
	const round = (at: number, output: number, stopReason: string) => {
		setSystemTime(new Date(at));
		branch.push(humanEntry("再来一轮"));
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
		// 与摘要行同一写法：终态字样与耗时之间是“ · ”。
		expect(top()).toMatch(/^─ ✗ 已中断 · 10s ─+$/u);
		round(200_000, 0, "error");
		expect(top()).toMatch(/^─ ✗ 请求失败 · 10s ─+$/u);
	} finally {
		setSystemTime();
	}
});


/** 会话进行中的视图由 busy.ts 产出；这里换掉它的 watchBusy，直接喂带 review 字段的视图（主会话审查算进行中）。 */
async function shellWithBusy() {
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { FIRECODE_DIR } = await import("./loader.ts");
	const stub = [
		`export * from "./busy-real.ts";`,
		`import { watchBusy as real } from "./busy-real.ts";`,
		`export function watchBusy(pi, handlers) { globalThis.__fcBusyFeed = handlers; return real(pi, handlers); }`,
	].join("\n");
	const branch: unknown[] = [];
	let branchReads = 0;
	const host = await mount({
		moduleOptions: { extraFiles: { "busy-real.ts": readFileSync(join(FIRECODE_DIR, "busy.ts"), "utf8"), "busy.ts": stub } },
		model: { id: "test-model", reasoning: false, contextWindow: 1_000_000 },
		name: () => "修复登录态偶发失效",
		branch: () => { branchReads++; return branch; },
		statuses: new Map([["master", "指挥官"]]),
		pi: { getThinkingLevel: () => "off" },
	});
	const { fake, ctx, statuses, start } = host;
	start();
	const feed = (globalThis as any).__fcBusyFeed;
	let progress: Record<string, unknown> | undefined;
	return {
		statuses,
		branch,
		branchReads: () => branchReads,
		start,
		/** review: true 即审查持有；进度由 review() 设置，外壳每次绘制才读它。 */
		view: ({ review, ...view }: Record<string, unknown>) =>
			feed.onChange({ agentRunning: false, inFlight: 0, ...view, review: review ? () => progress : undefined }),
		/** 歇下边沿：像记录器一样把这一段的轮记录写进分支，再通知外壳。 */
		settle: (round: Record<string, unknown>) => {
			branch.push(roundEntry(round));
			fake.pi.events.emit(ROUND_RECORDED);
		},
		review: (next: Record<string, unknown>) => { progress = next; },
		top: (width = 110) => host.top(width),
		bottom: (width = 110) => host.bottom(width),
	};
}

test("主会话审查算会话进行中：上边框是火苗加计时与审查进度，不并排显示上一段的落定记录，也不写“等待 N 个子代理”", async () => {
	const shell = await shellWithBusy();
	const glyph = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";
	try {
		setSystemTime(new Date(1_000_000));
		shell.settle({ elapsed: 3_100, outcome: "complete", tps: 21.5 });
		expect(shell.top()).toContain("✓ 3.1s");
		shell.view({ busy: true, since: 1_000_000, review: true, inFlight: 2 });
		shell.review({ stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 0 });
		setSystemTime(new Date(1_062_000));
		expect(shell.top()).toMatch(new RegExp(`^─ ${FLAME3} 1m2s · ${glyph} 审查 第2轮 1/3 ─+ 指挥官 ─$`, "u"));
		expect(shell.top(40)).toMatch(new RegExp(`^─ ${FLAME3} 1m2s · ${glyph} 审查 第2轮 ─+ 指挥官 ─$`, "u"));
		// 修复回合指挥官在跑，措辞与只等审查时一致：审查期间的状态都由审查进度说明，不另写“处理中”。
		shell.view({ busy: true, since: 1_000_000, review: true, agentRunning: true });
		shell.review({ stage: "fixing", round: 2, passed: 0, total: 0, blocked: 0 });
		expect(shell.top()).toMatch(new RegExp(`^─ ${FLAME3} 1m2s · ${glyph} 审查 第2轮 修复中 ─+ 指挥官 ─$`, "u"));
	} finally {
		setSystemTime();
	}
});

test("歇下那一刻上边框直接是 ✓ 加定格文字，不先出一帧冷却中的火苗", async () => {
	const shell = await shellWithBusy();
	shell.view({ busy: true, since: Date.now() - 2_900, agentRunning: true });
	shell.view({ busy: false });
	shell.settle({ elapsed: 2_900, outcome: "complete", tps: 40 });
	expect(shell.top()).toMatch(/^─ ✓ 2\.9s · 40 tps ─+ 指挥官 ─$/u);
});

test("预设名显示在下边框标题之后、模型之前，不带图标；显不显示由预设模块发不发布决定，外壳原样显示", async () => {
	const shell = await shellWithBusy();
	shell.statuses.set("preset", "Deep");
	expect(shell.bottom()).toMatch(/^─ 修复登录态偶发失效 ─+ Deep · test-model · 1\.0%\/1M ─$/u);
	shell.statuses.set("preset", "\x1b[38;5;4mModel\x1b[39m");
	expect(shell.bottom()).toMatch(/^─ 修复登录态偶发失效 ─+ Model · test-model · 1\.0%\/1M ─$/u);
});

test("落定态与摘要行读同一份事实：一轮多段按同一合成规则显示整轮（耗时累加、更早的中断追加）；事件时算一次，歇下后反复重绘（按键）不再读会话分支；重开会话时直接显示上一轮", async () => {
	const shell = await shellWithBusy();
	shell.branch.push(humanEntry("上一轮"), roundEntry({ elapsed: 9_000, outcome: "complete" }));
	shell.branch.push(humanEntry("写一篇冬天散文"), roundEntry({ elapsed: 17_700, outcome: "aborted" }));
	shell.view({ busy: true, since: Date.now() - 195_000, review: true });
	shell.view({ busy: false });
	shell.settle({ elapsed: 195_000, outcome: "complete", tps: 77.1 });
	const settled = /^─ ✓ 3m33s · 中断过 1 次 ─+ 指挥官 ─$/u;
	const reads = shell.branchReads();
	for (let key = 0; key < 20; key++) expect(shell.top()).toMatch(settled);
	expect(shell.branchReads()).toBe(reads);

	shell.start();
	expect(shell.top()).toMatch(settled);
});

/** 改名键是 \x12，输入框按 answers 依次应答。 */
async function renameHost(answers: Array<string | undefined>, initialName?: string) {
	let sessionName = initialName;
	const prompts: unknown[][] = [];
	const notices: string[] = [];
	const host = await mount({
		keybindings: { matches: (data: string, action: string) => action === "app.session.rename" && data === "\x12" },
		ui: {
			input: async (...args: unknown[]) => { prompts.push(args); return answers.shift(); },
			notify: (message: string) => notices.push(message),
		},
		pi: { getSessionName: () => sessionName, setSessionName: (name: string) => { sessionName = name; } },
	});
	host.start();
	return {
		fake: host.fake, prompts, notices,
		name: () => sessionName,
		press: async (data: string) => { host.editor().handleInput(data); await new Promise((resolve) => setTimeout(resolve, 0)); },
	};
}

test("输入框里按宿主的改名键（app.session.rename）弹输入框（预填当前名字）改会话名，名字去掉控制字符", async () => {
	const host = await renameHost(["  new\u200b name\n"], "old");

	await host.press("\x12");

	expect(host.prompts[0]?.[1]).toBe("old");
	expect(host.name()).toBe("new name");
	expect(host.notices).toEqual(["会话已改名：new name"]);
});

test("改名取消或留空不改会话名；其它键不弹输入框", async () => {
	const host = await renameHost([undefined, "   "], "old");

	await host.press("a");
	expect(host.prompts).toEqual([]);
	await host.press("\x12");
	await host.press("\x12");

	expect(host.prompts).toHaveLength(2);
	expect(host.name()).toBe("old");
	expect(host.notices).toEqual([]);
});

test("不注册 /rename 命令，也不自占快捷键：键位归宿主的 app.session.rename", async () => {
	const host = await renameHost([]);

	expect([...host.fake.commands.keys()]).toEqual([]);
	expect([...host.fake.shortcuts.keys()]).toEqual([]);
});
