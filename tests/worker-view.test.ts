import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_CODING_AGENT_URL, PI_TUI_URL } from "./loader.ts";

let disposeGroups: (() => void) | undefined;
afterEach(async () => {
	disposeGroups?.();
	disposeGroups = undefined;
	await cleanupFirecodeModules();
});

const ROWS = 40;
const KEYS: Record<string, string> = { "\x1b": "app.interrupt", "\x03": "app.clear", "\x04": "app.exit", "\x0f": "app.tools.expand" };
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const LEFT = "\x1b[D";

let clock = 1_000;
const at = () => new Date(clock++).toISOString();
const user = (text: string) => ({ type: "message", id: `u${clock}`, timestamp: at(), message: { role: "user", content: [{ type: "text", text }], timestamp: clock } });
const reply = (text: string, stopReason = "stop", content: unknown[] = []) =>
	({ type: "message", id: `a${clock}`, timestamp: at(), message: { role: "assistant", content: [{ type: "text", text }, ...content], stopReason, timestamp: clock, usage: {} } });
const toolResult = (id: string, text: string) =>
	({ type: "message", id: `r${clock}`, timestamp: at(), message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: clock } });
/** Worker 会话里由轮记录器写下的记录（格式见冻结边界：{ elapsed, outcome, tps? }）。 */
const round = (elapsed: number, outcome = "complete", tps?: number) =>
	({ type: "custom", customType: "firecode-round", id: `r${clock}`, timestamp: at(), data: { elapsed, outcome, ...(tps ? { tps } : {}) } });

/** 审查结果卡的渲染器替身：像真实结果卡一样随原生展开档位给出紧凑卡或完整卡。 */
let Text: any;
const cardRenderer = (_message: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "完整卡：共 2 轮，全部通过" : "紧凑卡", 0, 0);

/** 进程内热会话的替身：只有视图读取的那几样（分支、流式标记、排队、事件订阅）。 */
function hotSession(branch: unknown[], streaming = false) {
	const listeners = new Set<(event: unknown) => void>();
	const session = {
		isStreaming: streaming,
		steering: [] as string[],
		sessionManager: { getBranch: () => branch },
		extensionRunner: { getMessageRenderer: (type: string) => (type === "firecode-review-card" ? cardRenderer : undefined) },
		getSteeringMessages: () => session.steering,
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: Record<string, unknown>) {
			if (event.type === "entry_appended") branch.push(event.entry);
			for (const listener of listeners) listener(event);
		},
		get listeners() { return listeners.size; },
	};
	return session;
}

type Worker = { name: string; role: string; model: string; thinking: string; status: string; sessionPath: string; cwd: string };
const worker = (name: string, status = "idle"): Worker =>
	({ name, role: "哨兵", model: "openai-codex/gpt-6-luna", thinking: "low", status, sessionPath: `/s/${name}.jsonl`, cwd: "/p" });

async function open(options: { workers: Worker[]; sessions: Record<string, ReturnType<typeof hotSession>>; name?: string; send?: (name: string, prompt: string) => Promise<void> }) {
	const [host, tui, view, grouping, clockModule] = await Promise.all([
		import(PI_CODING_AGENT_URL), import(PI_TUI_URL),
		loadFirecodeModule("master/worker-view.ts"), loadFirecodeModule("tools/grouping.ts"), loadFirecodeModule("tools/turn-clock.ts"),
	]) as any[];
	host.initTheme("dark");
	Text = tui.Text;
	const theme = (await import(new URL("./modes/interactive/theme/theme.ts", PI_CODING_AGENT_URL).href)).theme;
	const root = new tui.Container();
	const chat = new tui.Container();
	root.addChild(chat);
	let renders = 0;
	root.requestRender = () => { renders++; };
	root.terminal = { rows: ROWS };
	const { createInteractiveTuiReference } = await import(new URL("./modes/interactive/tui-renderer.ts", PI_CODING_AGENT_URL).href);
	const reference = createInteractiveTuiReference(() => root);
	// 主会话的分组补丁同时在场（生产里一定装着）：视图里的卡片展开要与它共用同一机制。
	disposeGroups = grouping.installGroupPatch({
		theme, getToolsExpanded: () => false, setToolsExpanded() {}, notify(message: string) { throw new Error(message); },
		setWidget(_key: string, factory?: (tui: unknown) => unknown) { factory?.(reference); },
	}, { replyLines: 3, clock: new clockModule.TurnClock() });
	const sessionListeners = new Set<(name: string) => void>();
	const sent: [string, string][] = [];
	let closed = 0;
	const port = {
		names: () => options.workers.map((entry) => entry.name),
		worker: (name: string) => options.workers.find((entry) => entry.name === name),
		session: (target: Worker) => options.sessions[target.name],
		onSession(listener: (name: string) => void) {
			sessionListeners.add(listener);
			return () => sessionListeners.delete(listener);
		},
		runStartedAt: () => undefined,
		send: options.send ?? (async (name: string, prompt: string) => { sent.push([name, prompt]); }),
	};
	const component = new view.WorkerView(port, options.name ?? options.workers[0].name, { terminal: { rows: ROWS }, requestRender: () => { renders++; } }, theme,
		{ matches: (data: string, action: string) => KEYS[data] === action }, () => { closed++; component.dispose(); });
	const lines = (width = 100): string[] => component.render(width).map((line: string) => stripVTControlCharacters(line).trimEnd());
	const type = (text: string) => { for (const char of text) component.handleInput(char); };
	return {
		component, lines, type, sent, sessionListeners,
		get closed() { return closed; },
		get renders() { return renders; },
		key: (data: string) => component.handleInput(data),
		click: (row: number) => component.handleMouse({ type: "click", button: "left", x: 3, y: row, screenX: 3, screenY: row, width: 100, height: ROWS, shift: false, alt: false, ctrl: false }),
	};
}

