import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { fakePi } from "./fake-pi.ts";
import { cleanupFirecodeModules, loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let dispose: (() => void) | undefined;
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	await cleanupFirecodeModules();
});

const FLAME = "[\u2800-\u28ff]";

async function scene(options: { withMaster?: boolean; scroll?: boolean } = {}) {
	const { withMaster = false } = options;
	const [host, tui, module, toolsModule, clockModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/index.ts"), loadFirecodeModule("tools/turn-clock.ts"),
	]);
	let now = 0;
	const clock = new (clockModule.TurnClock as any)(() => now);
	host.initTheme("dark");
	const { pi: api, tools, entryRenderers } = fakePi();
	toolsModule.registerToolRendering(api);
	if (withMaster) {
		const { registerMaster } = await loadFirecodeModule("master/index.ts");
		registerMaster(api);
	}
	const chat = new tui.Container();
	const root = new tui.Container();
	// 真实宿主（全屏模式）把聊天容器放在跟随末尾的 ScrollView 里。
	const scroll = options.scroll ? new tui.ScrollView(chat, { follow: "end", primary: true }) : undefined;
	root.addChild(scroll ?? chat);
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
	dispose = module.installGroupPatch(ui, { clock });
	const setNow = (value: number) => { now = value; };
	/** 宿主在歇下时把轮记录作为 CustomEntry 加进聊天树：Container(Spacer, 渲染器组件)，这里只模拟宿主的壳。 */
	const settle = (elapsed: number, outcome = "complete", at = now, tps?: number) => {
		const entry = new tui.Container();
		entry.addChild(new tui.Spacer(1));
		entry.addChild((entryRenderers.get("firecode-round") as Function)({ data: { elapsed, outcome, ...(tps ? { tps } : {}) }, timestamp: new Date(at).toISOString() }, { expanded: false }, ui.theme));
		(entry as any).hasContent = () => true;
		(entry as any).setExpanded = () => {};
		chat.addChild(entry);
		root.requestRender();
	};
	return { clock, setNow, settle, host, tui, chat, root, scroll, ui, tool, complete, lines, click, originalRender, originalRequestRender, renders: () => renders };
}

test("连续工具默认一行，原生全局展开只显示列表，单工具仍可点击查看正文", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
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
	feed(s, false);
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

test("摘要优先显示运行项，工具失败不计数、不画红叉，切档不改聊天树", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	const running = s.tool("bash", { command: "long-running" });
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	s.complete(s.tool("read", { path: "finished" }));
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 操作 \\$ long-running\\s*$`));
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
	feed(s, false);
	s.ui.setToolsExpanded(false);
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓\s*$/);
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

	// 上一段歇下（写了轮记录）之后的人类消息才开新一轮。
	s.settle(1_000, "complete", 0);
	s.setNow(60_000);
	s.chat.addChild(new s.host.UserMessageComponent("下一问"));
	s.complete(s.tool("read", { path: "c.ts" }));
	expect(s.lines().filter((line: string) => /^✓/.test(line))).toHaveLength(2);
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
	const options = { clock: s.clock };
	const oldDispose = module.installGroupPatch(s.ui, options);
	dispose = module.installGroupPatch(s.ui, options);
	oldDispose();
	s.complete(s.tool("read", { path: "a" }));
	s.complete(s.tool("read", { path: "b" }));
	expect(Container.prototype.addChild).toBe(addChild);
	expect(s.lines().filter((line: string) => /^✓\s*$/.test(line))).toHaveLength(1);
	const fake = fakePi();
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	registerToolRendering(fake.pi);
	void fake.fire("session_start", {}, { mode: "rpc" });
	void fake.fire("session_shutdown");
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	dispose?.();
	dispose = undefined;
	expect(s.chat.render).toBe(s.originalRender);
});

test("首条思考即显示过程状态，思考完成后摘要行留在原位，混合消息只藏思考，不改正文、原树或消息跳转标记", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	assistant.updateContent({ role: "assistant", content: [], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 思考中\\s*$`));
	assistant.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "第一段内部思考" }], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 思考中\\s*$`));
	assistant.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "第一段内部思考" }, { type: "text", text: "第一段" }], stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 回复中\\s*$`));
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
	feed(s, false);
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

