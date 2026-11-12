import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { fakePi } from "./fake-pi.ts";
import { PI_TUI_URL, loadFirecodeModule } from "./loader.ts";

/** 会话分支里的人类消息与轮记录（生产中轮记录由记录器在歇下边沿写入）。 */
const humanEntry = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const roundEntry = (data: Record<string, unknown>) =>
	({ type: "custom", customType: "firecode-round", data, timestamp: new Date().toISOString() });

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


test("输入框外壳：标题取首条消息、会话名优先，状态嵌进边框、独立底栏 0 行，退出时卸下", async () => {
	let name: string | undefined;
	let entries: any[] = [];
	const host = await mount({ name: () => name, branch: () => entries });
	const { fake, ctx, bottom } = host;
	host.start();

	expect(host.footer().render(100)).toEqual([]);
	fake.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "优化插件状态栏和工具展示" }] } }, ctx);
	expect(bottom()).toContain("优化插件状态栏和工具展示");
	name = "完整的自定义会话名称";
	fake.fire("session_info_changed", {}, ctx);
	expect(bottom()).toContain(name);

	fake.fire("session_shutdown", {}, ctx);
	expect(host.footer()).toBeUndefined();
	expect(host.editor()).toBeUndefined();
});

test("任意宽度下输入框每一行都不超出终端宽度（宿主遇到超宽行会崩），审查进行中的上边框也是", async () => {
	const { visibleWidth } = await import(PI_TUI_URL) as any;
	const { fake, ctx, editor: getEditor, start } = await mount({
		model: { id: "gpt-5.5", reasoning: true, contextWindow: 1_000_000 },
		name: () => "修复登录态偶发失效",
		statuses: new Map([["master", "指挥官"], ["firecode-progress", "正在核对配置解析对旧字段的报错，为了确认整节不生效"]]),
		pi: { getThinkingLevel: () => "high" },
	});
	start();
	const editor = getEditor();
	fake.fire("agent_start", {}, ctx);
	const fits = () => {
		for (let width = 1; width <= 120; width++)
			for (const line of editor.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	};
	// 进展行替换“处理中”，窄了裁短、再窄退回“处理中”。
	expect(stripVTControlCharacters(editor.render(120)[0])).toContain("正在核对配置解析对旧字段的报错，为了确认整节不生效");
	expect(stripVTControlCharacters(editor.render(40)[0])).toContain("正在核对");
	expect(stripVTControlCharacters(editor.render(32)[0])).toContain("处理中");
	fits();
	fake.pi.events.emit("firecode:review", { active: true, progress: () => ({ stage: "reviewing", round: 2, passed: 1, total: 3, blocked: 1 }) });
	expect(stripVTControlCharacters(editor.render(120)[0])).not.toContain("正在核对");
	fits();
});

test("主回合歇下后子代理仍在飞：上边框不定格，全部落定才定格", async () => {
	const branch: unknown[] = [humanEntry("开工")];
	const { fake, ctx, start, top } = await mount({ branch: () => branch });
	await recordRounds(fake.pi, branch);
	start();
	fake.fire("agent_start", {}, ctx);
	fake.pi.events.emit("firecode:workers", { inFlight: 2 });
	fake.fire("agent_end", { messages: [] }, ctx);
	fake.fire("agent_settled", {}, ctx);
	expect(top()).not.toContain("✓");

	fake.pi.events.emit("firecode:workers", { inFlight: 0 });
	fake.fire("agent_start", {}, ctx);
	fake.fire("agent_end", { messages: [] }, ctx);
	fake.fire("agent_settled", {}, ctx);
	expect(top()).toContain("✓");
});

/** 改名键是 \x12，输入框按 answers 依次应答。 */
async function renameHost(answers: Array<string | undefined>, initialName?: string) {
	let sessionName = initialName;
	const prompts: unknown[][] = [];
	const host = await mount({
		keybindings: { matches: (data: string, action: string) => action === "app.session.rename" && data === "\x12" },
		ui: {
			input: async (...args: unknown[]) => { prompts.push(args); return answers.shift(); },
			notify() {},
		},
		pi: { getSessionName: () => sessionName, setSessionName: (name: string) => { sessionName = name; } },
	});
	host.start();
	return {
		prompts,
		name: () => sessionName,
		press: async (data: string) => { host.editor().handleInput(data); await new Promise((resolve) => setTimeout(resolve, 0)); },
	};
}

test("输入框里按宿主的改名键（app.session.rename）弹输入框改会话名；取消或留空不改，其它键不弹", async () => {
	const host = await renameHost(["new name", undefined, "   "], "old");

	await host.press("a");
	expect(host.prompts).toEqual([]);
	await host.press("\x12");
	expect(host.name()).toBe("new name");
	await host.press("\x12");
	await host.press("\x12");
	expect(host.prompts).toHaveLength(3);
	expect(host.name()).toBe("new name");
});
