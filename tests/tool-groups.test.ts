import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let dispose: (() => void) | undefined;
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	await cleanupFirecodeModules();
});

const FLAME = "[\u2800-\u28ff]";

async function scene(options: { withMaster?: boolean; replyLines?: number } = {}) {
	const { withMaster = false, replyLines = 3 } = options;
	const [host, tui, module, toolsModule, clockModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/index.ts"), loadFirecodeModule("tools/turn-clock.ts"),
	]);
	let now = 0;
	const clock = new (clockModule.TurnClock as any)(() => now);
	host.initTheme("dark");
	const tools = new Map<string, any>();
	const api = { on() {}, events: { on: () => () => {}, emit() {} }, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {} };
	toolsModule.registerToolRendering(api);
	if (withMaster) {
		const { registerMaster } = await loadFirecodeModule("master/index.ts");
		registerMaster(api);
	}
	const chat = new tui.Container();
	const root = new tui.Container();
	root.addChild(chat);
	let expanded = false;
	let renders = 0;
	root.requestRender = () => { renders++; };
	const originalRequestRender = root.requestRender;
	const { createInteractiveTuiReference } = await import(new URL("./modes/interactive/tui-renderer.ts", PI_CODING_AGENT_URL).href);
	const reference = createInteractiveTuiReference(() => root);
	const ui = {
		theme: { fg: (color: string, text: string) => `\x1b[38;5;${[...color].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 256}m${text}\x1b[39m`, bg: (_color: string, text: string) => text, bold: (text: string) => text },
		getToolsExpanded: () => expanded,
		setToolsExpanded(value: boolean) {
			expanded = value;
			for (const child of chat.children) child.setExpanded?.(value);
			root.requestRender();
		},
		setWidget(_key: string, factory?: (tui: unknown) => unknown) { factory?.(reference); },
		notify(message: string) { throw new Error(message); },
	};
	const tool = (name: string, args: Record<string, unknown>, definition = tools.get(name)) => {
		const row = new host.ToolExecutionComponent(name, crypto.randomUUID(), args, {}, definition, reference, "/project");
		row.setExpanded(expanded);
		chat.addChild(row);
		root.requestRender();
		return row;
	};
	const complete = (row: any, text = "private full result", isError = false) =>
		row.updateResult({ content: [{ type: "text", text }], isError });
	const lines = (width = 100) => chat.render(width).map(stripVTControlCharacters);
	const click = (y: number, width = 100) => chat.handleMouse({ type: "click", button: "left", x: 5, y, width, height: chat.render(width).length, shift: false, alt: false, ctrl: false });
	const originalRender = chat.render;
	dispose = module.installGroupPatch(ui, { replyLines, clock });
	const setNow = (value: number) => { now = value; };
	return { clock, setNow, host, tui, chat, root, ui, tool, complete, lines, click, originalRender, originalRequestRender, renders: () => renders };
}

test("连续工具默认一行，原生全局展开只显示列表，单工具仍可点击查看正文", async () => {
	const s = await scene();
	const read = s.tool("read", { path: "/project/a.ts" });
	s.complete(read);
	const bash = s.tool("bash", { command: "bun test" });
	const summary = s.lines().filter(Boolean);
	expect(summary).toHaveLength(1);
	expect(summary[0]).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test\\s*$`));
	expect(summary.join("\n")).not.toContain("private full result");

	s.ui.setToolsExpanded(true);
	expect(s.lines().filter(Boolean)).toHaveLength(3);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test\\s*$`));
	expect(s.lines().join("\n")).toContain("读取");
	expect(s.lines().join("\n")).not.toContain("private full result");
	const readLine = s.lines().findIndex((line: string) => line.includes("读取"));
	s.click(readLine);
	expect(s.lines().join("\n")).toContain("private full result");
	s.click(readLine);
	expect(s.lines().join("\n")).not.toContain("private full result");

	s.complete(bash);
	s.ui.setToolsExpanded(false);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
	dispose?.();
	dispose = undefined;
	expect(s.chat.render).toBe(s.originalRender);
	expect(s.root.requestRender).toBe(s.originalRequestRender);
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("private full result");
});