test("思考期间异常和截断诊断不会被思考折叠吞掉", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	const assistant = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(assistant);
	const content = [{ type: "thinking", thinking: "不应直接显示的思考" }];
	assistant.updateContent({ role: "assistant", content, stopReason: "pending" }, true);
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 思考中\\s*$`));
	for (const [stopReason, diagnostic] of [["error", "Error: failed"], ["aborted", "failed"], ["length", "Response was truncated"]]) {
		assistant.updateContent({ role: "assistant", content, stopReason, errorMessage: "failed" }, false);
		expect(s.lines().join("\n")).toContain(diagnostic);
		expect(s.lines().join("\n")).not.toContain("不应直接显示的思考");
	}
});

test("真实子代理调用与池查询纳入过程组，保留原生动作和列表摘要，详情按需展开", async () => {
	const s = await scene({ withMaster: true });
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	s.complete(s.tool("read", { path: "a.ts" }));
	const start = s.tool("subagents", { action: "start", worker: "worker-one", role: "工程师", prompt: "检查实现" });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().filter(Boolean)[0]).toMatch(new RegExp(`^${FLAME} 子代理 启动 worker-one`));
	s.complete(start, "worker started");
	const list = s.tool("subagents_list", {});
	list.updateResult({ content: [{ type: "text", text: "raw pool result" }], isError: false, details: {
		workers: [{ name: "worker-one", role: "工程师", status: "working", model: "test/model", thinking: "low", currentAction: { kind: "tool", tool: "read", startedAt: Date.now() } }],
	} });
	feed(s, false);
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
	note("dim", "Thinking level: high");
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
	for (const needle of ["Cache miss", "prefix_binding_mismatch", "Thinking level: high"]) expect(expanded).toContain(needle);
	// 摘要行带首条提示原文，列表里的提示在回复之后。
	expect(expanded.indexOf("修好了")).toBeLessThan(expanded.lastIndexOf("Cache miss"));
	s.ui.setToolsExpanded(false);
	expect(s.lines().filter(Boolean)).toHaveLength(5);

	s.settle(1_000, "complete", 0);
	s.setNow(60_000);
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

/** Master 事件信封：正文第一行是给人看的标题“<名字> <结果词>”，落定类事件带“耗时：本次运行 …”。 */
const EVENT = (title: string, body: string, run = "8m") =>
	`<firecode_master_event>\n${title}\n${body}\n耗时：本次运行 ${run} · 当前任务 19m\n</firecode_master_event>`;
const WORKER_RESULT = (name: string, body = "刷新改为单飞。更多细节") => EVENT(`${name} 已返回`, `回复：\n${body}`);
const WORKER_FAILED = (name: string, error = "429 Too Many Requests") => EVENT(`${name} 失败`, `错误：\n${error}`, "2m");

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

test("轮记录是会话里的零行记录：摘要行落定读它显示整段耗时与终态，自己不占行，重载后依然有数；其后的宿主提示照常折入", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "修好了" }]);
	s.ui.setToolsExpanded(true);
	const rowsBefore = s.lines().length;
	s.settle(3_000, "complete", 0);
	expect(s.lines().length).toBe(rowsBefore);
	s.ui.setToolsExpanded(false);
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", "Cache miss after 8m idle"), 1, 0));
	s.setNow(60_000);

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.startsWith("✓"))).toEqual(["✓ 3.0s · ⚠ Cache miss after 8m idle"]);
	expect(collapsed.slice(collapsed.findIndex((line: string) => line.startsWith("✓")) + 1)).toEqual(["修好了"]);
	s.ui.setToolsExpanded(true);
	const expanded = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(expanded.filter((line: string) => line.startsWith("✓"))).toEqual(["✓ 3.0s · ⚠ Cache miss after 8m idle"]);
	expect(expanded.join("\n")).toContain("a.ts");

	// 中断与请求失败是终态，落定行红叉并写明。
	s.chat.addChild(new s.host.UserMessageComponent("再来"));
	s.complete(s.tool("read", { path: "b.ts" }));
	s.settle(12_000, "aborted", 60_000);
	s.chat.addChild(new s.host.UserMessageComponent("又来"));
	s.complete(s.tool("read", { path: "c.ts" }));
	s.settle(5_000, "error", 60_000);
	s.setNow(120_000);
	s.ui.setToolsExpanded(false);
	const marks = s.lines().filter(Boolean).map((line: string) => line.trim()).filter((line: string) => /^[✓✗]/.test(line));
	expect(marks).toEqual(["✓ 3.0s · ⚠ Cache miss after 8m idle", "✗ 已中断 · 12s", "✗ 请求失败 · 5.0s"]);
});

test("同一轮不经人类输入再次进行（命令触发）会有两条记录：耗时累加、终态取最后一条；新一轮的记录属于新一轮", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "第一次回复" }]);
	s.settle(3_000, "complete", 0);
	s.complete(s.tool("read", { path: "b.ts" }));
	assistant(s, [{ type: "text", text: "第二次回复" }]);
	s.settle(9_000, "complete", 0);
	s.chat.addChild(new s.host.UserMessageComponent("下一问"));
	s.complete(s.tool("read", { path: "c.ts" }));
	s.settle(1_000, "complete", 0);
	s.setNow(60_000);

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.startsWith("✓"))).toEqual(["✓ 12s", "✓ 1.0s"]);
	expect(collapsed.indexOf("✓ 12s")).toBeLessThan(collapsed.indexOf("第一次回复"));
});

test("一轮里先被 Esc 中断、又跑了一段（如 /fire-review）：不丢信息——耗时累加、终态取最后、更早的中断以“中断过 N 次”追加，多段不给均速", async () => {
	const s = await scene();
	hostUser(s, "写一篇散文");
	assistant(s, [{ type: "thinking", thinking: "构思" }, { type: "text", text: "冬天……" }], "aborted");
	s.settle(6_200, "aborted", 0);
	s.complete(s.tool("read", { path: "draft.md" }));
	assistant(s, [{ type: "text", text: "审查已通过。" }]);
	s.settle(326_000, "complete", 0, 77.9);
	s.setNow(600_000);
	const summary = s.lines().find((line: string) => /^[✓✗]/.test(line))!.trimEnd();
	expect(summary).toBe("✓ 5m32s · 中断过 1 次");
	expect(s.chat.render(100).join("\n")).toContain(s.ui.theme.fg("warning", "中断过 1 次"));
});

test("折叠态中间回复取最近 3 条首句，更早的折成 +N 条，最后一条回复全文", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	for (let step = 1; step <= 5; step++) {
		assistant(s, [{ type: "text", text: `第 ${step} 步。细节${step}` }, { type: "toolCall", id: `c${step}`, name: "read", arguments: {} }], "toolUse");
		s.complete(s.tool("read", { path: `${step}.ts` }));
	}
	assistant(s, [{ type: "text", text: "全文收尾" }]);

	const lines = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(lines.filter((line: string) => line.includes("开工"))).toHaveLength(1);
	expect(lines.slice(lines.findIndex((line: string) => line.startsWith("✓")) + 1)).toEqual(["+2 条", "第 3 步。", "第 4 步。", "第 5 步。", "全文收尾"]);
	expect(lines.join("\n")).not.toContain("细节");
});

test("点击某一轮摘要只展开这一轮，ctrl+o 的全局档位不变", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("第一问"));
	s.complete(s.tool("read", { path: "first.ts" }));
	s.settle(1_000, "complete", 0);
	s.setNow(60_000);
	s.chat.addChild(new s.host.UserMessageComponent("第二问"));
	s.complete(s.tool("read", { path: "second.ts" }));
	const summaryAt = (nth: number) => s.lines().map((line: string, index: number) => [line, index] as const)
		.filter(([line]) => /^✓/.test(line))[nth][1];
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
	s.settle(1_000, "complete", 0);
	s.setNow(60_000);
	s.chat.addChild(new s.host.UserMessageComponent("第二问"));
	s.complete(s.tool("read", { path: "second.ts" }));
	const summaryAt = (nth: number) => s.lines().map((line: string, index: number) => [line, index] as const)
		.filter(([line]) => /^✓/.test(line))[nth][1];
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

/** 把会话进行中的事实喂给轮次时钟；歇下边沿由 busy.ts 触发、tools 写入轮记录（见 scene 的 settle）。 */
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
	s.settle(9000, "complete", 10000, 58.13);
	s.setNow(20000);
	expect(s.lines().find((line: string) => line.startsWith("✓"))).toMatch(/^✓ 9.0s · 58.1 tps\s*$/);
});

test("纯文字轮也有落定行：有轮记录就画，显示耗时与均速；中断的轮没有均速", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("快问"));
	assistant(s, [{ type: "text", text: "快答" }]);
	s.settle(8_000, "complete", 0, 42);
	s.chat.addChild(new s.host.UserMessageComponent("再问"));
	assistant(s, [{ type: "text", text: "答到一半" }], "aborted");
	s.settle(3_000, "aborted", 0);
	s.setNow(60_000);
	const lines = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(lines.filter((line: string) => /^[✓✗]/.test(line))).toEqual(["✓ 8.0s · 42 tps", "✗ 已中断 · 3.0s"]);
	expect(lines.indexOf("✓ 8.0s · 42 tps")).toBeLessThan(lines.indexOf("快答"));
	expect(lines.indexOf("✗ 已中断 · 3.0s")).toBeLessThan(lines.indexOf("答到一半"));
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

test("异常提醒：宿主提示原文按宽裁剪；多条提示取首条；工具失败不影响标记", async () => {
	const s = await scene();
	const note = (text: string) => { s.chat.addChild(new s.tui.Spacer(1)); s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", text), 1, 0)); };
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	note("Cache miss after 8m idle: 63k tokens re-billed");
	note("Anthropic dropped 23 thinking blocks");
	expect(s.lines().filter(Boolean)[0]).toMatch(/^✓ ⚠ Cache miss after 8m idle: 63k tokens re-billed\s*$/);
	const narrow = s.lines(30).filter(Boolean)[0];
	expect(narrow).toMatch(/^✓ ⚠ Cache m/);
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
	s.settle(80000);
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

test("纯文字轮从开始到歇下摘要行一直在原位：思考中 → 回复中 → 落定，回复不跳", async () => {
	const s = await scene();
	hostUser(s, "你好");
	s.setNow(1000);
	feed(s, true, 0, 1000);
	const reply = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(reply);
	const frame = () => s.lines(60).map((line: string) => line.trimEnd());
	const summaryAt = (lines: string[]) => lines.findIndex((line) => /^(?:✓|✗|[⠀-⣿])/.test(line));

	reply.updateContent({ role: "assistant", stopReason: "pending", content: [] }, true);
	const first = frame();
	expect(first[summaryAt(first)]).toMatch(new RegExp(`^${FLAME} 思考中$`));

	reply.updateContent({ role: "assistant", stopReason: "pending", content: [{ type: "text", text: "你好，有什么" }] }, true);
	const streaming = frame();
	expect(summaryAt(streaming)).toBe(summaryAt(first));
	expect(streaming[summaryAt(streaming)]).toMatch(new RegExp(`^${FLAME} 回复中$`));
	const replyAt = streaming.findIndex((line) => line.includes("你好，有什么"));

	reply.updateContent({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "你好，有什么要做的？" }] }, false);
	const ended = frame();
	expect(summaryAt(ended)).toBe(summaryAt(first));
	expect(ended.findIndex((line) => line.includes("你好，有什么要做的？"))).toBe(replyAt);

	// 歇下边沿与轮记录写入在同一节拍内完成。
	s.setNow(3400);
	feed(s, false);
	s.settle(2400, "complete", 3400, 80);
	s.setNow(10_000);
	const settled = frame();
	expect(summaryAt(settled)).toBe(summaryAt(first));
	expect(settled[summaryAt(settled)]).toMatch(/^✓ 2\.4s · 80 tps$/u);
	expect(settled.findIndex((line) => line.includes("你好，有什么要做的？"))).toBe(replyAt);
});

test("当前动作只说正在发生的事：工具都完成后等模型是思考中，出正文是回复中，不再挂着已完成的工具", async () => {
	const s = await scene();
	hostUser(s, "看一下");
	feed(s, true, 0, 0);
	const summary = () => s.lines().find((line: string) => /^[⠀-⣿]/.test(line))!.trimEnd();
	const read = s.tool("read", { path: "/project/a.ts" });
	expect(summary()).toMatch(new RegExp(`^${FLAME} 读取 \\./a\\.ts$`));
	s.complete(read);
	expect(summary()).toMatch(new RegExp(`^${FLAME} 思考中$`));
	const reply = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	s.chat.addChild(reply);
	reply.updateContent({ role: "assistant", stopReason: "pending", content: [{ type: "text", text: "读完了，正在" }] }, true);
	expect(summary()).toMatch(new RegExp(`^${FLAME} 回复中$`));
});

test("审查卡与观察员的 ↳ 行：成败色由卡片 details 决定，预览取首条发现或原因，观察员只写建议原文", async () => {
	const s = await scene();
	const { buildCard } = await loadFirecodeModule("review/card.ts");
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts");
	const { adviceMessage } = await loadFirecodeModule("watcher/card.ts");
	// 与 review 生产端发卡一致：信封正文加卡片 details。
	const reviewCard = (card: unknown) => {
		const built = buildCard(card);
		s.chat.addChild(new s.host.CustomMessageComponent({
			role: "custom", customType: "firecode-review-card", content: wrapEnvelope("firecode_review", built.content), details: built.details, display: true, timestamp: 0,
		}));
	};
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	reviewCard({ kind: "fail", round: 1, details: "模型 1 · gpt-5.5\nFAIL\n## 发现 1：刷新竞态未修\n- **严重程度**: 高", advisor: null });
	reviewCard({ kind: "error", message: "所有审查者均未给出有效结论" });
	reviewCard({ kind: "pass", round: 2, summary: "模型 1 · gpt-5.5\nPASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=a.ts；命令=bun test", details: "", elapsedMs: 95_000 });
	s.chat.addChild(new s.host.CustomMessageComponent({
		role: "custom", customType: "firecode-watcher-note", display: true, timestamp: 0,
		content: adviceMessage({ note: "指挥官在没有跑测试的情况下宣布完成，建议先跑 bun test。", turnIndex: 12 }),
	}));
	s.ui.setToolsExpanded(true);

	const raw = s.chat.render(120);
	const rows = raw.map((line: string) => stripVTControlCharacters(line).trim()).filter((line: string) => line.startsWith("↳"));
	expect(rows).toEqual([
		"↳ 审查未通过 刷新竞态未修",
		"↳ 审查未完成 所有审查者均未给出有效结论",
		"↳ 第 2 轮审查通过 验证命令 exit 0，核心逻辑已核对。",
		"↳ 观察员 指挥官在没有跑测试的情况下宣布完成，建议先跑 bun test。",
	]);
	const red = s.ui.theme.fg("error", "↳");
	const toneOf = (needle: string) => raw.find((line: string) => line.includes(needle))!.includes(red);
	expect(["审查未通过", "审查未完成"].filter(toneOf)).toEqual(["审查未通过", "审查未完成"]);
	expect(["第 2 轮审查通过", "观察员"].filter(toneOf)).toEqual([]);
});

test("所有 Master 落定类事件都触发到达高亮，标题原样显示，失败为红", async () => {
	const s = await scene();
	hostUser(s, "开工");
	s.setNow(1000);
	feed(s, true, 0, 1000);
	s.tool("bash", { command: "bun test" });
	const summary = () => s.chat.render(100).find((line: string) => /^\x1b\[38;2;[\d;]+m[⠀-⣿]/.test(line))!;
	hostUser(s, EVENT("fix-auth 审查通过（2 轮）", "最终回复：\n完成。"));
	expect(stripVTControlCharacters(summary()).trimEnd()).toMatch(new RegExp(`^${FLAME} fix-auth 审查通过（2 轮）$`));
	s.setNow(5000);
	expect(stripVTControlCharacters(summary()).trimEnd()).toMatch(new RegExp(`^${FLAME} 操作 \\$ bun test$`));
	hostUser(s, WORKER_FAILED("perf-probe"));
	expect(stripVTControlCharacters(summary()).trimEnd()).toMatch(new RegExp(`^${FLAME} perf-probe 失败$`));
	// 到达文字从白色渐变到终色：失败的终色偏红，成功的偏金。
	s.setNow(7400);
	const [, r, g] = /38;2;(\d+);(\d+);\d+m[^\x1b]*perf-probe 失败/u.exec(summary())!.map(Number);
	expect(r - g).toBeGreaterThan(100);
});

test("折叠摘要行：这一轮有子代理失败时追加“N 个子代理失败”（红），与提示原文同一退让", async () => {
	const s = await scene();
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, WORKER_FAILED("perf-probe"));
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-master-event", content: WORKER_FAILED("lint"), display: true, timestamp: 0 }));
	hostUser(s, WORKER_FAILED("perf-probe", "又一次失败"));
	hostUser(s, WORKER_RESULT("fix-auth"));
	assistant(s, [{ type: "text", text: "收口" }]);
	s.settle(3_000, "complete", 0);
	s.setNow(60_000);
	const summary = (width = 100) => s.lines(width).find((line: string) => line.startsWith("✓"))!.trimEnd();
	expect(summary()).toBe("✓ 3.0s · 2 个子代理失败");
	expect(s.chat.render(100).join("\n")).toContain(s.ui.theme.fg("error", "2 个子代理失败"));
	expect(summary(20)).toBe("✓ 2 个子代理失败");

	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", "Cache miss after 8m idle"), 1, 0));
	expect(summary()).toBe("✓ 3.0s · 2 个子代理失败 · ⚠ Cache miss after 8m idle");
	for (const width of [24, 30, 40]) {
		const line = summary(width);
		expect(s.tui.visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).toContain("2 个子代理失败");
	}
});

test("展开态 ↳ 行与上一段正文之间空一行；折叠态中间回复与最后回复左边距一致", async () => {
	const s = await scene();
	hostUser(s, "开工");
	assistant(s, [{ type: "text", text: "先看看。" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], "toolUse");
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "全部通过。" }], "toolUse");
	hostUser(s, WORKER_RESULT("fix-auth"));
	assistant(s, [{ type: "text", text: "收口" }]);

	const folded = s.lines();
	const interim = folded.find((line: string) => line.includes("先看看。"))!;
	const final = folded.find((line: string) => line.includes("收口"))!;
	expect(interim.indexOf("先看看。")).toBe(final.indexOf("收口"));

	s.ui.setToolsExpanded(true);
	const expanded = s.lines();
	const body = expanded.findIndex((line: string) => line.includes("全部通过。"));
	expect(expanded[body + 1].trim()).toBe("");
	expect(expanded[body + 2].trim()).toStartWith("↳ fix-auth 已返回");
});

test("错误分节不在首位也判失败：回复分节在前时 ↳ 行仍为红、预览取错误原文、计入子代理失败数", async () => {
	const s = await scene();
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, EVENT("fix-auth 失败", "回复：\n部分回复\n错误：\n供应商错误", "2s"));
	assistant(s, [{ type: "text", text: "收口" }]);
	s.settle(3_000, "complete", 0);
	s.setNow(60_000);
	expect(s.lines().find((line: string) => line.startsWith("✓"))!.trimEnd()).toBe("✓ 3.0s · 1 个子代理失败");
	s.ui.setToolsExpanded(true);
	const row = s.chat.render(100).find((line: string) => stripVTControlCharacters(line).includes("fix-auth 失败"))!;
	expect(stripVTControlCharacters(row).trim()).toBe("↳ fix-auth 失败 · 2s 供应商错误");
	expect(row).toContain(s.ui.theme.fg("error", "↳"));
});

test("Master 真实产出的事件经信封投影到 ↳ 行、到达高亮与子代理失败计数：红色 = 失败 = 计数只由“错误：”决定，被中断不算失败，只有落定类事件高亮", async () => {
	const { masterEvent, withElapsed } = await loadFirecodeModule("master/event-format.ts");
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts");
	const event = (produced: unknown) => wrapEnvelope("firecode_master_event", withElapsed(produced, { run: 8 * 60_000, task: 19 * 60_000 }));
	const cases = [
		{ title: "fix-auth 已返回", body: masterEvent.returned("fix-auth", "刷新改为单飞。更多细节"), row: "↳ fix-auth 已返回 · 8m 刷新改为单飞。", red: false },
		{ title: "perf 失败", body: masterEvent.failed("perf", "429 Too Many Requests"), row: "↳ perf 失败 · 8m 429 Too Many Requests", red: true },
		{ title: "lint 被中断", body: masterEvent.interrupted("lint", false), row: "↳ lint 被中断 · 8m", red: false },
		{ title: "docs 审查通过（2 轮）", body: masterEvent.review("docs", { status: "passed", runId: "r", rounds: 2 }, "## 交付\n- 修好了。"), row: "↳ docs 审查通过（2 轮） · 8m 修好了。", red: false },
		{ title: "ui 审查停止（3 轮）", body: masterEvent.review("ui", { status: "stopped", runId: "r", rounds: 3, advisorAdvice: "收敛不了，交还用户。" }, "已停。"), row: "↳ ui 审查停止（3 轮） · 8m 审查 3 轮未通过，顾问叫停", red: true },
		{ title: "api 审查未完成", body: masterEvent.review("api", { status: "failed", runId: "r", rounds: 1, reason: "审查会话超时。" }, "实现完成。"), row: "↳ api 审查未完成 · 8m 审查会话超时。", red: true },
		{ title: undefined, body: masterEvent.modelSwitched("bench", "a/x/high", "b/y/high", "429"), row: "↳ bench 已切换模型", red: false },
	];
	const summaryOf = (s: any) => stripVTControlCharacters(s.chat.render(100).find((line: string) => /^\x1b\[38;2;[\d;]+m[⠀-⣿]/.test(line))!).trimEnd();
	for (const { title, body } of cases) {
		const s = await scene();
		hostUser(s, "开工");
		s.setNow(1000);
		feed(s, true, 0, 1000);
		s.tool("bash", { command: "bun test" });
		hostUser(s, event(body));
		// 非落定事件（模型切换）不高亮：摘要行仍是当前动作。
		expect(summaryOf(s)).toMatch(new RegExp(`^${FLAME} ${title?.replace(/[()（）]/gu, "\\$&") ?? "操作 \\$ bun test"}$`, "u"));
		dispose?.();
		dispose = undefined;
	}

	const s = await scene();
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	for (const { body } of cases) hostUser(s, event(body));
	assistant(s, [{ type: "text", text: "收口" }]);
	s.settle(3_000, "complete", 0);
	s.setNow(60_000);
	expect(s.lines().find((line: string) => line.startsWith("✓"))!.trimEnd()).toBe("✓ 3.0s · 3 个子代理失败");
	s.ui.setToolsExpanded(true);
	const raw = s.chat.render(120);
	const rows = raw.filter((line: string) => stripVTControlCharacters(line).trim().startsWith("↳"));
	expect(rows.map((line: string) => stripVTControlCharacters(line).trim())).toEqual(cases.map((entry) => entry.row));
	expect(rows.map((line: string) => line.includes(s.ui.theme.fg("error", "↳")))).toEqual(cases.map((entry) => entry.red));
});

test("摘要行“运行中”只认会话进行中：会话已歇下时残留的未完成工具行（如重载前被打断）不再点火苗", async () => {
	const s = await scene();
	hostUser(s, "开工");
	s.tool("bash", { command: "被打断的命令" });
	expect(s.lines().filter((line: string) => new RegExp(`^${FLAME}`).test(line))).toEqual([]);
	feed(s, true);
	expect(s.lines().find((line: string) => new RegExp(`^${FLAME} 操作`).test(line))).toBeDefined();
});

test("宿主组件形状不符时不安装过程分组：明确提示，聊天树保持原生渲染", async () => {
	const s = await scene();
	const message = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	// 模拟宿主升级后私有字段改名：助手消息不再有 isStreaming。
	delete (message as any).isStreaming;
	expect(() => s.chat.addChild(message)).toThrow(/过程分组已停用.*isStreaming/u);
	expect(s.chat.render).toBe(s.originalRender);
});

test("宿主形状不符出现在全局展开补丁里时同样整体退回原生：补丁还原并提示，不让宿主的展开操作抛适配异常", async () => {
	const host = await import(PI_CODING_AGENT_URL) as any;
	const pristine = host.CustomMessageComponent.prototype.setExpanded;
	const s = await scene();
	expect(host.CustomMessageComponent.prototype.setExpanded).not.toBe(pristine);
	const card = new s.host.CustomMessageComponent({ role: "custom", customType: "x", content: "正文", display: true, timestamp: 0 });
	// 模拟宿主升级后私有字段改名：自定义消息不再有 message。
	delete (card as any).message;
	let notice = "";
	try {
		card.setExpanded(true);
	} catch (error) {
		notice = String(error);
	}
	expect(notice).toMatch(/过程分组已停用.*message/u);
	expect(host.CustomMessageComponent.prototype.setExpanded).toBe(pristine);
});

test("补话不切轮：与上一条人类消息之间没有轮记录的人类消息折进当前轮，折叠态与展开态都是带竖条的全文、上下留白；歇下之后的人类消息才开新一轮", async () => {
	const s = await scene();
	hostUser(s, "原问题");
	s.setNow(0);
	feed(s, true, 0, 0);
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "先看看。" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], "toolUse");
	hostUser(s, "补一句：顺便说下几点\n第二行细节");
	const bash = s.tool("bash", { command: "date" });
	const summaries = () => s.lines().filter((line: string) => /^(?:✓|✗|[⠀-⣿])/.test(line));
	expect(summaries()).toHaveLength(1);
	expect(summaries()[0]).toMatch(new RegExp(`^${FLAME} 操作 \\$ date`));
	s.complete(bash);
	assistant(s, [{ type: "text", text: "现在十点。" }]);
	feed(s, false);
	s.settle(5_000, "complete", 0);
	s.setNow(60_000);

	const all = s.lines().map((line: string) => line.trimEnd());
	const folded = all.filter(Boolean);
	expect(folded.filter((line: string) => /^✓/.test(line))).toEqual(["✓ 5.0s"]);
	const at = (needle: string) => folded.findIndex((line: string) => line.includes(needle));
	// 补话是人类原话：与普通用户消息同样的竖条全文，不截成首句。
	expect(folded[at("补一句")]).toBe("▌ 补一句：顺便说下几点");
	expect(folded[at("第二行细节")]).toBe("▌ 第二行细节");
	expect([at("原问题"), at("✓ 5.0s"), at("先看看。"), at("补一句"), at("第二行细节"), at("现在十点。")])
		.toEqual([at("原问题"), at("✓ 5.0s"), at("先看看。"), at("补一句"), at("第二行细节"), at("现在十点。")].sort((a, b) => a - b));
	const row = (needle: string) => all.findIndex((line: string) => line.includes(needle));
	// 上下留白：与前一条中间回复、后一条回复之间都至少隔一行空白。
	expect(all.slice(row("先看看。") + 1, row("补一句")).some((line: string) => !line.replace(/▌/u, "").trim())).toBe(true);
	expect(all.slice(row("第二行细节") + 1, row("现在十点。")).some((line: string) => !line.replace(/▌/u, "").trim())).toBe(true);

	s.click(s.lines().findIndex((line: string) => line.startsWith("✓")));
	const expanded = s.lines().join("\n");
	const order = ["原问题", "a.ts", "先看看。", "补一句", "第二行细节", "date", "现在十点。"].map((needle) => expanded.indexOf(needle));
	expect(order.every((position) => position >= 0)).toBe(true);
	expect(order).toEqual([...order].sort((a, b) => a - b));

	hostUser(s, "新问题");
	s.complete(s.tool("read", { path: "c.ts" }));
	expect(s.lines().filter((line: string) => /^✓/.test(line))).toHaveLength(2);
});

test("回合一开始就有摘要行：首条用户消息一出现就带橙色竖条，助手组件还没来时已显示思考中", async () => {
	const s = await scene();
	s.setNow(0);
	feed(s, true, 0, 0);
	hostUser(s, "你好");
	const lines = s.lines().map((line: string) => line.trimEnd()).filter(Boolean);
	expect(lines[0]).toBe("▌ 你好");
	expect(lines[1]).toMatch(new RegExp(`^${FLAME} 思考中$`));
});

test("点击摘要展开或收起时被点的行留在视口内；原本跟随末尾的之后恢复跟随、新输出看得到，原本已上滚的保持不动", async () => {
	const s = await scene({ scroll: true });
	for (let turn = 1; turn <= 4; turn++) {
		hostUser(s, `问题${turn}`);
		for (const name of ["a", "b", "c"]) s.complete(s.tool("read", { path: `${name}${turn}.ts` }));
		assistant(s, [{ type: "text", text: `回答${turn}` }]);
		s.settle(1_000, "complete", 0);
	}
	s.setNow(60_000);
	const VIEWPORT = 10;
	const layout = () => s.scroll.updateLayout(s.chat.render(100).length, VIEWPORT, () => {});
	const visible = (row: number) => row >= s.scroll.scrollTop && row < s.scroll.scrollTop + VIEWPORT;
	layout();
	expect(s.scroll.isFollowingEnd).toBe(true);
	const row = s.lines().findLastIndex((line: string) => line.startsWith("✓"));
	s.click(row);
	layout();
	expect(s.lines()[row]).toMatch(/^✓/);
	expect(visible(row)).toBe(true);
	// 新输出到达：恢复跟随末尾。
	hostUser(s, "下一问");
	s.complete(s.tool("read", { path: "z.ts" }));
	layout();
	expect(s.scroll.isFollowingEnd).toBe(true);
	expect(s.scroll.scrollTop).toBe(s.chat.render(100).length - VIEWPORT);

	// 已上滚：点击与新输出都不动视口。
	s.scroll.scrollTo(3, { disableFollow: true });
	layout();
	const up = s.lines().findIndex((line: string, index: number) => index >= 3 && line.startsWith("✓"));
	s.click(up);
	layout();
	expect(s.scroll.scrollTop).toBe(3);
	s.complete(s.tool("read", { path: "y.ts" }));
	layout();
	expect(s.scroll.scrollTop).toBe(3);
});

test("内容不足一屏时点开一轮、展开后超出视口：被点的摘要行仍在视口内，之后新输出恢复跟随", async () => {
	const s = await scene({ scroll: true });
	hostUser(s, "问题");
	for (let index = 0; index < 20; index++) s.complete(s.tool("read", { path: `f${index}.ts` }));
	assistant(s, [{ type: "text", text: "回答" }]);
	s.settle(1_000, "complete", 0);
	s.setNow(60_000);
	const VIEWPORT = 10;
	const layout = () => s.scroll.updateLayout(s.chat.render(100).length, VIEWPORT, () => {});
	layout();
	expect(s.chat.render(100).length).toBeLessThan(VIEWPORT);
	const row = s.lines().findIndex((line: string) => line.startsWith("✓"));
	s.click(row);
	layout();
	expect(s.chat.render(100).length).toBeGreaterThan(VIEWPORT);
	expect(s.lines()[row]).toMatch(/^✓/);
	expect(row >= s.scroll.scrollTop && row < s.scroll.scrollTop + VIEWPORT).toBe(true);
	s.complete(s.tool("read", { path: "z.ts" }));
	layout();
	expect(s.scroll.isFollowingEnd).toBe(true);
});

test("宿主对 ctrl+o 的回显“Tool output: expanded/collapsed”不进对话；其余宿主状态行照常折入", async () => {
	const s = await scene();
	const note = (color: string, text: string) => {
		s.chat.addChild(new s.tui.Spacer(1));
		s.chat.addChild(new s.tui.Text(s.ui.theme.fg(color, text), 1, 0));
	};
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "好了" }]);
	s.settle(1_000, "complete", 0);
	note("dim", "Tool output: expanded");
	note("dim", "Thinking level: high");
	note("dim", "Tool output: collapsed");
	for (const expanded of [false, true]) {
		s.ui.setToolsExpanded(expanded);
		const text = s.lines().join("\n");
		expect(text).not.toContain("Tool output");
		if (expanded) expect(text).toContain("Thinking level: high");
	}
	hostUser(s, "下一问");
	note("dim", "Tool output: expanded");
	expect(s.lines().join("\n")).not.toContain("Tool output");
});

test("收尾不拼帧：歇下那一刻摘要行直接是 ✓ 加定格文字，不再先出一帧冷却中的火苗", async () => {
	const s = await scene();
	hostUser(s, "开工");
	s.setNow(1_000);
	feed(s, true, 0, 1_000);
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "好了" }]);
	feed(s, false);
	s.settle(3_000, "complete", 1_000, 40);
	for (const now of [1_000, 1_050, 1_200]) {
		s.setNow(now);
		expect(s.lines().find((line: string) => line.includes("3.0s"))).toMatch(/^✓ 3\.0s · 40 tps/u);
	}
});

test("截断的聊天行在宿主滚动条那一列之前闭合颜色并留一格空：宿主按列切掉末列画滚动条时不丢颜色复位", async () => {
	const { sliceByColumn } = await import(PI_TUI_URL);
	const s = await scene();
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	hostUser(s, WORKER_RESULT("fix-auth", "这是一段很长很长的结果说明，".repeat(8)));
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.tui.Text(s.ui.theme.fg("warning", "Cache miss after 8m idle: 63k tokens re-billed and more and more text"), 1, 0));
	assistant(s, [{ type: "text", text: "收口" }]);
	s.settle(3_000, "complete", 0);
	s.setNow(60_000);
	const width = 60;
	const kept = (needle: string) => {
		const row = s.chat.render(width).find((line: string) => stripVTControlCharacters(line).includes(needle))!;
		expect(stripVTControlCharacters(row)).toContain("…");
		// 宿主画滚动条时只保留前 width-1 列。
		return sliceByColumn(row, 0, width - 1, true);
	};
	const summary = kept("✓ 3.0s");
	expect(summary.endsWith("\x1b[39m")).toBe(true);
	expect(s.tui.visibleWidth(stripVTControlCharacters(summary))).toBeLessThanOrEqual(width - 2);
	s.ui.setToolsExpanded(true);
	const machine = kept("↳ fix-auth");
	expect(machine.endsWith("\x1b[39m")).toBe(true);
	expect(s.tui.visibleWidth(stripVTControlCharacters(machine))).toBeLessThanOrEqual(width - 2);
});

test("折叠态按时间顺序：每条补话之后跟它那一段的中间回复首句，“+N 条”在各自段内，补话之间不空出多余的行", async () => {
	const s = await scene();
	const interim = (text: string, id: string) => {
		assistant(s, [{ type: "text", text }, { type: "toolCall", id, name: "read", arguments: {} }], "toolUse");
		s.complete(s.tool("read", { path: `${id}.ts` }));
	};
	hostUser(s, "原问题");
	interim("回复甲。", "a");
	interim("回复乙。", "b");
	hostUser(s, "补话一");
	interim("回复丙。", "c");
	interim("回复丁。", "d");
	interim("回复戊。", "e");
	interim("回复庚。", "g");
	hostUser(s, "补话二");
	interim("回复己。", "f");
	assistant(s, [{ type: "text", text: "最终回复。" }]);
	s.settle(5_000, "complete", 0);
	s.setNow(60_000);

	const all = s.lines().map((line: string) => line.trimEnd());
	expect(all.filter((line: string) => line.replace(/▌/u, "").trim()).map((line: string) => line.trim())).toEqual([
		"▌ 原问题", "✓ 5.0s", "回复甲。", "回复乙。",
		"▌ 补话一", "+1 条", "回复丁。", "回复戊。", "回复庚。",
		"▌ 补话二", "回复己。",
		"最终回复。",
	]);
	// 留白与其他节点一致：人类消息的上下内边距加一行间隔，最多连续两行空白。
	let blank = 0;
	for (const line of all) {
		blank = line.replace(/▌/u, "").trim() ? 0 : blank + 1;
		expect(blank).toBeLessThanOrEqual(2);
	}
});

test("用户消息竖条上下不保留宿主的底色内边距空行：竖条从第一行正文开始、到最后一行正文结束，前后是普通间隔", async () => {
	const s = await scene();
	hostUser(s, "第一段\n\n第二段");
	s.complete(s.tool("read", { path: "a.ts" }));
	const raw = s.chat.render(60);
	const plain = raw.map((line: string) => stripVTControlCharacters(line));
	const first = plain.findIndex((line: string) => line.startsWith("▌"));
	const last = plain.findLastIndex((line: string) => line.startsWith("▌"));
	expect(plain[first]).toContain("第一段");
	expect(plain[last]).toContain("第二段");
	expect(plain[first - 1]).toBe("");
	expect(plain[last + 1]).toBe("");
	// OSC 133 语义标记仍在消息的第一行行首。
	expect(raw[first]).toMatch(/^(?:\x1b\]133;[ABC]\x07)+/u);
});
