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
async function setup(options: { background?: unknown; timing?: Record<string, number>; settings?: Record<string, unknown>; failing?: string[]; down?: string[] } = {}) {
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
	const pool = new InProcessSessionPool({ timing: options.timing, firecode: (child: any) => registerFirecode(child, true, pool) });

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
	await session.bindExtensions({ mode: "print", uiContext: ui, onError: (error: any) => errors.push(error.error) });
	cleanups.push(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const compactions = () => session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction");
	const wake = (text: string) => deliver(host.pi, host.ctx, { customType: "firecode-master-event", content: wrapEnvelope("firecode_master_event", text) });
	return { session, pool, requests, notices, errors, host, compactions, wake, cwd };
}

/** 写摘要的模型（去重：切在回合中间时 pi 一次压缩发两个摘要请求）。 */
const summaries = (requests: Request[]) => [...new Set(requests.filter((request) => request.summary).map((request) => request.model))];
const conversation = async (session: any, turns = 3) => {
	for (let turn = 1; turn <= turns; turn++) await session.prompt(`turn ${turn} ${"word ".repeat(2_000)}`);
};

test("/compact：后台链写摘要，窗口放不下的候选被跳过，会话模型不写摘要，摘要经 pi 的压缩条目持久化", async () => {
	const { session, requests, compactions } = await setup({ background: { model: [SMALL, LUNA] } });
	await conversation(session);
	const result = await session.compact();
	expect(summaries(requests)).toEqual(["luna"]);
	expect(result.summary).toStartWith("SUMMARY by luna");
	expect(compactions()).toHaveLength(1);
	expect(compactions()[0].summary).toStartWith("SUMMARY by luna");
	expect(compactions()[0].usage.output).toBeGreaterThan(0);
	// 附加指令也计入输入量：普通摘要放得下的 medium，加上一大段附加指令就放不下，跳到 luna。
	const { session: other, requests: otherRequests } = await setup({ background: { model: [MEDIUM, LUNA] } });
	await conversation(other);
	await other.compact();
	expect(summaries(otherRequests)).toEqual(["medium"]);
	await conversation(other);
	otherRequests.length = 0;
	await other.compact("focus ".repeat(20_000));
	expect(summaries(otherRequests)).toEqual(["luna"]);
});

test("阈值自动压缩同样由后台链写摘要", async () => {
	const { session, requests, compactions } = await setup({
		background: { model: [LUNA] },
		settings: { compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 1_000_000 - 3_000 } },
	});
	await conversation(session, 2);
	await until(() => compactions().length === 1);
	expect(summaries(requests)).toEqual(["luna"]);
	expect(compactions()[0].summary).toContain("SUMMARY by luna");
});

test("后台链全部失败：出一条提示，pi 默认压缩用会话模型完成", async () => {
	const { session, requests, notices, compactions } = await setup({ background: { model: [SMALL, LUNA] }, failing: ["luna"] });
	await conversation(session);
	await session.compact();
	expect(summaries(requests)).toEqual(["luna", "session"]);
	expect(notices.filter((text) => text.includes("后台模型没能写出压缩摘要"))).toHaveLength(1);
	expect(notices.join()).toContain("luna overloaded");
	expect(compactions()[0].summary).toStartWith("SUMMARY by session");
});

test("省略 background：压缩回到 pi 默认（会话模型写摘要）", async () => {
	const { session, requests } = await setup();
	await conversation(session);
	await session.compact();
	expect(summaries(requests)).toEqual(["session"]);
});