test("打开即一次构建：按 Worker 会话自己的轮记录分轮、摘要行显示记录里的耗时与均速；顶行写名字、角色、模型与状态", async () => {
	const branch = [
		user("用 bash 跑测试"),
		reply("先读一下。", "toolUse", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/p/a.ts" } }]),
		toolResult("c1", "内容"),
		reply("跑完了，全绿。"),
		round(5_000, "complete", 40),
		user("再跑一次 lint"),
		reply("lint 也过了。"),
		round(2_000),
	];
	const view = await open({ workers: [worker("tick")], sessions: { tick: hotSession(branch) } });
	const lines = view.lines();
	expect(lines[0]).toMatch(/^ tick · 哨兵 · openai-codex\/gpt-6-luna\/low · 空闲/u);
	expect(lines.filter((line) => /^[✓✗]/u.test(line))).toEqual(["✓ 5.0s · 40 tps", "✓ 2.0s"]);
	const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
	expect(at("用 bash 跑测试")).toBeLessThan(at("✓ 5.0s"));
	expect(at("跑完了，全绿。")).toBeLessThan(at("再跑一次 lint"));
	expect(at("再跑一次 lint")).toBeLessThan(at("✓ 2.0s"));
});

test("运行中按子会话事件增量更新：补话折进当前轮、工具行实时出现，落定写下的轮记录到达后定格", async () => {
	const session = hotSession([user("跑 sleep")], true);
	const view = await open({ workers: [worker("tick", "working")], sessions: { tick: session } });
	session.emit({ type: "agent_start" });
	session.emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 1 } });
	session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 3" } }], stopReason: "pending", timestamp: 1 } });
	session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 3" } });
	expect(view.lines().find((line) => line.includes("sleep 3"))).toMatch(/操作 \$ sleep 3/u);
	session.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "补一句：顺便报时间" }], timestamp: 2 } });
	expect(view.lines().filter((line) => /^[⠀-⣿✓✗]/u.test(line))).toHaveLength(1);
	expect(view.lines().some((line) => line.includes("补一句：顺便报时间"))).toBe(true);
	session.emit({ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
	session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 3" } }], stopReason: "toolUse", timestamp: 1 } });
	session.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "好了，十点。" }], stopReason: "stop", timestamp: 3 } });
	session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好了，十点。" }], stopReason: "stop", timestamp: 3 } });
	session.emit({ type: "agent_end", messages: [] });
	session.emit({ type: "entry_appended", entry: round(7_000) });
	expect(view.lines().filter((line) => /^[⠀-⣿✓✗]/u.test(line))).toEqual(["✓ 7.0s"]);
	expect(view.lines().some((line) => line.includes("好了，十点。"))).toBe(true);
});

test("排队中的补话在输入框上方显示一行“排队中：原话”，送达后消失；内容读 Worker 会话的排队事实", async () => {
	const session = hotSession([user("跑 sleep")], true);
	const view = await open({ workers: [worker("tick", "working")], sessions: { tick: session } });
	session.steering = ["补一句：顺便报时间"];
	session.emit({ type: "queue_update", steering: session.steering, followUp: [] });
	const lines = view.lines();
	const input = lines.findIndex((line) => line.startsWith("›"));
	expect(lines[input - 1]).toBe(" 排队中：补一句：顺便报时间");
	session.steering = [];
	session.emit({ type: "queue_update", steering: [], followUp: [] });
	expect(view.lines().some((line) => line.includes("排队中"))).toBe(false);
});

