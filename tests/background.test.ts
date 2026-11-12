import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFaux } from "./faux-host.ts";
import { featuresOnly, firecodeModulePath, loadFirecodeModule, PI_AI_COMPAT_URL, PI_CODING_AGENT_URL } from "./loader.ts";
import { until } from "./until.ts";

const { fauxAssistantMessage } = await import(PI_AI_COMPAT_URL) as any;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(PI_CODING_AGENT_URL) as any;

const LUNA = "test/luna/low";
/** 上下文窗口放不下这次摘要输入的候选：链上排在 luna 前面，应被跳过、不收到请求。 */
const SMALL = "test/small/low";
/** 放得下普通摘要输入、放不下再加一大段 /compact 附加指令的候选。 */
const MEDIUM = "test/medium/low";
const WINDOWS = { "test/session": 1_000_000, "test/luna": 1_000_000, "test/small": 4_000, "test/medium": 40_000 };
/** 闲置压缩只在上下文 ≥15 万 token 时预算；faux 按 4 字符 1 token 估算用量。 */
const HUGE = "history ".repeat(80_000);

const directories: string[] = [];
let faux: any;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	faux?.unregister();
	faux = undefined;
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

interface Request { model: string; summary: boolean; text: string }

/**
 * 真实主会话（registerFirecode）+ 真实池 + faux 供应商。会话模型是 test/session；
 * 每个请求按模型记下，摘要请求（pi 的摘要系统提示）回“SUMMARY by <模型>”，失败名单里的模型报错；down 里的模型对会话请求报过载。
 */
async function setup(options: { child?: (pi: any) => void; naming?: (text: string) => string | Promise<string>; background?: unknown; timing?: Record<string, number>; settings?: Record<string, unknown>; failing?: string[]; down?: string[] } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "firecode-background-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: false, keepRecentTokens: 200 }, retry: { enabled: false }, cacheWarming: "off", ...options.settings,
	}));
	faux = await installFaux(agentDir, ["test/session", "test/small", "test/medium", "test/luna"], [], WINDOWS);
	const requests: Request[] = [];
	const step = (context: any, _options: unknown, _state: unknown, model: any) => {
		const text = JSON.stringify(context);
		const summary = text.includes("context summarization assistant");
		if (text.includes("You name a coding session") || text.includes("你给终端里的编程会话起名")) {
			requests.push({ model: model.id, summary: false, text: "NAMING " + JSON.stringify(context.messages) });
			return Promise.resolve(options.naming?.(JSON.stringify(context.messages)) ?? "").then((name) => fauxAssistantMessage(name));
		}
		requests.push({ model: model.id, summary, text: JSON.stringify(context.messages) });
		if (!summary && options.down?.includes(model.id)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: `${model.id} overloaded` });
		if (summary && options.failing?.includes(model.id)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: `${model.id} overloaded` });
		return fauxAssistantMessage(summary ? `SUMMARY by ${model.id}` : "reply");
	};
	faux.setResponses(Array.from({ length: 60 }, () => step));

	const moduleOptions = { configJsonc: JSON.stringify({ features: await featuresOnly(), ...(options.background ? { background: options.background } : {}) }) };
	const { registerFirecode } = await loadFirecodeModule("index.ts", moduleOptions) as any;
	const { InProcessSessionPool } = await import(await firecodeModulePath("spawn.ts", moduleOptions)) as any;
	const { deliver, wrapEnvelope } = await import(await firecodeModulePath("deliver.ts", moduleOptions)) as any;
	const pool = new InProcessSessionPool({ timing: options.timing, firecode: (child: any) => { registerFirecode(child, true, pool); options.child?.(child); } });

	const host: { pi?: any; ctx?: any; settledAt?: number } = {};
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [{ name: "firecode", factory: (pi: any) => {
			registerFirecode(pi, false, pool);
			host.pi = pi;
			pi.on("session_start", (_event: unknown, ctx: unknown) => { host.ctx = ctx; });
			pi.on("agent_settled", () => { host.settledAt = Date.now(); });
		} }],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const { session } = await createAgentSession({
		cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), modelRuntime,
		model: modelRuntime.getModel("test", "session"), tools: [],
	});
	const notices: string[] = [];
	const errors: string[] = [];
	const ui = new Proxy({ notify: (text: string) => notices.push(text) }, { get: (target: any, key) => target[key] ?? (() => undefined) });
	await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error: any) => errors.push(error.error) });
	cleanups.push(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const compactions = () => session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction");
	// 与指挥官的投递队列同序：先把待投递事件落盘，再投递。
	const wake = (text: string) => {
		host.pi.appendEntry("firecode-master-pending-event", { id: "event", content: text });
		return deliver(host.pi, host.ctx, { customType: "firecode-master-event", content: wrapEnvelope("firecode_master_event", text) });
	};
	return { session, pool, requests, notices, errors, host, compactions, wake, cwd };
}

