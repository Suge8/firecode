import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let dispose: (() => void) | undefined;
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	await cleanupFirecodeModules();
});

async function scene() {
	const [host, tui, module, toolsModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/index.ts"),
	]);
	host.initTheme("dark");
	const tools = new Map<string, any>();
	toolsModule.registerToolRendering({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {} });
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
	expect(summary[0]).toContain("调用 2 次");
	expect(summary[0]).toContain("1 个运行中");
	expect(summary[0]).toContain("bun test");
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
	expect(s.lines().join("\n")).not.toContain("运行中");
	dispose?.();
	dispose = undefined;
	expect(s.chat.render).toBe(s.originalRender);
	expect(s.root.requestRender).toBe(s.originalRequestRender);
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("private full result");
});

test("空助手消息不拆组，折叠思考、通知和迟到插入仍保留正确边界", async () => {
	const s = await scene();
	const first = s.tool("read", { path: "a" });
	s.complete(first);
	const empty = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	empty.updateContent({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] });
	s.chat.addChild(empty);
	const second = s.tool("read", { path: "b" });
	s.complete(second);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().join("\n")).toContain("调用 2 次");

	empty.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "需要检查另一处" }] });
	expect(s.lines().filter((line: string) => line.includes("调用 1 次"))).toHaveLength(2);
	const index = s.chat.children.indexOf(empty);
	s.chat.children[index] = new s.tui.Text("审查已完成", 0, 0);
	expect(s.lines().join("\n")).toContain("审查已完成");
	expect(s.lines().filter((line: string) => line.includes("调用 1 次"))).toHaveLength(2);
	s.chat.children.splice(index, 1);
	expect(s.lines().join("\n")).toContain("调用 2 次");
});

test("摘要优先显示运行项且保留失败，图片和自渲染工具独立，切档不改聊天树", async () => {
	const s = await scene();
	const running = s.tool("bash", { command: "long-running" });
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	s.complete(s.tool("read", { path: "finished" }));
	const summary = s.lines().join("\n");
	expect(summary).toContain("调用 3 次");
	expect(summary).toContain("1 次失败");
	expect(summary).toContain("long-running");
	const image = s.tool("read", { path: "image.png" });
	image.updateResult({ content: [{ type: "image", data: "", mimeType: "image/png" }], isError: false });
	const custom = s.tool("interactive", {}, {
		name: "interactive", label: "interactive", renderShell: "self",
		renderCall: () => new s.tui.Text("交互区域", 0, 0),
	});
	s.complete(custom);
	s.complete(s.tool("read", { path: "last" }));
	const originalChildren = [...s.chat.children];
	expect(s.lines().join("\n")).toContain("交互区域");
	expect(s.lines().join("\n")).toContain("image.png");
	expect(s.lines().join("\n")).toContain("调用 1 次");
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("ENOENT");
	expect(s.chat.children).toEqual(originalChildren);
	s.chat.children = originalChildren.slice(0, 3);
	for (const expanded of [false, true]) {
		s.ui.setToolsExpanded(expanded);
		for (const width of [1, 12, 40, 100])
			for (const line of s.lines(width)) expect(s.tui.visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	s.complete(running);
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
	expect(s.lines().join("\n")).toContain("调用 2 次");
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
