import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import { installFaux } from "./faux-host.ts";
import { until } from "./until.ts";
import {
	featuresOnly,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
	PI_TUI_URL,
} from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall } = await import(PI_AI_COMPAT_URL) as any;
const { visibleWidth } = await import(PI_TUI_URL) as { visibleWidth: (text: string) => number };
const WATCHER_CONFIG = { model: "test/watcher/low" };
const DELIVER_OPTIONS = { triggerTurn: true };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

let faux: any;
let directory: string | undefined;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

test("建议卡收起只显示正文首行，展开显示完整建议", async () => {
	const { registerWatcherCardRenderer, adviceMessage, WATCHER_MESSAGE_TYPE } = await loadFirecodeModule("watcher/card.js") as any;
	const fake = fakePi();
	registerWatcherCardRenderer(fake.pi);
	const render = fake.messageRenderers.get(WATCHER_MESSAGE_TYPE) as any;
	const card = { note: "第一行建议很长，需要按宽截断\n第二行必须只在展开时出现", turnIndex: 4 };
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };

	const collapsedLines = render({ content: adviceMessage(card) }, { expanded: false }, theme).render(60);
	expect(collapsedLines.length).toBe(1);
	const collapsed = collapsedLines.join("\n");
	expect(collapsed).toContain("第一行建议");
	expect(collapsed).not.toContain("第二行");
	expect(collapsedLines.every((line: string) => visibleWidth(line) <= 60)).toBeTrue();

	const expanded = render({ content: adviceMessage(card) }, { expanded: true }, theme).render(60).join("\n");
	expect(expanded.replaceAll("\n", "")).toContain("第一行建议很长，需要按宽截断");
	expect(expanded.replaceAll("\n", "")).toContain("第二行必须只在展开时出现");
});

test("开口即投递，建议带来源信封与时点标记", async () => {
	const harness = await setup();
	advise("工单要求的回滚路径还没实现");
	const delivered = harness.next();
	await harness.turnEnd(7, "继续");
	await delivered;

	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual(DELIVER_OPTIONS);
	expect(harness.messages[0].message.content).toBe([
		"<firecode_watcher>",
		"👓 观察员（基于第 7 回合前的观察）",
		"工单要求的回滚路径还没实现",
		"这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。",
		"</firecode_watcher>",
	].join("\n"));
});

test("一条发言投递失败只丢弃这一条并提示，观察员继续工作", async () => {
	const harness = await setup({ failDeliveries: 1 });
	advise("第一条建议");
	let attempt = harness.next();
	await harness.turnEnd(3, "继续");
	await attempt;
	await until(() => harness.notices.some((notice) => notice.includes("投递失败")));
	expect(harness.messages).toHaveLength(0);
	expect(harness.notices.some((notice) => notice.includes("投递失败"))).toBe(true);
	expect(harness.notices.some((notice) => notice.includes("观察员已停止"))).toBe(false);

	advise("第二条建议");
	attempt = harness.next();
	await harness.turnEnd(4, "再继续");
	await attempt;
	expect(harness.notes().map((note) => note.note)).toEqual(["第二条建议"]);
});