/** 写摘要的模型（去重：切在回合中间时 pi 一次压缩发两个摘要请求）。 */
const summaries = (requests: Request[]) => [...new Set(requests.filter((request) => request.summary).map((request) => request.model))];
const conversation = async (session: any, turns = 3) => {
	for (let turn = 1; turn <= turns; turn++) await session.prompt(`turn ${turn} ${"word ".repeat(2_000)}`);
};

test("/compact：后台链写摘要，窗口放不下的候选被跳过，会话模型不写摘要，摘要经 pi 的压缩条目持久化", async () => {
	const { session, requests, compactions } = await setup({ background: { lineModel: [SMALL, LUNA], compactionModel: [SMALL, LUNA] } });
	await conversation(session);
	const result = await session.compact();
	expect(summaries(requests)).toEqual(["luna"]);
	expect(result.summary).toStartWith("SUMMARY by luna");
	expect(compactions()).toHaveLength(1);
	expect(compactions()[0].summary).toStartWith("SUMMARY by luna");
});

test("后台链全部失败：出一条提示，pi 默认压缩用会话模型完成", async () => {
	const { session, requests, notices, compactions } = await setup({ background: { lineModel: [SMALL, LUNA], compactionModel: [SMALL, LUNA] }, failing: ["luna"] });
	await conversation(session);
	await session.compact();
	expect(summaries(requests)).toEqual(["luna", "session"]);
	expect(notices.join()).toContain("luna overloaded");
	expect(compactions()[0].summary).toStartWith("SUMMARY by session");
});

test("省略 background：压缩回到 pi 默认（会话模型写摘要），也不发起名请求", async () => {
	const { session, requests } = await setup({ naming: () => "Auto name" });
	await conversation(session);
	await session.compact();
	expect(summaries(requests)).toEqual(["session"]);
	expect(session.sessionManager.getSessionName()).toBeUndefined();
	expect(requests.filter((request) => request.text.startsWith("NAMING"))).toHaveLength(0);
});

/** 窗口 100 万的物理模型，按模型覆写 reserve 后阈值是 3000 token；一轮对话约 2500 token，第二轮越线。默认 reserve（5 万）下远不到阈值。 */
const OVERRIDE = { reserveTokens: 1_000_000 - 3_000 };

test.each([
	["子代理路由到有覆写的模型：在物理窗口 − 覆写 reserve 处自动压缩", { "test/session": OVERRIDE }, [], ["test/session"]],
	["链换到另一个物理模型后用那个模型的阈值", { "test/luna": OVERRIDE }, ["session"], ["test/session", "test/luna"]],
] as const)("%s，摘要由后台链写", async (_name, modelOverrides, down, chain) => {
	const { pool, requests, cwd } = await setup({
		background: { lineModel: [MEDIUM], compactionModel: [MEDIUM] },
		settings: { compaction: { enabled: true, keepRecentTokens: 200, modelOverrides } },
		down: [...down],
	});
	const spawned = await pool.spawn({
		cwd, chain: chain.map((model) => ({ model, thinking: "low" })), tools: [], contextFiles: false,
		systemPrompt: { mode: "append", text: "" }, persistence: { type: "memory" },
	});
	cleanups.push(() => spawned.dispose());
	const compactions = () => spawned.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction");
	await conversation(spawned.session, 1);
	expect(compactions()).toHaveLength(0);
	await conversation(spawned.session, 1);
	await until(() => compactions().length === 1);
	expect(compactions()[0].tokensBefore).toBeGreaterThan(3_000);
	expect(compactions()[0].summary).toContain("SUMMARY by medium");
	expect(sessionRequests(requests).at(-1)!.model).toBe(chain.at(-1)!.slice("test/".length));
});

/** 闲置压缩只对未关闭压缩的会话生效，setup 默认关着。 */
const ENABLED = { compaction: { enabled: true, keepRecentTokens: 200 } };
const IDLE = { cacheTtlMs: 400, idleCompactionLeadMs: 200 };
const sessionRequests = (requests: Request[]) => requests.filter((request) => !request.summary);

/** 一大轮加一小轮对话后歇下（保留段之前要有可摘要的内容），等预算摘要的请求发出并落定。 */
async function idleSession(timing = IDLE) {
	const harness = await setup({ background: { lineModel: [LUNA], compactionModel: [LUNA] }, timing, settings: ENABLED });
	await harness.session.prompt(`big ${HUGE}`);
	await harness.session.prompt(`follow-up ${"word ".repeat(400)}`);
	await until(() => summaries(harness.requests).length === 1);
	await Bun.sleep(20);
	return harness;
}