test("思考与工具合成过程组，展开恢复原生思考，通知和文字仍分组", async () => {
	const s = await scene();
	const first = s.tool("read", { path: "a" });
	s.complete(first);
	const empty = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	empty.updateContent({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] });
	s.chat.addChild(empty);
	const second = s.tool("read", { path: "b" });
	s.complete(second);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(1);

	empty.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "需要检查另一处" }] }, false);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	s.ui.setToolsExpanded(true);
	const thoughtLine = s.lines().findIndex((line: string) => line.includes("Thinking..."));
	expect(thoughtLine).toBeGreaterThanOrEqual(0);
	s.click(thoughtLine);
	expect(s.lines().join("\n")).toContain("需要检查另一处");
	s.ui.setToolsExpanded(false);
	expect(s.lines().join("\n")).not.toContain("需要检查另一处");
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	const index = s.chat.children.indexOf(empty);
	s.chat.children[index] = new s.tui.Text("审查已完成", 0, 0);
	expect(s.lines().join("\n")).toContain("审查已完成");
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(2);
	s.chat.children.splice(index, 1);
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(1);
});

test("摘要优先显示运行项且保留失败，切档不改聊天树", async () => {
	const s = await scene();
	const running = s.tool("bash", { command: "long-running" });
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	s.complete(s.tool("read", { path: "finished" }));
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 操作 \\$ long-running · 1 次失败\\s*$`));
	const originalChildren = [...s.chat.children];
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("ENOENT");
	expect(s.chat.children).toEqual(originalChildren);
	for (const expanded of [false, true]) {
		s.ui.setToolsExpanded(expanded);
		for (const width of [1, 12, 40, 100])
			for (const line of s.lines(width)) expect(s.tui.visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	s.complete(running);
	s.ui.setToolsExpanded(false);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✗ 1 次失败\s*$/);
	expect(s.lines(12).filter(Boolean)[0]).toMatch(/^✗ 1 次失败\s*$/);
});

test("用户消息之间的整段过程折成一行：图片、中途正文与模型收件折入，段尾回复可见，展开态按原序", async () => {
	const s = await scene();
	const assistant = () => {
		const message = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
		s.chat.addChild(message);
		return message;
	};
	s.complete(s.tool("read", { path: "a.ts" }));
	const image = s.tool("read", { path: "shot.png" });
	image.updateResult({ content: [{ type: "text", text: "image payload" }, { type: "image", data: "", mimeType: "image/png" }], isError: false });
	const interim = assistant();
	interim.updateContent({ role: "assistant", stopReason: "pending", content: [{ type: "text", text: "先看一下子代理的进展" }] }, true);
	expect(s.lines().join("\n")).toContain("先看一下子代理的进展");
	interim.updateContent({ role: "assistant", stopReason: "toolUse", content: [
		{ type: "text", text: "先看一下子代理的进展" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} },
	] }, false);
	s.complete(s.tool("bash", { command: "bun test" }));
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-master-event", content: "fix-auth 完成", display: true, timestamp: 0 }));
	s.complete(s.tool("read", { path: "b.ts" }));
	const final = assistant();
	final.updateContent({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "修好了" }] }, false);

	const collapsed = s.lines().filter(Boolean);
	expect(collapsed.map((line: string) => line.trim())).toEqual([
		expect.stringMatching(/^✓$/), "先看一下子代理的进展", "修好了",
	]);
	expect(collapsed.join("\n")).not.toMatch(/fix-auth 完成|image payload/);

	s.chat.addChild(new s.host.UserMessageComponent("下一问"));
	s.complete(s.tool("read", { path: "c.ts" }));
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(2);
	expect(s.lines().join("\n")).toContain("下一问");

	s.ui.setToolsExpanded(true);
	const expanded = s.lines().join("\n");
	const order = ["a.ts", "shot.png", "先看一下子代理的进展", "bun test", "fix-auth 完成", "b.ts", "修好了", "下一问", "c.ts"];
	const positions = order.map((needle) => expanded.indexOf(needle));
	expect(positions.every((position) => position >= 0)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
	expect(expanded).not.toContain("image payload");
	s.click(s.lines().findIndex((line: string) => line.includes("shot.png")));
	expect(s.lines().join("\n")).toContain("image payload");
});

test("普通第三方工具的失败摘要与完整正文都可查看", async () => {
	const s = await scene();
	const row = s.tool("plain_tool", { query: "example" });
	s.complete(row, "\x1b[31mNetwork timeout\x1b[0m", true);
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("Network timeout");
	const index = s.lines().findIndex((line: string) => line.includes("plain_tool"));
	s.click(index);
	expect(s.lines().join("\n")).toContain("query");
});

test("无工具退出与重复安装都释放自己的钩子，无头子会话不改主会话展示", async () => {
	const { Container } = await import(PI_TUI_URL);
	const addChild = Container.prototype.addChild;
	const s = await scene();
	dispose?.();
	dispose = undefined;
	expect(Container.prototype.addChild).toBe(addChild);
	const module = await loadFirecodeModule("tools/grouping.ts");
	const options = { replyLines: 3, clock: s.clock };
	const oldDispose = module.installGroupPatch(s.ui, options);
	dispose = module.installGroupPatch(s.ui, options);
	oldDispose();
	s.complete(s.tool("read", { path: "a" }));
	s.complete(s.tool("read", { path: "b" }));
	expect(Container.prototype.addChild).toBe(addChild);
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(1);
	const events = new Map<string, Function>();
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	registerToolRendering({ on: (name: string, handler: Function) => events.set(name, handler), events: { on: () => () => {} }, registerTool() {}, registerCommand() {} });
	events.get("session_start")!({}, { mode: "rpc" });
	events.get("session_shutdown")!();
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	dispose?.();
	dispose = undefined;
	expect(s.chat.render).toBe(s.originalRender);
});

test("首条思考即显示过程状态，思考完成后摘要行留在原位，混合消息只藏思考，不改正文、原树或消息跳转标记", async () => {
	const s = await scene();
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	assistant.updateContent({ role: "assistant", content: [], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 处理中\\s*$`));
	assistant.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "第一段内部思考" }], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 思考中\\s*$`));
	assistant.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "第一段内部思考" }, { type: "text", text: "第一段" }], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
	const message = {
		role: "assistant", stopReason: "stop", content: [
			{ type: "thinking", thinking: "第一段内部思考" },
			{ type: "text", text: "第一段正式回复" },
			{ type: "thinking", thinking: "第二段内部思考" },
			{ type: "text", text: "**第二段正式回复**" },
		],
	};
	const originalMessage = structuredClone(message);
	assistant.updateContent(message, false);
	let clicks = 0;
	assistant.addChild(new s.tui.MouseRegion(new s.tui.Text("原生额外内容", 0, 0), () => { clicks++; return { handled: true }; }));
	const originalTree = assistant.children;
	const originalContent = originalTree[0].children;
	const collapsed = s.lines().join("\n");
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
	expect(collapsed).toContain("第一段正式回复");
	expect(collapsed).toContain("第二段正式回复");
	expect(collapsed).not.toMatch(/内部思考|Thinking|✦/);
	expect(collapsed.indexOf("第一段正式回复")).toBeLessThan(collapsed.indexOf("第二段正式回复"));
	const raw = s.chat.render(100).join("\n");
	expect(raw.match(/\x1b\]133;A\x07/g)).toHaveLength(1);
	expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07");
	expect(assistant.children).toBe(originalTree);
	expect(originalTree[0].children).toBe(originalContent);
	expect(message).toEqual(originalMessage);
	s.click(s.lines().findIndex((line: string) => line.includes("原生额外内容")));
	expect(clicks).toBe(1);
	s.ui.setToolsExpanded(true);
	assistant.setHideThinkingBlock(false);
	expect(s.lines().join("\n")).toContain("第一段内部思考");
	expect(s.lines().join("\n")).toContain("第二段内部思考");
	s.ui.setToolsExpanded(false);
	expect(s.lines().join("\n")).toBe(collapsed);
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", "Cache miss: 20k tokens re-billed"), 1, 0));
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓ ⚠ Cache miss: 20k tokens re-billed\s*$/);
	// 前两行是段首空行与摘要行；其后的回复一字不动
	expect(s.lines().slice(2).join("\n")).toBe(collapsed.split("\n").slice(2).join("\n"));
});

test("思考期间仍保留已有工具失败，异常和截断诊断不会被思考折叠吞掉", async () => {
	const s = await scene();
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	const content = [{ type: "thinking", thinking: "不应直接显示的思考" }];
	assistant.updateContent({ role: "assistant", content, stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 思考中 · 1 次失败\\s*$`));
	for (const [stopReason, diagnostic] of [["error", "Error: failed"], ["aborted", "failed"], ["length", "Response was truncated"]]) {
		assistant.updateContent({ role: "assistant", content, stopReason, errorMessage: "failed" }, false);
		expect(s.lines().join("\n")).toContain(diagnostic);
		expect(s.lines().join("\n")).not.toContain("不应直接显示的思考");
	}
});

