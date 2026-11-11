import { afterEach, expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let dispose: (() => void) | undefined;
afterEach(async () => {
	dispose?.();
	dispose = undefined;
	setSystemTime();
});

async function scene(options: { scroll?: boolean } = {}) {
	const [host, tui, module, toolsModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/index.ts"),
	]);
	setSystemTime(new Date(0));
	// 会话进行中的快照由测试直接喂（生产里取自 busy.ts）。
	let busy: Record<string, unknown> = { agentRunning: false, inFlight: 0, review: undefined, busy: false };
	const groupOptions = { busy: () => busy };
	const feedBusy = (view: Record<string, unknown>) => { busy = view; };
	host.initTheme("dark");
	const { pi: api, tools, entryRenderers, resolveToolRenderers } = fakePi();
	toolsModule.registerToolRendering(api);
	const chat = new tui.Container();
	const root = new tui.Container();
	// 真实宿主（全屏模式）把聊天容器放在跟随末尾的 ScrollView 里。
	const scroll = options.scroll ? new tui.ScrollView(chat, { follow: "end", primary: true }) : undefined;
	root.addChild(scroll ?? chat);
	let expanded = false;
	root.requestRender = () => {};
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
	const tool = (name: string, args: Record<string, unknown>, definition = resolveToolRenderers(name, tools.get(name))) => {
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
	dispose = module.installGroupPatch(ui, groupOptions);
	const setNow = (value: number) => setSystemTime(new Date(value));
	/** 宿主的整行单色文本（提示、状态行）：前面先插一个 Spacer。 */
	const note = (color: string, text: string) => {
		chat.addChild(new tui.Spacer(1));
		chat.addChild(new tui.Text(ui.theme.fg(color, text), 1, 0));
	};
	const blankAssistant = () => {
		const message = new host.AssistantMessageComponent(undefined, true, host.getMarkdownTheme());
		chat.addChild(message);
		return message;
	};
	/** 宿主在歇下时把轮记录作为 CustomEntry 加进聊天树：Container(Spacer, 渲染器组件)，这里只模拟宿主的壳。 */
	const settle = (elapsed: number, outcome = "complete", at = Date.now(), tps?: number) => {
		const entry = new tui.Container();
		entry.addChild(new tui.Spacer(1));
		entry.addChild((entryRenderers.get("firecode-round") as Function)({ data: { elapsed, outcome, ...(tps ? { tps } : {}) }, timestamp: new Date(at).toISOString() }, { expanded: false }, ui.theme));
		(entry as any).hasContent = () => true;
		(entry as any).setExpanded = () => {};
		chat.addChild(entry);
		root.requestRender();
	};
	return { feedBusy, setNow, note, blankAssistant, settle, host, tui, chat, root, scroll, ui, tool, complete, lines, click, originalRender };
}

test("连续工具默认一行，原生全局展开只显示列表，单工具仍可点击查看正文", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	const read = s.tool("read", { path: "/project/a.ts" });
	s.complete(read);
	const bash = s.tool("bash", { command: "bun test" });
	expect(s.lines().filter(Boolean)).toHaveLength(1);
	expect(s.lines().join("\n")).not.toContain("private full result");

	s.ui.setToolsExpanded(true);
	expect(s.lines().filter(Boolean)).toHaveLength(3);
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
	dispose?.();
	dispose = undefined;
	s.ui.setToolsExpanded(true);
	expect(s.lines().join("\n")).toContain("private full result");
});

test("思考与工具合成过程组，展开恢复原生思考", async () => {
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
});