test("Tab / Shift+Tab 按启动序换子代理，位置 n/N 不随状态跳；←/→ 留给输入框光标", async () => {
	const workers = [worker("a"), worker("b", "working"), worker("c")];
	const sessions = Object.fromEntries(workers.map((entry) => [entry.name, hotSession([user(`派给 ${entry.name}`)])]));
	const view = await open({ workers, sessions });
	expect(view.lines().at(-1)).toMatch(/1\/3$/u);
	view.key(TAB);
	expect(view.lines()[0]).toMatch(/^ b ·/u);
	expect(view.lines().at(-1)).toMatch(/2\/3$/u);
	workers[1].status = "idle";
	expect(view.lines().at(-1)).toMatch(/2\/3$/u);
	view.key(SHIFT_TAB);
	view.key(SHIFT_TAB);
	expect(view.lines()[0]).toMatch(/^ c ·/u);
	view.type("ab");
	view.key(LEFT);
	view.type("X");
	expect(view.lines()[0]).toMatch(/^ c ·/u);
	expect(view.lines().find((line) => line.startsWith("›"))).toBe("› aXb");
});

test("回车补话走视图来源的 send（同一处理表入口），成功清空输入；失败把原因写在底行，原话留着", async () => {
	const failing = { fail: false };
	const sent: [string, string][] = [];
	const view = await open({
		workers: [worker("tick")], sessions: { tick: hotSession([user("派单")]) },
		send: async (name, prompt) => {
			if (failing.fail) throw new Error("回合正在收尾");
			sent.push([name, prompt]);
		},
	});
	view.type("补一句：再跑一次");
	view.key("\r");
	await Bun.sleep(0);
	expect(sent).toEqual([["tick", "补一句：再跑一次"]]);
	expect(view.lines().find((line) => line.startsWith("›"))).not.toContain("补一句");
	failing.fail = true;
	view.type("第二句");
	view.key("\r");
	await Bun.sleep(0);
	expect(view.lines().at(-1)).toContain("未送达：回合正在收尾");
	expect(view.lines().find((line) => line.startsWith("›"))).toBe("› 第二句");
});

test("关闭零订阅：打开时只挂当前子代理的一个会话订阅与一个会话接上通知，切换只留新的，关闭全部撤掉", async () => {
	const sessions = { a: hotSession([user("派给 a")], true), b: hotSession([user("派给 b")], true) };
	const view = await open({ workers: [worker("a", "working"), worker("b", "working")], sessions });
	expect([sessions.a.listeners, sessions.b.listeners, view.sessionListeners.size]).toEqual([1, 0, 1]);
	view.key(TAB);
	expect([sessions.a.listeners, sessions.b.listeners, view.sessionListeners.size]).toEqual([0, 1, 1]);
	view.key("\x1b");
	expect(view.closed).toBe(1);
	expect([sessions.a.listeners, sessions.b.listeners, view.sessionListeners.size]).toEqual([0, 0, 0]);
	const renders = view.renders;
	sessions.b.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "关了之后的事件" }], timestamp: 9 } });
	expect(view.renders).toBe(renders);
});

test("视图里点开审查结果卡这类机器消息看到完整卡：卡片展开交给投影，与主会话同一机制", async () => {
	const card = { type: "custom_message", id: "m1", timestamp: at(), customType: "firecode-review-card", display: true, details: undefined,
		content: "<firecode_review>\n审查通过\n共 2 轮，全部通过\n</firecode_review>" };
	const view = await open({ workers: [worker("tick")], sessions: { tick: hotSession([user("派单"), reply("交付。", "toolUse", []), card, reply("收口。"), round(4_000)]) } });
	view.key("\x0f");
	const row = view.lines().findIndex((line) => line.startsWith("↳ 审查通过"));
	expect(row).toBeGreaterThan(0);
	expect(view.lines().join("\n")).not.toMatch(/紧凑卡|完整卡/u);
	view.click(row);
	expect(view.lines().join("\n")).toContain("完整卡：共 2 轮，全部通过");
});

test("浮层里宿主的全局键不落空：ctrl+c 先清输入、再按关闭视图；esc 与空输入的 ctrl+d 关闭视图", async () => {
	for (const close of ["\x1b", "\x04", "\x03"]) {
		const view = await open({ workers: [worker("tick")], sessions: { tick: hotSession([user("派单")]) } });
		if (close === "\x03") {
			view.type("草稿");
			view.key("\x03");
			expect(view.closed).toBe(0);
			expect(view.lines().find((line) => line.startsWith("›"))).not.toContain("草稿");
		}
		view.key(close);
		expect(view.closed).toBe(1);
	}
});