test("真实子代理调用与池查询纳入过程组，保留原生动作和列表摘要，详情按需展开", async () => {
	const s = await scene({ withMaster: true });
	s.complete(s.tool("read", { path: "a.ts" }));
	const start = s.tool("subagents", { action: "start", worker: "worker-one", role: "工程师", prompt: "检查实现" });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 子代理 启动 worker-one`));
	s.complete(start, "worker started");
	const list = s.tool("subagents_list", {});
	list.updateResult({ content: [{ type: "text", text: "raw pool result" }], isError: false, details: {
		workers: [{ name: "worker-one", role: "工程师", status: "working", model: "test/model", thinking: "low", currentAction: { kind: "tool", tool: "read", startedAt: Date.now() } }],
	} });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
	expect(s.lines().join("\n")).not.toContain("worker-one");
	s.ui.setToolsExpanded(true);
	expect(s.lines().filter(Boolean)).toHaveLength(4);
	expect(s.lines().join("\n")).toContain("启动 worker-one");
	expect(s.lines().join("\n")).toContain("池 1");
	const queryLine = s.lines().findIndex((line: string) => line.includes("查看"));
	s.click(queryLine);
	expect(s.lines().join("\n")).toContain("model/low");
	expect(s.lines().join("\n")).toContain("read");
	s.click(queryLine);
	expect(s.lines().filter(Boolean)).toHaveLength(4);
	s.ui.setToolsExpanded(false);
	for (const [action, label] of [["send", "发送"], ["interrupt", "中断"], ["review", "审查"], ["tail", "近况"], ["ack", "待命"], ["kill", "移除"]]) {
		s.complete(s.tool("subagents", { action, worker: "worker-one", prompt: "继续" }));
		expect(s.lines().filter(Boolean)).toHaveLength(1);
		expect(s.lines().join("\n")).not.toContain(label);
	}
});

test("自定义渲染与自带鼠标处理的工具同样入组，展开态正文与点击归渲染器自己", async () => {
	const s = await scene();
	let clicked = 0;
	for (const shell of ["self", "default"]) {
		s.complete(s.tool(`custom-${shell}`, { task: "inspect" }, {
			name: `custom-${shell}`, label: `custom-${shell}`, renderShell: shell,
			renderCall() {
				const box = new s.tui.Box(0, 0);
				box.addChild(new s.tui.Text(`static custom render ${shell}`, 0, 0));
				return box;
			},
		}));
	}
	s.complete(s.tool("real-control", {}, {
		name: "real-control", label: "real-control", renderShell: "self",
		renderCall: () => new s.tui.MouseRegion(new s.tui.Text("确认操作", 0, 0), () => { clicked++; return { handled: true }; }),
	}));
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
	s.ui.setToolsExpanded(true);
	for (const shell of ["self", "default"]) {
		s.click(s.lines().findIndex((line: string) => line.startsWith("▏") && line.includes(`custom-${shell}`)));
		expect(s.lines().join("\n")).toContain(`static custom render ${shell}`);
		s.click(s.lines().findIndex((line: string) => line.includes(`static custom render ${shell}`)));
		expect(s.lines().join("\n")).not.toContain(`static custom render ${shell}`);
	}
	s.click(s.lines().findIndex((line: string) => line.startsWith("▏") && line.includes("real-control")));
	s.click(s.lines().findIndex((line: string) => line.includes("确认操作")));
	expect(clicked).toBe(1);
});

test("宿主的单色提示与状态行折入段内并计数，错误与混色文本仍是边界", async () => {
	const s = await scene();
	const note = (color: string, text: string) => {
		s.chat.addChild(new s.tui.Spacer(1));
		s.chat.addChild(new s.tui.Text(s.ui.theme.fg(color, text), 1, 0));
	};
	s.complete(s.tool("read", { path: "a.ts" }));
	const reply = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(reply);
	reply.updateContent({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "修好了" }] }, false);
	note("warning", "Cache miss after 8m idle: 63k tokens re-billed");
	note("warning", "Anthropic dropped 23 thinking blocks: prefix_binding_mismatch");
	note("dim", "Tool output: collapsed");
	let collapsed = s.lines().filter(Boolean);
	expect(collapsed).toHaveLength(2);
	expect(collapsed[0]).toMatch(/^✓ ⚠ Cache miss after 8m idle: 63k tokens re-billed\s*$/);
	expect(collapsed[1]).toContain("修好了");

	note("error", "Error: Request failed");
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(`${s.ui.theme.fg("dim", "ID:")} session-1`, 1, 0));
	s.complete(s.tool("read", { path: "b.ts" }));
	collapsed = s.lines().filter(Boolean);
	expect(collapsed.map((line: string) => line.trim())).toEqual([
		expect.stringMatching(/^✓ ⚠ Cache miss after 8m idle: 63k tokens re-billed$/), "修好了", "Error: Request failed", "ID: session-1",
		expect.stringMatching(/^✓$/),
	]);

	s.ui.setToolsExpanded(true);
	const expanded = s.lines().join("\n");
	for (const needle of ["Cache miss", "prefix_binding_mismatch", "Tool output: collapsed"]) expect(expanded).toContain(needle);
	// 摘要行带首条提示原文，列表里的提示在回复之后。
	expect(expanded.indexOf("修好了")).toBeLessThan(expanded.lastIndexOf("Cache miss"));
	s.ui.setToolsExpanded(false);
	expect(s.lines().filter(Boolean)).toHaveLength(5);

	s.chat.addChild(new s.host.UserMessageComponent("再问"));
	const plain = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(plain);
	plain.updateContent({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "直接回答" }] }, false);
	const before = s.lines().filter(Boolean);
	note("warning", "Cache miss: 20k tokens re-billed");
	const after = s.lines().filter(Boolean);
	expect(after.slice(0, before.length)).toEqual(before);
	expect(after.at(-1)).toContain("Cache miss");
	expect(after.join("\n")).not.toContain("过程");
});

const WORKER_RESULT = (name: string, body = "刷新改为单飞。更多细节") =>
	`<firecode_master_event>\n子代理 ${name} 已停下\n回复：\n${body}\n耗时：本次运行 8m · 当前任务 19m\n</firecode_master_event>`;

/** 宿主 addMessageToChat 在每条用户消息前先插一个 Spacer（空闲送达的信封用户消息也一样）。 */
function hostUser(s: any, text: string) {
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.host.UserMessageComponent(text));
}

function assistant(s: any, content: unknown[], stopReason = "stop") {
	const message = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(message);
	message.updateContent({ role: "assistant", stopReason, content }, false);
	return message;
}

test("空闲路径的信封用户消息不切段；展开后它与忙时 CustomMessage 都是一行 ↳，点击切换完整内容", async () => {
	const s = await scene();
	const { registerMasterEventRenderer } = await loadFirecodeModule("master/event-card.ts");
	let renderer: any;
	registerMasterEventRenderer({ registerMessageRenderer: (_type: string, render: unknown) => { renderer = render; } });
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, WORKER_RESULT("fix-auth"));
	s.complete(s.tool("read", { path: "b.ts" }));
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-master-event", content: WORKER_RESULT("lint-sweep", "清掉 4 处 lint。"), display: true, timestamp: 0 }, renderer));
	assistant(s, [{ type: "text", text: "全部收口" }]);

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.includes("开工"))).toHaveLength(1);
	expect(collapsed.filter((line: string) => /^✓$/.test(line))).toHaveLength(1);
	expect(collapsed.join("\n")).not.toMatch(/firecode_master_event|fix-auth|lint-sweep/);
	expect(collapsed.at(-1)).toBe("全部收口");

	s.ui.setToolsExpanded(true);
	let expanded = s.lines().map((line: string) => line.trim());
	// 机器消息一律一行，不平铺整张卡；两种形态同一行样式。
	expect(expanded).toContain("↳ fix-auth 已返回 · 8m 刷新改为单飞。");
	expect(expanded).toContain("↳ lint-sweep 已返回 · 8m 清掉 4 处 lint。");
	expect(expanded.join("\n")).not.toMatch(/firecode_master_event|当前任务/);
	const order = ["a.ts", "fix-auth", "b.ts", "lint-sweep", "全部收口"].map((needle) => expanded.findIndex((line: string) => line.includes(needle)));
	expect(order).toEqual([...order].sort((a, b) => a - b));

	// 点击该行切换完整正文（信封用户消息）或原生卡片（CustomMessage），与单工具行同一交互。
	for (const name of ["fix-auth", "lint-sweep"]) {
		const rowAt = () => s.lines().findIndex((line: string) => line.trim().startsWith(`↳ ${name}`));
		const countOpen = () => s.lines().filter((line: string) => line.includes("当前任务 19m")).length;
		const before = countOpen();
		s.click(rowAt());
		expect(countOpen()).toBe(before + 1);
		expect(s.lines().map((line: string) => line.trim())).toContain(`↳ ${name} 已返回 · 8m ${name === "fix-auth" ? "刷新改为单飞。" : "清掉 4 处 lint。"}`);
		s.click(rowAt());
		expect(countOpen()).toBe(before);
	}
	expanded = s.lines().map((line: string) => line.trim());
	expect(expanded.join("\n")).not.toMatch(/当前任务/);
});

test("review 结果卡在展开态同样是一行 ↳，点击展开原生卡片", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-review-card", content: "<firecode_review>\n审查通过\n共 2 轮，全部通过\n</firecode_review>", display: true, timestamp: 0 }));
	s.ui.setToolsExpanded(true);
	const row = "↳ 审查通过 共 2 轮，全部通过";
	expect(s.lines().map((line: string) => line.trim())).toContain(row);
	expect(s.lines().join("\n")).not.toContain("[firecode-review-card]");
	s.click(s.lines().findIndex((line: string) => line.trim() === row));
	expect(s.lines().join("\n")).toContain("[firecode-review-card]");
});

test("收尾统计这类 CustomEntry 属于本轮：不切段，其后的宿主提示照常折入摘要", async () => {
	const s = await scene();
	class Entry extends s.tui.Container {
		constructor(text: string) { super(); this.addChild(new s.tui.Spacer(1)); this.addChild(new s.tui.Text(text, 0, 0)); }
		hasContent() { return true; }
		setExpanded() {}
	}
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "修好了" }]);
	s.chat.addChild(new Entry("◷ 处理 3s"));
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", "Cache miss after 8m idle"), 1, 0));
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("dim", "Tool output: collapsed"), 1, 0));

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.startsWith("✓"))).toEqual(["✓ ⚠ Cache miss after 8m idle"]);
	expect(collapsed.slice(collapsed.findIndex((line: string) => line.startsWith("✓")) + 1)).toEqual(["修好了", "◷ 处理 3s"]);
	s.ui.setToolsExpanded(true);
	const expanded = s.lines().join("\n");
	for (const needle of ["a.ts", "修好了", "◷ 处理 3s", "Cache miss", "Tool output: collapsed"]) expect(expanded).toContain(needle);
});

test("一轮被唤起多次时，折叠态只留最后一条收尾统计行，更早的随过程折起，展开态按序都在", async () => {
	const s = await scene();
	class Entry extends s.tui.Container {
		constructor(text: string) { super(); this.addChild(new s.tui.Spacer(1)); this.addChild(new s.tui.Text(text, 0, 0)); }
		hasContent() { return true; }
		setExpanded() {}
	}
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "第一次回复" }]);
	s.chat.addChild(new Entry("◷ 处理 3s"));
	hostUser(s, WORKER_RESULT("fix-auth"));
	s.complete(s.tool("read", { path: "b.ts" }));
	assistant(s, [{ type: "text", text: "第二次回复" }]);
	s.chat.addChild(new Entry("◷ 处理 9s"));
	s.chat.addChild(new s.host.UserMessageComponent("下一问"));
	s.chat.addChild(new Entry("◷ 处理 1s"));

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.startsWith("◷"))).toEqual(["◷ 处理 9s", "◷ 处理 1s"]);
	expect(collapsed.indexOf("◷ 处理 9s")).toBeGreaterThan(collapsed.indexOf("第二次回复"));
	s.ui.setToolsExpanded(true);
	const expanded = s.lines().join("\n");
	const order = ["第一次回复", "◷ 处理 3s", "fix-auth", "第二次回复", "◷ 处理 9s"].map((needle) => expanded.indexOf(needle));
	expect(order.every((position) => position >= 0)).toBe(true);
	expect(order).toEqual([...order].sort((a, b) => a - b));
});

test.each([
	[0, ["全文收尾"]],
	[3, ["+2 条", "第 3 步。", "第 4 步。", "第 5 步。", "全文收尾"]],
])("replyLines=%i：折叠态中间回复取最近几条首句，更早的折成 +N 条，最后一条回复全文", async (replyLines, expected) => {
	const s = await scene({ replyLines });
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	for (let step = 1; step <= 5; step++) {
		assistant(s, [{ type: "text", text: `第 ${step} 步。细节${step}` }, { type: "toolCall", id: `c${step}`, name: "read", arguments: {} }], "toolUse");
		s.complete(s.tool("read", { path: `${step}.ts` }));
	}
	assistant(s, [{ type: "text", text: "全文收尾" }]);

	const lines = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(lines.filter((line: string) => line.includes("开工"))).toHaveLength(1);
	expect(lines.slice(lines.findIndex((line: string) => line.startsWith("✓")) + 1)).toEqual(expected);
	expect(lines.join("\n")).not.toContain("细节");
});

test("点击某一轮摘要只展开这一轮，ctrl+o 的全局档位不变", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("第一问"));
	s.complete(s.tool("read", { path: "first.ts" }));
	s.chat.addChild(new s.host.UserMessageComponent("第二问"));
	s.complete(s.tool("read", { path: "second.ts" }));
	const summaryAt = (nth: number) => s.lines().map((line: string, index: number) => [line, index] as const)
		.filter(([line]) => /^✓\s*$/.test(line))[nth][1];
	expect(s.lines().join("\n")).not.toMatch(/first\.ts|second\.ts/);

	s.click(summaryAt(0));
	expect(s.lines().join("\n")).toContain("first.ts");
	expect(s.lines().join("\n")).not.toContain("second.ts");
	expect(s.ui.getToolsExpanded()).toBe(false);
	s.click(summaryAt(0));
	expect(s.lines().join("\n")).not.toContain("first.ts");
});

test("逐轮展开只是相对全局档位的临时覆盖：ctrl+o 永远是全部展开/全部折叠", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("第一问"));
	s.complete(s.tool("read", { path: "first.ts" }));
	s.chat.addChild(new s.host.UserMessageComponent("第二问"));
	s.complete(s.tool("read", { path: "second.ts" }));
	const summaryAt = (nth: number) => s.lines().map((line: string, index: number) => [line, index] as const)
		.filter(([line]) => /^✓\s*$/.test(line))[nth][1];
	const shown = () => ["first.ts", "second.ts"].filter((name) => s.lines().join("\n").includes(name));

	// 点开第一轮 → ctrl+o 全局展开 → 再 ctrl+o 全局折叠：被点开的那一轮也折回去。
	s.click(summaryAt(0));
	expect(shown()).toEqual(["first.ts"]);
	s.ui.setToolsExpanded(true);
	expect(shown()).toEqual(["first.ts", "second.ts"]);
	s.ui.setToolsExpanded(false);
	expect(shown()).toEqual([]);

	// 全局展开时点击摘要，单独折起该轮；下一次全局切换清空这个覆盖。
	s.ui.setToolsExpanded(true);
	expect(shown()).toEqual(["first.ts", "second.ts"]);
	s.click(summaryAt(1));
	expect(shown()).toEqual(["first.ts"]);
	s.ui.setToolsExpanded(false);
	expect(shown()).toEqual([]);
	s.ui.setToolsExpanded(true);
	expect(shown()).toEqual(["first.ts", "second.ts"]);
});

test("被点开的机器消息卡也随全局档位切换复位", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-review-card", content: "<firecode_review>\n审查通过\n共 2 轮，全部通过\n</firecode_review>", display: true, timestamp: 0 }));
	s.ui.setToolsExpanded(true);
	s.click(s.lines().findIndex((line: string) => line.trim().startsWith("↳ 审查通过")));
	expect(s.lines().join("\n")).toContain("[firecode-review-card]");
	s.ui.setToolsExpanded(false);
	s.lines();
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).not.toContain("[firecode-review-card]");
	expect(s.lines().map((line: string) => line.trim())).toContain("↳ 审查通过 共 2 轮，全部通过");
});

/** 把会话进行中的事实喂给轮次时钟；歇下边沿由 busy.ts 触发 settle(本段时长)。 */
const feed = (s: any, agentRunning: boolean, inFlight = 0, since?: number) =>
	s.clock.sync({ agentRunning, inFlight, busy: agentRunning || inFlight > 0, since });

test("运行中的摘要只有当前动作不跳计时，子代理结果到达时短暂高亮已返回随后回到当前动作，落定后定格本段时长", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.setNow(1000);
	feed(s, true, 0, 1000);
	const bash = s.tool("bash", { command: "bun test" });
	s.setNow(6000);
	expect(s.lines().find((line: string) => line.includes("操作"))).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test\\s*$`));

	s.chat.addChild(new s.host.UserMessageComponent(WORKER_RESULT("fix-auth")));
	expect(s.lines().find((line: string) => line.includes("已返回"))).toMatch(new RegExp(`^${FLAME} fix-auth 已返回\\s*$`));
	s.setNow(9000);
	expect(s.lines().find((line: string) => line.includes("操作"))).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test\\s*$`));

	s.complete(bash);
	s.setNow(10000);
	feed(s, false);
	s.clock.settle(9000);
	s.setNow(20000);
	expect(s.lines().find((line: string) => line.startsWith("✓"))).toMatch(/^✓ 9.0s\s*$/);
});

test("review 的信封消息归入过程不切段", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, "<firecode_review>\n第 1 轮未通过，请修复。\n</firecode_review>");
	s.complete(s.tool("read", { path: "b.ts" }));
	const lines = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(lines.filter((line: string) => /^✓$/.test(line))).toHaveLength(1);
	expect(lines.join("\n")).not.toContain("firecode_review");
	s.ui.setToolsExpanded(true);
	expect(s.lines().map((line: string) => line.trim())).toContain("↳ 第 1 轮未通过，请修复。");
});

test("首句以冒号结尾时并入下一非空行：↳ 行与中间回复共用同一规则", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	assistant(s, [{ type: "text", text: "标准输出：\n\nhello world\n后面的细节" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], "toolUse");
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "Result:\nok" }, { type: "toolCall", id: "c2", name: "read", arguments: {} }], "toolUse");
	s.complete(s.tool("read", { path: "b.ts" }));
	hostUser(s, WORKER_RESULT("fix-auth", "命令已完成，完整输出：\n\ndone\n更多"));
	hostUser(s, WORKER_RESULT("lint", "output:\nok。其余"));
	assistant(s, [{ type: "text", text: "收口" }]);

	const collapsed = s.lines().map((line: string) => line.trim());
	expect(collapsed).toContain("标准输出：hello world");
	expect(collapsed).toContain("Result: ok");

	s.ui.setToolsExpanded(true);
	const expanded = s.lines().map((line: string) => line.trim());
	expect(expanded).toContain("↳ fix-auth 已返回 · 8m 命令已完成，完整输出：done");
	expect(expanded).toContain("↳ lint 已返回 · 8m output: ok。");
});

test("冒号并入下一行时跳过围栏行与空行；预览去掉行内 Markdown 标记", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	assistant(s, [{ type: "text", text: "说明：\n\n```\n**粗体** 与 `code` 与 [链接](http://x.test)\n```" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], "toolUse");
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, WORKER_RESULT("fix-auth", "命令输出：\n```text\ndone\n```\n**加粗**结尾"));
	assistant(s, [{ type: "text", text: "收口" }]);
	expect(s.lines().map((line: string) => line.trim())).toContain("说明：粗体 与 code 与 链接");
	s.ui.setToolsExpanded(true);
	expect(s.lines().map((line: string) => line.trim())).toContain("↳ fix-auth 已返回 · 8m 命令输出：done");
});