test("用户 esc 中断过的现场照常投递，投递选项不变", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.appendResponses([async () => {
		await gate;
		return fauxAssistantMessage([fauxToolCall("advise", { note: "迁移脚本会删表" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("已提交")]);
	const delivered = harness.next();
	await harness.turnEnd(9, "写迁移脚本");
	await harness.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
	});
	release();
	await delivered;

	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual(DELIVER_OPTIONS);
	expect(harness.notes()).toEqual([{ note: "迁移脚本会删表", turnIndex: 9 }]);
});

test("Master 关闭时释放子代理会话，不掐断与它共用池的观察员正在评估的会话", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.appendResponses([async () => {
		await gate;
		return fauxAssistantMessage([fauxToolCall("advise", { note: "共用池里的建议" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("已提交")]);
	const delivered = harness.next();
	await harness.turnEnd(3, "评估进行中");
	await until(() => faux.getPendingResponseCount() === 1);
	await harness.pool.disposeWorkers();
	release();
	await delivered;

	expect(harness.notes()).toEqual([{ note: "共用池里的建议", turnIndex: 3 }]);
});

test("fire-review 活跃期零评估，结束后合并补上", async () => {
	const harness = await setup();
	advise("两个回合一起看到的");
	harness.pi.events.emit("firecode:review", { active: true, progress: () => undefined });
	await harness.turnEnd(2, "审查中的改动");
	await harness.turnEnd(3, "又一个回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.messages).toEqual([]);

	const delivered = harness.next();
	harness.pi.events.emit("firecode:review", { active: false });
	await delivered;
	expect(faux.getPendingResponseCount()).toBe(0);
	expect(harness.notes()).toEqual([{ note: "两个回合一起看到的", turnIndex: 3 }]);
});

test("评估落后时合并跳最新，同批增量只产生一条建议", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let merged = "";
	faux.appendResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("advise", { note: "第一次" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
		(context: any) => {
			merged = latestUserText(context);
			return fauxAssistantMessage([fauxToolCall("advise", { note: "合并后的建议" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	const first = harness.next();
	await harness.turnEnd(1, "第一回合");
	await harness.turnEnd(2, "第二回合");
	await harness.turnEnd(3, "第三回合");
	release();
	await first;
	await harness.next();

	expect(faux.getPendingResponseCount()).toBe(0);
	// append-only：新一批只带落后的回合，已评估过的第 1 回合留在前缀里不重发。
	expect(merged).toContain('<turn index="2">');
	expect(merged).toContain('<turn index="3">');
	expect(merged).not.toContain('<turn index="1">');
	expect(harness.notes()).toEqual([
		{ note: "第一次", turnIndex: 1 },
		{ note: "合并后的建议", turnIndex: 3 },
	]);
});

test("供应商报错时观察员停用并提示原因，不装作还在工作", async () => {
	const harness = await setup();
	faux.appendResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid x-api-key" })]);
	await harness.turnEnd(1, "继续");
	await until(() => harness.notices.length > 0);

	expect(harness.notices).toEqual(["观察员已停止：invalid x-api-key"]);
	expect(harness.statuses.has("watcher")).toBeFalse();
	expect(harness.messages).toEqual([]);
});

test("一次评估只接受一条 advise，多余的当场拒绝", async () => {
	const harness = await setup();
	faux.appendResponses([
		fauxAssistantMessage([
			fauxToolCall("advise", { note: "第一条" }),
			fauxToolCall("advise", { note: "第二条" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
	const delivered = harness.next();
	await harness.turnEnd(5, "一堆改动");
	await delivered;

	expect(harness.notes()).toEqual([{ note: "第一条", turnIndex: 5 }]);
});

test("裸 /fire-watch 来回翻转当前会话并拒绝旧参数", async () => {
	const harness = await setup();
	advise("重新开启后的建议");
	expect(harness.statuses.get("watcher")).toBe("观察员");
	await harness.command("");
	expect(harness.statuses.has("watcher")).toBeFalse();
	await harness.turnEnd(1, "关闭期间的回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.messages).toEqual([]);

	const delivered = harness.next();
	await harness.command("");
	expect(harness.statuses.get("watcher")).toBe("观察员");
	await harness.turnEnd(2, "重新开启后的回合");
	await delivered;
	expect(harness.notes()).toEqual([{ note: "重新开启后的建议", turnIndex: 2 }]);

	await harness.command("on");
	expect(harness.notices.at(-1)).toContain("不接受参数");
});

test("watcher 节缺失时拒绝启动并说明原因，不拿默认模型代替", async () => {
	const harness = await setup({ watcher: null });
	await harness.turnEnd(1, "回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(0);

	await harness.command("");
	expect(harness.notices.join("\n")).toContain("watcher.model 必须是“provider/model/thinking”字符串");
});

test("无建议时保持沉默；增量带上工具调用与工具结果，minimal 只省推理与正文", async () => {
	const harness = await setup();
	let increment = "";
	let seen!: () => void;
	const evaluated = new Promise<void>((resolve) => { seen = resolve; });
	faux.appendResponses([
		(context: any) => {
			increment = latestUserText(context);
			seen();
			return fauxAssistantMessage("无需建议");
		},
	]);
	await harness.turnEnd(1, "先看一眼", [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "3 files changed" }],
			isError: false,
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "write",
			content: [{ type: "text", text: "permission denied" }],
			isError: true,
			timestamp: 0,
		},
	], [
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
		{ type: "toolCall", id: "call-2", name: "write", arguments: { path: "a.ts", content: "x".repeat(50) } },
	]);
	await evaluated;

	expect(harness.messages).toEqual([]);
	expect(increment).toContain("→ bash：3 files changed");
	expect(increment).toContain("✗ write：permission denied");
	expect(increment).toContain("command=git status");
	// minimal 只省推理与 diff 正文：写入动作还在，正文只留长度。
	expect(increment).toContain("content=<50 字符>");
	expect(increment).not.toContain("xxxxx");
});

test("主会话压缩后从当前尾部重新入场，不回放旧增量", async () => {
	const harness = await setup();
	advise("压缩前");
	let reentry: any[] = [];
	faux.appendResponses([
		(context: any) => {
			reentry = context.messages.filter((message: any) => message.role === "user");
			return fauxAssistantMessage([fauxToolCall("advise", { note: "压缩后" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	let delivered = harness.next();
	await harness.turnEnd(1, "压缩前的回合");
	await delivered;

	await harness.emit("session_compact", { type: "session_compact" });
	delivered = harness.next();
	await harness.turnEnd(2, "压缩后的回合");
	await delivered;
	expect(reentry).toHaveLength(1);
	expect(harness.notes().at(-1)).toEqual({ note: "压缩后", turnIndex: 2 });
});

/**
 * 按增量内容回答的观察员脚本：每个会话各自按自己看到的回合说话，不依赖请求的先后顺序。
 * rules 的键是增量里的文字，值是建议（空串表示无需建议）；gate 在回答含该文字的增量前先等放行。
 */
function observerScript(rules: Record<string, string>, gate?: { when: string; started: () => void; open: Promise<void>; fail?: string }) {
	faux.appendResponses(Array.from({ length: 12 }, () => async (context: any) => {
		if (context.messages.at(-1).role === "toolResult") return fauxAssistantMessage("已提交");
		const text = latestUserText(context);
		if (gate && text.includes(gate.when)) {
			gate.started();
			await gate.open;
			if (gate.fail) throw new Error(gate.fail);
		}
		const note = Object.entries(rules).find(([key]) => text.includes(key))?.[1];
		return note
			? fauxAssistantMessage([fauxToolCall("advise", { note })], { stopReason: "toolUse" })
			: fauxAssistantMessage("无需建议");
	}));
}

test("评估途中发生压缩时丢弃过期建议，观察员不被拖垮", async () => {
	const harness = await setup();
	const started = Promise.withResolvers<void>();
	const open = Promise.withResolvers<void>();
	observerScript({ 压缩前: "压缩前的现场", 压缩后: "压缩后的建议" }, { when: "压缩前", started: started.resolve, open: open.promise });
	await harness.turnEnd(1, "压缩前的回合");
	await started.promise;
	await harness.emit("session_compact", { type: "session_compact" });
	open.resolve();
	await Bun.sleep(20);
	expect(harness.messages).toEqual([]);
	expect(harness.notices).toEqual([]);

	const delivered = harness.next();
	await harness.turnEnd(2, "压缩后的回合");
	await delivered;
	expect(harness.notes()).toEqual([{ note: "压缩后的建议", turnIndex: 2 }]);
});

test("评估中切换会话后旧任务不访问旧 ctx，也不关闭新 runtime", async () => {
	const harness = await setup();
	const started = Promise.withResolvers<void>();
	const open = Promise.withResolvers<void>();
	observerScript({ 新会话: "新会话仍在工作" }, { when: "旧会话", started: started.resolve, open: open.promise, fail: "旧评估失败" });
	await harness.turnEnd(1, "旧会话");
	await started.promise;
	const oldContext = harness.context;
	const nextContext = harness.createContext();
	await harness.sessionStart(nextContext.ctx);
	oldContext.retire();
	open.resolve();
	await Bun.sleep(20);

	expect(oldContext.staleAccesses).toEqual([]);
	const delivered = harness.next();
	await harness.turnEnd(2, "新会话", [], [], nextContext.ctx);
	await delivered;
	expect(harness.notes()).toEqual([{ note: "新会话仍在工作", turnIndex: 2 }]);
});

test("Observer 创建中切换会话时释放迟到资源且不执行旧评估", async () => {
	const harness = await setup();
	observerScript({ 旧会话: "旧会话的建议", 新会话: "新 owner 的建议" });
	const spawn = harness.pool.spawn.bind(harness.pool);
	const spawning = Promise.withResolvers<void>();
	let spawned = 0;
	let disposals = 0;
	harness.pool.spawn = async (options: unknown) => {
		spawned += 1;
		if (spawned === 1) spawning.resolve();
		const session = await spawn(options);
		const dispose = session.dispose;
		session.dispose = () => { disposals += 1; return dispose(); };
		return session;
	};
	await harness.turnEnd(1, "旧会话");
	await spawning.promise;
	const oldContext = harness.context;
	const nextContext = harness.createContext();
	await harness.sessionStart(nextContext.ctx);
	oldContext.retire();
	await until(() => disposals === 1);

	expect(oldContext.staleAccesses).toEqual([]);
	const delivered = harness.next();
	await harness.turnEnd(2, "新会话", [], [], nextContext.ctx);
	await delivered;
	expect(disposals).toBe(1);
	expect(harness.notes()).toEqual([{ note: "新 owner 的建议", turnIndex: 2 }]);
});

test("子会话不带观察员，主会话带", async () => {
	const configJsonc = JSON.stringify({ features: await featuresOnly("watcher"), watcher: WATCHER_CONFIG });
	const { registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc }) as any;
	const commandsOf = (subsession: boolean) => {
		const fake = fakePi();
		registerFirecode(fake.pi, subsession);
		return [...fake.commands.keys()];
	};
	expect(commandsOf(false)).toEqual(["fire-watch"]);
	expect(commandsOf(true)).toEqual([]);
});

function latestUserText(context: any): string {
	const message = context.messages.findLast((candidate: any) => candidate.role === "user");
	return typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part: any) => part.text ?? "").join("");
}

function advise(note: string) {
	faux.appendResponses([
		fauxAssistantMessage([fauxToolCall("advise", { note })], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
}

async function setup(options: {
	watcher?: Record<string, unknown> | null;
	features?: Record<string, unknown>;
	/** 前 n 次 sendMessage 抛错：复现发言投递失败。 */
	failDeliveries?: number;
} = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-watcher-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = await installFaux(agentDir, ["test/watcher"]);
	const { SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("spawn.js") as any;
	const pool = new spawnModule.InProcessSessionPool();
	const watcher = options.watcher === undefined ? WATCHER_CONFIG : options.watcher;
	const module = await loadFirecodeModule("watcher/index.js", {
		configJsonc: JSON.stringify({
			features: { watcher: true, review: false, master: false, ...options.features },
			review: TEST_REVIEW_CONFIG,
			...(watcher === null ? {} : { watcher }),
		}),
	}) as any;

	const fake = fakePi();
	const { commands, sent: messages } = fake;
	const notices: string[] = [];
	let idle = false;
	const statuses = new Map<string, string>();
	let waiter: (() => void) | undefined;
	const settle = () => waiter?.();
	let failures = options.failDeliveries ?? 0;
	const pi = Object.assign(fake.pi, {
		// 与宿主一致：triggerTurn 在歇透时开回合，sendMessage 先返回，回合稍后才 agent_start。
		sendMessage: (message: any, sendOptions: any) => {
			if (failures > 0) { failures--; settle(); throw new Error("投递失败"); }
			messages.push({ message, options: sendOptions });
			settle();
			if (sendOptions?.triggerTurn && idle) setTimeout(() => void fake.fire("agent_start", {}, context.ctx), 0);
		},
	});
	const sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const createContext = () => {
		let retired = false;
		const staleAccesses: string[] = [];
		const raw = {
			cwd,
			isIdle: () => idle,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => main.getSessionFile(),
				getEntries: () => [],
			},
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: (key: string, value: string | undefined) => {
					if (value === undefined) statuses.delete(key);
					else statuses.set(key, value);
				},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		const ctx = new Proxy(raw, {
			get(target, property, receiver) {
				if (retired) {
					staleAccesses.push(String(property));
					throw new Error(`stale ctx.${String(property)}`);
				}
				return Reflect.get(target, property, receiver);
			},
		});
		return { ctx, staleAccesses, retire: () => { retired = true; } };
	};
	const context = createContext();
	module.registerWatcher(pi, pool);
	const emit = (name: string, event: any, ctx = context.ctx) => fake.fire(name, event, ctx);
	await emit("session_start", { type: "session_start", reason: "startup" });
	return {
		pool,
		messages,
		notices,
		statuses,
		set idle(value: boolean) { idle = value; },
		// 建议只存在于信封正文：标题行、单行建议、权衡声明。
		notes: () => messages.map(({ message }) => {
			const [, headline, note] = String(message.content).split("\n");
			return { note, turnIndex: Number(/第 (\d+) 回合/u.exec(headline)?.[1]) };
		}),
		pi,
		emit,
		fire: fake.fire,
		context,
		createContext,
		sessionStart: (ctx: any) => emit("session_start", { type: "session_start", reason: "switch" }, ctx),
		next: () => new Promise<void>((resolve) => { waiter = () => { waiter = undefined; resolve(); }; }),
		command: (args: string) => commands.get("fire-watch").handler(args, context.ctx),
		turnEnd: (turnIndex: number, text: string, toolResults: any[] = [], toolCalls: any[] = [], ctx = context.ctx) =>
			emit("turn_end", {
				type: "turn_end",
				turnIndex,
				message: { role: "assistant", content: [{ type: "text", text }, ...toolCalls] },
				toolResults,
			}, ctx),
	};
}