test.each([["用户消息"], ["指挥官事件"]])("闲置超过缓存过期线：%s触发的下一次请求从预算好的摘要开始", async (trigger) => {
	const harness = await idleSession();
	const { session, requests, host, compactions } = harness;
	// 歇下到过期线这段是业务语义的等待：缓存是否过期只由闲置时长决定。
	await until(() => Date.now() >= host.settledAt! + IDLE.cacheTtlMs + 50);
	if (trigger === "用户消息") await session.prompt("next question");
	else {
		await harness.wake("worker done");
		await session.waitForIdle();
	}
	const last = sessionRequests(requests).at(-1)!;
	expect(last.text).toContain("SUMMARY by luna");
	expect(last.text.length).toBeLessThan(HUGE.length / 10);
	expect(summaries(requests)).toEqual(["luna"]);
	expect(compactions()).toHaveLength(1);
});

test("闲置未超过缓存过期线：请求原样发出，预算的摘要被丢弃", async () => {
	const { session, requests, compactions } = await idleSession({ cacheTtlMs: 5_000, idleCompactionLeadMs: 4_800 });
	await session.prompt("quick follow-up");
	expect(sessionRequests(requests).at(-1)!.text.length).toBeGreaterThan(HUGE.length);
	expect(compactions()).toHaveLength(0);
});

test("会话命名：第一句话后后台模型起名，主回复不等它；问候不设名、下一句再起；只起一次", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	const { session, requests } = await setup({
		background: { lineModel: [LUNA], compactionModel: [LUNA] },
		naming: async (input) => input.includes("hello") ? "" : (await held, "Fix login bug"),
	});
	const naming = () => requests.filter((request) => request.text.startsWith("NAMING"));
	await session.prompt("hello");
	await until(() => naming().length === 1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(session.sessionManager.getSessionName()).toBeUndefined();
	await session.prompt("please fix the login bug");
	expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	expect(session.sessionManager.getSessionName()).toBeUndefined();
	release();
	await until(() => session.sessionManager.getSessionName() === "Fix login bug");
	expect(naming().every((request) => request.model === "luna")).toBe(true);
	await session.prompt("another message");
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(naming()).toHaveLength(2);
});

test("会话命名：经 pi.sendUserMessage 送进来的第一句话（CuePad 桥接路径）同样起名", async () => {
	const { host, session } = await setup({ background: { lineModel: [LUNA], compactionModel: [LUNA] }, naming: () => "From bridge" });
	host.pi.sendUserMessage("fix the bridge");
	await until(() => session.sessionManager.getSessionName() === "From bridge");
});

test("关掉还在跑的子代理：会话内的扩展先收到这一轮落定，再收到会话关闭", async () => {
	const seen: string[] = [];
	const { pool, cwd } = await setup({ child: (pi) => {
		for (const event of ["agent_settled", "session_shutdown"]) pi.on(event, () => { seen.push(event); });
	} });
	const entered = Promise.withResolvers<void>();
	faux.setResponses([async (_context: any, options: any) => {
		entered.resolve();
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("", { stopReason: "aborted" });
	}]);
	const spawned = await pool.spawn({
		cwd, chain: [{ model: "test/session", thinking: "low" }], tools: [], contextFiles: false,
		systemPrompt: { mode: "append", text: "" }, persistence: { type: "memory" },
	});
	const running = spawned.prompt("long task").catch(() => undefined);
	await entered.promise;
	await spawned.dispose();
	await running;
	expect(seen).toEqual(["agent_settled", "session_shutdown"]);
});

test("模型流卡死、不理会中止时，关会话等过宽限照常收口", async () => {
	const seen: string[] = [];
	const { pool, cwd } = await setup({ timing: { abortSettleMs: 50 }, child: (pi) => {
		for (const event of ["agent_settled", "session_shutdown"]) pi.on(event, () => { seen.push(event); });
	} });
	const entered = Promise.withResolvers<void>();
	faux.setResponses([() => {
		entered.resolve();
		return new Promise(() => {});
	}]);
	const spawned = await pool.spawn({
		cwd, chain: [{ model: "test/session", thinking: "low" }], tools: [], contextFiles: false,
		systemPrompt: { mode: "append", text: "" }, persistence: { type: "memory" },
	});
	void spawned.prompt("stuck").catch(() => undefined);
	await entered.promise;
	await spawned.dispose();
	expect(seen).toEqual(["session_shutdown"]);
});