test("异常提醒：宿主提示原文按宽裁剪，与失败数同行；多条提示取首条", async () => {
	const s = await scene();
	const note = (text: string) => { s.chat.addChild(new s.tui.Spacer(1)); s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", text), 1, 0)); };
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	note("Cache miss after 8m idle: 63k tokens re-billed");
	note("Anthropic dropped 23 thinking blocks");
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✗ 1 次失败 · ⚠ Cache miss after 8m idle: 63k tokens re-billed\s*$/);
	const narrow = s.lines(30).filter(Boolean)[0];
	expect(narrow).toMatch(/^✗ 1 次失败 · ⚠ Cache m/);
	expect(s.tui.visibleWidth(narrow)).toBeLessThanOrEqual(30);
	expect(s.lines().join("\n")).not.toMatch(/[▸▾]/);
});

test("运行中摘要的目标按宽度先裁，动作词保留，放不下才丢目标", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	feed(s, true, 0, 0);
	s.tool("bash", { command: "bun test --coverage --reporter=junit" });
	const at = (width: number) => s.lines(width).find((line: string) => line.includes("操作"))!;
	expect(at(80)).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test --coverage --reporter=junit\\s*$`));
	const clipped = at(30);
	expect(clipped).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun.*…\\s*$`));
	expect(s.tui.visibleWidth(clipped)).toBeLessThanOrEqual(30);
	expect(at(10)).toMatch(new RegExp(`^${FLAME} 操作\\s*$`));
});