test("用户消息之间的整段过程折成一行：图片、中途正文与模型收件折入，段尾回复可见，展开态按原序", async () => {
	const s = await scene();
	const assistant = s.blankAssistant;
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

test("混合消息只藏思考，不改正文", async () => {
	const s = await scene();
	const assistant = s.blankAssistant();
	const message = {
		role: "assistant", stopReason: "stop", content: [
			{ type: "thinking", thinking: "第一段内部思考" },
			{ type: "text", text: "第一段正式回复" },
			{ type: "thinking", thinking: "第二段内部思考" },
			{ type: "text", text: "**第二段正式回复**" },
		],
	};
	assistant.updateContent(message, false);
	const collapsed = s.lines().join("\n");
	expect(collapsed).toContain("第一段正式回复");
	expect(collapsed).toContain("第二段正式回复");
	expect(collapsed).not.toMatch(/内部思考|Thinking|✦/);
	expect(collapsed.indexOf("第一段正式回复")).toBeLessThan(collapsed.indexOf("第二段正式回复"));
	s.ui.setToolsExpanded(true);
	assistant.setHideThinkingBlock(false);
	expect(s.lines().join("\n")).toContain("第一段内部思考");
	expect(s.lines().join("\n")).toContain("第二段内部思考");
	s.ui.setToolsExpanded(false);
	expect(s.lines().join("\n")).toBe(collapsed);
});

test("思考期间异常和截断诊断不会被思考折叠吞掉", async () => {
	const s = await scene();
	// 摘要行“运行中”只认 busy：宿主在跑工具、出思考时指挥官回合一定在跑。
	feed(s, true);
	s.complete(s.tool("read", { path: "missing" }), "ENOENT", true);
	const assistant = s.blankAssistant();
	const content = [{ type: "thinking", thinking: "不应直接显示的思考" }];
	assistant.updateContent({ role: "assistant", content, stopReason: "pending" }, true);
	for (const [stopReason, diagnostic] of [["error", "Error: failed"], ["aborted", "failed"], ["length", "Response was truncated"]]) {
		assistant.updateContent({ role: "assistant", content, stopReason, errorMessage: "failed" }, false);
		expect(s.lines().join("\n")).toContain(diagnostic);
		expect(s.lines().join("\n")).not.toContain("不应直接显示的思考");
	}
});

test("宿主的单色提示与状态行折入段内并计数，错误与混色文本仍是边界", async () => {
	const s = await scene();
	const note = s.note;
	s.complete(s.tool("read", { path: "a.ts" }));
	const reply = s.blankAssistant();
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
});

/** Master 事件信封：正文第一行是给人看的标题“<名字> <结果词>”，落定类事件带“耗时：本次运行 …”。 */
const EVENT = (title: string, body: string, run = "8m") =>
	`<firecode_master_event>\n${title}\n${body}\n耗时：本次运行 ${run} · 当前任务 19m\n</firecode_master_event>`;
const WORKER_RESULT = (name: string, body = "刷新改为单飞。更多细节") => EVENT(`${name} 已返回`, `回复：\n${body}`);

/** 宿主 addMessageToChat 在每条用户消息前先插一个 Spacer。 */
function hostUser(s: any, text: string) {
	s.chat.addChild(new s.tui.Spacer(1));
	s.chat.addChild(new s.host.UserMessageComponent(text));
}

const { registerMasterEventRenderer } = await loadFirecodeModule("master/event-card.ts") as any;
let masterEventRenderer: unknown;
registerMasterEventRenderer({ registerMessageRenderer: (_type: string, render: unknown) => { masterEventRenderer = render; } });

/** Master 事件按宿主 addMessageToChat 的样子进聊天树：自定义消息不带前置 Spacer。 */
function hostEvent(s: any, content: string) {
	s.chat.addChild(new s.host.CustomMessageComponent({ role: "custom", customType: "firecode-master-event", content, display: true, timestamp: 0 }, masterEventRenderer));
}

function assistant(s: any, content: unknown[], stopReason = "stop") {
	const message = s.blankAssistant();
	message.updateContent({ role: "assistant", stopReason, content }, false);
	return message;
}

test("机器消息不切段；展开后一行 ↳，点击切换原生卡片", async () => {
	const s = await scene();
	s.chat.addChild(new s.host.UserMessageComponent("开工"));
	s.complete(s.tool("read", { path: "a.ts" }));
	hostEvent(s, WORKER_RESULT("fix-auth"));
	s.complete(s.tool("read", { path: "b.ts" }));
	hostEvent(s, WORKER_RESULT("lint-sweep", "清掉 4 处 lint。"));
	assistant(s, [{ type: "text", text: "全部收口" }]);

	const collapsed = s.lines().filter(Boolean).map((line: string) => line.trim());
	expect(collapsed.filter((line: string) => line.includes("开工"))).toHaveLength(1);
	expect(collapsed.filter((line: string) => /^✓$/.test(line))).toHaveLength(1);
	expect(collapsed.join("\n")).not.toMatch(/firecode_master_event|fix-auth|lint-sweep/);
	expect(collapsed.at(-1)).toBe("全部收口");

	s.ui.setToolsExpanded(true);
	let expanded = s.lines().map((line: string) => line.trim());
	// 机器消息一律一行，不平铺整张卡。
	expect(expanded).toContain("↳ fix-auth 已返回 · 8m 刷新改为单飞。");
	expect(expanded).toContain("↳ lint-sweep 已返回 · 8m 清掉 4 处 lint。");
	expect(expanded.join("\n")).not.toMatch(/firecode_master_event|当前任务/);
	const order = ["a.ts", "fix-auth", "b.ts", "lint-sweep", "全部收口"].map((needle) => expanded.findIndex((line: string) => line.includes(needle)));
	expect(order).toEqual([...order].sort((a, b) => a - b));

	// 点击该行切换原生卡片，与单工具行同一交互。
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
	expect(s.ui.getToolsExpanded()).toBe(false);
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

/** 把会话进行中的事实喂给投影；歇下边沿由 busy.ts 触发、记录器写入轮记录（见 scene 的 settle）。 */
const feed = (s: any, agentRunning: boolean, inFlight = 0, since?: number) =>
	s.feedBusy({ agentRunning, inFlight, review: undefined, busy: agentRunning || inFlight > 0, since });

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

test("摘要行从开始到歇下一直在原位：思考中 → 读取 → 思考中 → 回复中 → 落定，回复不跳；当前动作不挂着已完成的工具", async () => {
	const s = await scene();
	hostUser(s, "你好");
	s.setNow(1000);
	feed(s, true, 0, 1000);
	s.complete(s.tool("read", { path: "/project/a.ts" }));
	const reply = s.blankAssistant();
	const frame = () => s.lines(60).map((line: string) => line.trimEnd());
	const summaryAt = (lines: string[]) => lines.findIndex((line) => /^(?:✓|✗|[⠀-⣿])/.test(line));

	reply.updateContent({ role: "assistant", stopReason: "pending", content: [] }, true);
	const first = frame();
	expect(summaryAt(first)).toBeGreaterThanOrEqual(0);

	reply.updateContent({ role: "assistant", stopReason: "pending", content: [{ type: "text", text: "你好，有什么" }] }, true);
	const streaming = frame();
	expect(summaryAt(streaming)).toBe(summaryAt(first));
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
	expect(settled[summaryAt(settled)].startsWith("✓")).toBe(true);
	expect(settled.findIndex((line) => line.includes("你好，有什么要做的？"))).toBe(replyAt);
});

test("审查卡的 ↳ 行：成败色由卡片 details 决定，预览取首条发现或原因", async () => {
	const s = await scene();
	const { buildCard } = await loadFirecodeModule("review/card.ts");
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts");
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
	s.ui.setToolsExpanded(true);

	const raw = s.chat.render(120);
	const rows = raw.map((line: string) => stripVTControlCharacters(line).trim()).filter((line: string) => line.startsWith("↳"));
	expect(rows).toEqual([
		"↳ 审查未通过 刷新竞态未修",
		"↳ 审查未完成 所有审查者均未给出有效结论",
		"↳ 第 2 轮审查通过 验证命令 exit 0，核心逻辑已核对。",
	]);
	const red = s.ui.theme.fg("error", "↳");
	const toneOf = (needle: string) => raw.find((line: string) => line.includes(needle))!.includes(red);
	expect(["审查未通过", "审查未完成"].filter(toneOf)).toEqual(["审查未通过", "审查未完成"]);
	expect(["第 2 轮审查通过"].filter(toneOf)).toEqual([]);
});

test("Master 真实产出的事件经信封投影到 ↳ 行、到达高亮与子代理失败计数：红色 = 失败 = 计数只由“错误：”决定，审查未通过画黄色，被中断与未通过不算失败，回复原文里的分节字样不改结局，只有落定类事件高亮", async () => {
	const { masterEvent, withElapsed } = await loadFirecodeModule("master/event-format.ts");
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts");
	const event = (produced: unknown) => wrapEnvelope("firecode_master_event", withElapsed(produced, { run: 8 * 60_000, task: 19 * 60_000 }));
	const cases = [
		{ body: masterEvent.returned("fix-auth", "刷新改为单飞。更多细节"), row: "↳ fix-auth 已返回 · 8m 刷新改为单飞。", red: false },
		{ body: masterEvent.failed("perf", "429 Too Many Requests"), row: "↳ perf 失败 · 8m 429 Too Many Requests", red: true },
		{ body: masterEvent.interrupted("lint", false), row: "↳ lint 被中断 · 8m", red: false },
		{ body: masterEvent.returned("notes", "收尾完成。\n错误：\n无\n结论：\n可以合并"), row: "↳ notes 已返回 · 8m 收尾完成。", red: false },
		{ body: masterEvent.review("docs", { status: "passed", runId: "r", rounds: 2 }, "## 交付\n- 修好了。"), row: "↳ docs 审查通过（2 轮） · 8m 修好了。", red: false },
		{ body: masterEvent.review("ui", { status: "stopped", runId: "r", rounds: 3, advisorAdvice: "收敛不了，交还用户。" }, "已停。"), row: "↳ ui 审查未通过 · 8m 审查 3 轮，顾问叫停", red: false, yellow: true },
		{ body: masterEvent.review("api", { status: "failed", runId: "r", rounds: 1, reason: "审查会话超时。" }, "实现完成。"), row: "↳ api 审查未完成 · 8m 审查会话超时。", red: true },
		{ body: masterEvent.modelSwitched("bench", "a/x/high", "b/y/high", "429"), row: "↳ bench 已切换模型", red: false },
	];
	const s = await scene();
	hostUser(s, "开工");
	s.complete(s.tool("read", { path: "a.ts" }));
	for (const { body } of cases) hostEvent(s, event(body));
	assistant(s, [{ type: "text", text: "收口" }]);
	s.settle(3_000, "complete", 0);
	s.setNow(60_000);
	expect(s.lines().find((line: string) => line.startsWith("✓"))!.trimEnd()).toBe("✓ 3.0s · 2 个子代理失败");
	s.ui.setToolsExpanded(true);
	const raw = s.chat.render(120);
	const rows = raw.filter((line: string) => stripVTControlCharacters(line).trim().startsWith("↳"));
	expect(rows.map((line: string) => stripVTControlCharacters(line).trim())).toEqual(cases.map((entry) => entry.row));
	expect(rows.map((line: string) => line.includes(s.ui.theme.fg("error", "↳")))).toEqual(cases.map((entry) => entry.red));
	expect(rows.map((line: string) => line.includes(s.ui.theme.fg("warning", "↳")))).toEqual(cases.map((entry) => "yellow" in entry));
});

test("补话不切轮：与上一条人类消息之间没有轮记录的人类消息折进当前轮，折叠态与展开态都显示全文；歇下之后的人类消息才开新一轮", async () => {
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
	s.complete(bash);
	assistant(s, [{ type: "text", text: "现在十点。" }]);
	feed(s, false);
	s.settle(5_000, "complete", 0);
	s.setNow(60_000);

	const folded = s.lines().map((line: string) => line.trimEnd()).filter(Boolean);
	expect(folded.filter((line: string) => /^✓/.test(line))).toEqual(["✓ 5.0s"]);
	const at = (needle: string) => folded.findIndex((line: string) => line.includes(needle));
	// 补话是人类原话：全文显示，不截成首句。
	expect(folded[at("补一句")]).toContain("补一句：顺便说下几点");
	expect(folded[at("第二行细节")]).toContain("第二行细节");
	expect([at("原问题"), at("✓ 5.0s"), at("先看看。"), at("补一句"), at("第二行细节"), at("现在十点。")])
		.toEqual([at("原问题"), at("✓ 5.0s"), at("先看看。"), at("补一句"), at("第二行细节"), at("现在十点。")].sort((a, b) => a - b));

	s.click(s.lines().findIndex((line: string) => line.startsWith("✓")));
	const expanded = s.lines().join("\n");
	const order = ["原问题", "a.ts", "先看看。", "补一句", "第二行细节", "date", "现在十点。"].map((needle) => expanded.indexOf(needle));
	expect(order.every((position) => position >= 0)).toBe(true);
	expect(order).toEqual([...order].sort((a, b) => a - b));

	hostUser(s, "新问题");
	s.complete(s.tool("read", { path: "c.ts" }));
	expect(s.lines().filter((line: string) => /^✓/.test(line))).toHaveLength(2);
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

test("宿主对 ctrl+o 的回显“Tool output: expanded/collapsed”不进对话；其余宿主状态行照常折入", async () => {
	const s = await scene();
	const note = s.note;
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

test("折叠态按时间顺序：每条补话之后跟它那一段的中间回复首句，每段最多 3 条、更早的折成“+N 条”，最后一条回复全文", async () => {
	const s = await scene();
	const interim = (text: string, id: string) => {
		assistant(s, [{ type: "text", text }, { type: "toolCall", id, name: "read", arguments: {} }], "toolUse");
		s.complete(s.tool("read", { path: `${id}.ts` }));
	};
	hostUser(s, "原问题");
	interim("回复甲。后面的细节", "a");
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

	const shown = s.lines().map((line: string) => line.replace(/^▌/u, "").trim()).filter(Boolean);
	expect(shown).toEqual([
		"原问题", "✓ 5.0s", "回复甲。", "回复乙。",
		"补话一", "+1 条", "回复丁。", "回复戊。", "回复庚。",
		"补话二", "回复己。",
		"最终回复。",
	]);
});

test("用户消息的 OSC 133 语义提示标记始终在行首：终端把行中的 133;A 当 fresh-line 执行 CR+LF，会把后半行写到下一行留下残影", async () => {
	const s = await scene();
	hostUser(s, "第一段\n\n第二段");
	s.complete(s.tool("read", { path: "a.ts" }));
	assistant(s, [{ type: "text", text: "收到" }]);
	const marked = s.chat.render(60).filter((line: string) => line.includes("\x1b]133;"));
	expect(marked.length).toBeGreaterThan(0);
	for (const line of marked) expect(line).toMatch(/^(?:\x1b\]133;[ABC]\x07)+/);
});

test("宿主组件形状不符时不安装过程分组：提示后聊天树保持原生渲染", async () => {
	const s = await scene();
	const message = new s.host.AssistantMessageComponent(undefined, true, s.host.getMarkdownTheme());
	delete (message as any).isStreaming;
	expect(() => s.chat.addChild(message)).toThrow(/isStreaming/u);
	expect(s.chat.render).toBe(s.originalRender);
});
