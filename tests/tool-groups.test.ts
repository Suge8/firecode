import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let dispose: (() => void) | undefined;
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	await cleanupFirecodeModules();
});

async function scene(withMaster = false) {
	const [host, tui, module, toolsModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/index.ts"),
	]);
	host.initTheme("dark");
	const tools = new Map<string, any>();
	const api = { on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {} };
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
		theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
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
	dispose = module.installGroupPatch(ui);
	return { host, tui, chat, root, ui, tool, complete, lines, click, originalRender, originalRequestRender, renders: () => renders };
}

test("连续工具默认一行，原生全局展开只显示列表，单工具仍可点击查看正文", async () => {
	const s = await scene();
	const read = s.tool("read", { path: "/project/a.ts" });
	s.complete(read);
	const bash = s.tool("bash", { command: "bun test" });
	const summary = s.lines().filter(Boolean);
	expect(summary).toHaveLength(1);
	expect(summary[0]).toMatch(/^▏ ✦ 操作 \$ bun test\s+读取 1 · 操作 1\s*$/);
	expect(summary.join("\n")).not.toContain("private full result");

	s.ui.setToolsExpanded(true);
	expect(s.lines().filter(Boolean)).toHaveLength(2);
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
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✓ 操作 \$ bun test\s+读取 1 · 操作 1\s*$/);
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
	expect(s.lines().join("\n")).toContain("读取 2");

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
	expect(s.lines().filter((line: string) => line.includes("读取 1"))).toHaveLength(2);
	s.chat.children.splice(index, 1);
	expect(s.lines().join("\n")).toContain("读取 2");
});

test("摘要优先显示运行项且保留失败，切档不改聊天树", async () => {
	const s = await scene();
	const running = s.tool("bash", { command: "long-running" });
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	s.complete(s.tool("read", { path: "finished" }));
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✦ 操作 \$ long-running · 1 次失败\s+操作 1 · 读取 2\s*$/);
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
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✗ 操作 \$ long-running · 1 次失败\s+操作 1 · 读取 2\s*$/);
	expect(s.lines(40).filter(Boolean)[0]).toMatch(/^▏ ✗ 操作 \$ long-running · 1 次失败\s*$/);
	expect(s.lines(26).filter(Boolean)[0]).toMatch(/^▏ ✗ 操作 \$ l… · 1 次失败$/);
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
	expect(collapsed).toHaveLength(2);
	expect(collapsed[0]).toMatch(/^▏ ✓ 读取 b\.ts\s+读取 3 · 操作 1\s*$/);
	expect(collapsed[1]).toContain("修好了");
	expect(collapsed.join("\n")).not.toMatch(/先看一下|fix-auth 完成|image payload/);

	s.chat.addChild(new s.host.UserMessageComponent("下一问"));
	s.complete(s.tool("read", { path: "c.ts" }));
	expect(s.lines().filter((line: string) => line.includes("读取 3 · 操作 1"))).toHaveLength(1);
	expect(s.lines().filter((line: string) => /读取 1\s*$/.test(line))).toHaveLength(1);
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
	const oldDispose = module.installGroupPatch(s.ui);
	dispose = module.installGroupPatch(s.ui);
	oldDispose();
	s.complete(s.tool("read", { path: "a" }));
	s.complete(s.tool("read", { path: "b" }));
	expect(Container.prototype.addChild).toBe(addChild);
	expect(s.lines().join("\n")).toContain("读取 2");
	const events = new Map<string, Function>();
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	registerToolRendering({ on: (name: string, handler: Function) => events.set(name, handler), registerTool() {}, registerCommand() {} });
	events.get("session_start")!({}, { mode: "rpc" });
	events.get("session_shutdown")!();
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	dispose?.();
	dispose = undefined;
	expect(s.chat.render).toBe(s.originalRender);
});

test("首条思考即显示过程状态，混合消息只藏思考，不改正文、原树或消息跳转标记", async () => {
	const s = await scene();
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	assistant.updateContent({ role: "assistant", content: [], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✦ 处理中\s*$/);
	assistant.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "第一段内部思考" }], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✦ 思考中\s*$/);
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
});

test("思考期间仍保留已有工具失败，异常和截断诊断不会被思考折叠吞掉", async () => {
	const s = await scene();
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	const content = [{ type: "thinking", thinking: "不应直接显示的思考" }];
	assistant.updateContent({ role: "assistant", content, stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^▏ ✦ 思考中 · 1 次失败\s+读取 1\s*$/);
	for (const [stopReason, diagnostic] of [["error", "Error: failed"], ["aborted", "failed"], ["length", "Response was truncated"]]) {
		assistant.updateContent({ role: "assistant", content, stopReason, errorMessage: "failed" }, false);
		expect(s.lines().join("\n")).toContain(diagnostic);
		expect(s.lines().join("\n")).not.toContain("不应直接显示的思考");
	}
});

test("真实子代理调用与池查询纳入过程组，保留原生动作和列表摘要，详情按需展开", async () => {
	const s = await scene(true);
	s.complete(s.tool("read", { path: "a.ts" }));
	const start = s.tool("subagents", { action: "start", worker: "worker-one", role: "工程师", prompt: "检查实现" });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().join("\n")).toContain("读取 1 · 子代理 1");
	expect(s.lines().join("\n")).toContain("启动 worker-one");
	s.complete(start, "worker started");
	const list = s.tool("subagents_list", {});
	list.updateResult({ content: [{ type: "text", text: "raw pool result" }], isError: false, details: {
		workers: [{ name: "worker-one", role: "工程师", status: "working", model: "test/model", thinking: "low", currentAction: { kind: "tool", tool: "read", startedAt: Date.now() } }],
	} });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().join("\n")).toContain("读取 1 · 子代理 2");
	expect(s.lines().join("\n")).toContain("查看");
	expect(s.lines().join("\n")).toContain("worker-one");
	s.ui.setToolsExpanded(true);
	expect(s.lines().filter(Boolean)).toHaveLength(3);
	expect(s.lines().join("\n")).toContain("启动 worker-one");
	expect(s.lines().join("\n")).toContain("池 1");
	const queryLine = s.lines().findIndex((line: string) => line.includes("查看"));
	s.click(queryLine);
	expect(s.lines().join("\n")).toContain("model/low");
	expect(s.lines().join("\n")).toContain("read");
	s.click(queryLine);
	expect(s.lines().filter(Boolean)).toHaveLength(3);
	s.ui.setToolsExpanded(false);
	for (const [action, label] of [["send", "发送"], ["interrupt", "中断"], ["review", "审查"], ["tail", "近况"], ["ack", "待命"], ["kill", "移除"]]) {
		s.complete(s.tool("subagents", { action, worker: "worker-one", prompt: "继续" }));
		expect(s.lines().filter(Boolean)).toHaveLength(1);
		expect(s.lines().join("\n")).toContain(`${label} worker-one`);
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
	expect(s.lines().join("\n")).toContain("custom-self 1 · custom-default 1 · real-control 1");
	s.ui.setToolsExpanded(true);
	for (const shell of ["self", "default"]) {
		s.click(s.lines().findIndex((line: string) => line.includes(`custom-${shell}`)));
		expect(s.lines().join("\n")).toContain(`static custom render ${shell}`);
		s.click(s.lines().findIndex((line: string) => line.includes(`static custom render ${shell}`)));
		expect(s.lines().join("\n")).not.toContain(`static custom render ${shell}`);
	}
	s.click(s.lines().findIndex((line: string) => line.includes("real-control")));
	s.click(s.lines().findIndex((line: string) => line.includes("确认操作")));
	expect(clicked).toBe(1);
});