test("子会话的压缩同样由后台链写摘要并持久化", async () => {
	const { pool, requests, cwd } = await setup({ background: { model: [LUNA] } });
	const spawned = await pool.spawn({
		cwd, chain: [{ model: "test/session", thinking: "low" }], tools: [], contextFiles: false,
		systemPrompt: { mode: "append", text: "" }, persistence: { type: "memory" },
	});
	cleanups.push(() => spawned.dispose());
	await conversation(spawned.session);
	await spawned.session.compact();
	expect(summaries(requests)).toEqual(["luna"]);
	expect(spawned.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")[0].summary).toStartWith("SUMMARY by luna");
});

/** 窗口 100 万的物理模型，按模型覆写 reserve 后阈值是 3000 token；一轮对话约 2500 token，第二轮越线。默认 reserve（5 万）下远不到阈值。 */
const OVERRIDE = { reserveTokens: 1_000_000 - 3_000 };

test.each([
	["子代理路由到有覆写的模型：在物理窗口 − 覆写 reserve 处自动压缩", { "test/session": OVERRIDE }, [], ["test/session"]],
	["链换到另一个物理模型后用那个模型的阈值", { "test/luna": OVERRIDE }, ["session"], ["test/session", "test/luna"]],
] as const)("%s，摘要由后台链写", async (_name, modelOverrides, down, chain) => {
	const { pool, requests, cwd } = await setup({
		background: { model: [MEDIUM] },
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

const IDLE = { cacheTtlMs: 900, idleCompactionLeadMs: 700 };
const sessionRequests = (requests: Request[]) => requests.filter((request) => !request.summary);

/** 一大轮加一小轮对话后歇下（保留段之前要有可摘要的内容），等预算摘要的请求发出并落定。 */
async function idleSession(timing = IDLE) {
	const harness = await setup({ background: { model: [LUNA] }, timing });
	await harness.session.prompt(`big ${HUGE}`);
	await harness.session.prompt(`follow-up ${"word ".repeat(400)}`);
	await until(() => summaries(harness.requests).length === 1);
	await Bun.sleep(20);
	return harness;
}

test.each([["用户消息"], ["指挥官事件"]])("闲置超过缓存过期线：%s触发的下一次请求从预算好的摘要开始", async (trigger) => {
	const harness = await idleSession();
	const { session, requests, notices, host, compactions } = harness;
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
	expect(notices.find((text) => text.startsWith("已闲置"))).toMatch(/已闲置 \d+ 分钟，缓存已过期：用 test\/luna 的摘要压缩，上下文 \d+k → \d+k/u);
});

test("闲置未超过缓存过期线：请求原样发出，预算的摘要被丢弃", async () => {
	const { session, requests, compactions } = await idleSession({ cacheTtlMs: 5_000, idleCompactionLeadMs: 4_800 });
	await session.prompt("quick follow-up");
	expect(sessionRequests(requests).at(-1)!.text.length).toBeGreaterThan(HUGE.length);
	expect(compactions()).toHaveLength(0);
});

test("闲置期间会话末端变了：过期后也不应用，请求带完整上下文", async () => {
	const { session, requests, host, compactions } = await idleSession();
	host.pi.appendEntry("test-marker", {});
	await until(() => Date.now() >= host.settledAt! + IDLE.cacheTtlMs + 50);
	await session.prompt("after a change");
	expect(sessionRequests(requests).at(-1)!.text.length).toBeGreaterThan(HUGE.length);
	expect(compactions()).toHaveLength(0);
});

test("子会话闲置超过缓存过期线：下一次请求同样从预算好的摘要开始", async () => {
	const { pool, requests, cwd } = await setup({ background: { model: [LUNA] }, timing: IDLE });
	const spawned = await pool.spawn({
		cwd, chain: [{ model: "test/session", thinking: "low" }], tools: [], contextFiles: false,
		systemPrompt: { mode: "append", text: "" }, persistence: { type: "memory" },
	});
	cleanups.push(() => spawned.dispose());
	let settledAt = 0;
	spawned.session.subscribe((event: any) => { if (event.type === "agent_end") settledAt = Date.now(); });
	await spawned.session.prompt(`big ${HUGE}`);
	await spawned.session.prompt(`follow-up ${"word ".repeat(400)}`);
	await until(() => summaries(requests).length === 1);
	await until(() => Date.now() >= settledAt + IDLE.cacheTtlMs + 50);
	await spawned.session.prompt("next task");
	const last = sessionRequests(requests).at(-1)!;
	expect(last.text).toContain("SUMMARY by luna");
	expect(last.text.length).toBeLessThan(HUGE.length / 10);
	expect(spawned.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
});