test("会话进行中：指挥官回合结束而有子代理在飞时摘要只剩火苗（状态与计时只在边框），全部落定才定格，耗时含等待", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("派活"));
	s.setNow(0);
	feed(s, true, 0, 0);
	s.complete(s.tool("read", { path: "a.ts" }));
	feed(s, true, 2, 0);
	s.setNow(20000);
	feed(s, false, 2, 0);
	s.setNow(65000);
	const summary = () => s.lines().filter(Boolean).find((line: string) => /^(✓|✗|[⠀-⣿])/.test(line))!;
	expect(summary()).toMatch(new RegExp(`^${FLAME}\\s*$`));

	// 结果送达唤醒：回到当前动作，仍是同一段。
	feed(s, false, 1, 0);
	expect(summary()).toMatch(new RegExp(`^${FLAME}\\s*$`));
	s.setNow(70000);
	feed(s, true, 1, 0);
	const bash = s.tool("bash", { command: "bun test" });
	expect(summary()).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test\\s*$`));

	// 最后一个子代理落定且指挥官歇下：定格，耗时含等待。
	s.complete(bash);
	feed(s, true, 0, 0);
	s.setNow(80000);
	feed(s, false, 0);
	s.clock.settle(80000);
	s.setNow(90000);
	expect(summary()).toMatch(/^✓ 1m20s\s*$/);
});

test("用户消息竖条不把 OSC 133 语义提示标记挤到行中：标记必须留在行首", async () => {
	// 终端（libghostty 等）把行中的 133;A 当 fresh-line 执行 CR+LF，会把后半行写到下一行留下残影。
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("第一段\n\n第二段"));
	assistant(s, [{ type: "text", text: "收到" }]);
	expect(s.chat.render(60).join("\n")).toContain("▌");
	const marked = s.chat.render(60).filter((line: string) => line.includes("\x1b]133;"));
	expect(marked.length).toBeGreaterThan(0);
	for (const line of marked) expect(line).toMatch(/^(?:\x1b\]133;[ABC]\x07)+/);
});
