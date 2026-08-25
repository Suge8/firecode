import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	cleanupFirecodeModules,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
} from "./loader.ts";

const { fauxAssistantMessage, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const TEST_MODEL = { model: "test/worker", thinking: "medium", use: "测试" };
const TEST_MODEL_2 = { model: "test/worker-2", thinking: "high", use: "切换测试" };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedWorkerMarker = process.env.FIRECODE_MASTER_WORKER;

let faux: any;
let directory: string | undefined;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedWorkerMarker === undefined) delete process.env.FIRECODE_MASTER_WORKER;
	else process.env.FIRECODE_MASTER_WORKER = savedWorkerMarker;
	await cleanupFirecodeModules();
});

test("subagents 以真 SDK 会话完成 start→事件落定→list→kill，文件隐藏在嵌套目录", async () => {
	const harness = await setup();
	await harness.emit("agent_start", {});
	faux.setResponses([fauxAssistantMessage("确定性完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });

	const started = await harness.execute({
		action: "start",
		worker: "trace",
		prompt: "只回复完成",
		model: "test/worker",
		thinking: "medium",
	});
	const worker = (started.details as any).worker;
	expect(worker.status).toBe("working");
	await settled;

	const listed = await harness.execute({ action: "list" });
	expect((listed.details as any).workers).toEqual([{ ...worker, status: "idle", disposition: "pending" }]);
	expect(harness.messages[0]).toMatchObject({
		message: { content: "子代理 trace 已停下\n回复：\n确定性完成" },
		options: { deliverAs: "steer", triggerTurn: false },
	});
	const trace = await harness.execute({ action: "tail", worker: "trace" });
	expect(trace.content[0].text).toContain("assistant: 确定性完成");
	const sessionPath = worker.session as string;
	expect(existsSync(sessionPath)).toBe(true);
	expect(dirname(sessionPath).endsWith("/subagents")).toBe(true);
	const { SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const visible = await SessionManager.list(harness.cwd, dirname(dirname(sessionPath)));
	expect(visible.some((session: any) => session.path === sessionPath)).toBe(false);

	await harness.execute({ action: "kill", worker: "trace" });
	expect((await harness.execute({ action: "list" }).then((result) => result.details as any)).workers).toEqual([]);
	expect(existsSync(sessionPath)).toBe(true);
});

test("进程内池拒绝同一 sessionPath 的第二个持有者，恢复缺失文件明确失败", async () => {
	const harness = await setup();
	const module = await loadFirecodeModule("master/spawn.js") as any;
	const sessionPath = join(directory!, "sessions", "subagents", "worker.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	const options = {
		cwd: harness.cwd,
		model: faux.getModel(),
		thinking: "medium",
		tools: [],
		systemPrompt: { mode: "replace", text: "test" },
		contextFiles: false,
		persistence: { type: "file", sessionPath },
	};
	const pool = new module.InProcessSessionPool();
	const first = await pool.spawn(options);
	await expect(pool.spawn(options)).rejects.toThrow("已有进程内会话持有");
	first.dispose();
	await expect(pool.spawn({ ...options, persistence: { ...options.persistence, resume: true } }))
		.rejects.toThrow("会话文件不存在");
	pool.disposeAll();
});

test("空闲会话自动释放后 kill 仍只删档案并保留会话文件", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "cold-kill", prompt: "完成", model: "test/worker", thinking: "medium",
	});
	await settled;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);
	await harness.execute({ action: "kill", worker: "cold-kill" });
	expect(existsSync(sessionPath)).toBe(true);
});

test("并发落定合并为一条 steer，投递前写 pending、成功后写 ack", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([
		async () => { await gate; return fauxAssistantMessage("结果 A"); },
		async () => { await gate; return fauxAssistantMessage("结果 B"); },
	]);
	await Promise.all([
		harness.execute({ action: "start", worker: "merge-a", prompt: "A", model: "test/worker", thinking: "medium" }),
		harness.execute({ action: "start", worker: "merge-b", prompt: "B", model: "test/worker", thinking: "medium" }),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("结果 A");
	expect(harness.messages[0].message.content).toContain("结果 B");
	expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	expect(harness.appended.map(([type]) => type)).toEqual([
		"firecode-master-pending-event",
		"firecode-master-pending-event",
		"firecode-master-event-ack",
	]);
});

test("在飞 send 拒绝；interrupt 落中断标记、定时提醒，首次 send 自动注入现场自检", async () => {
	const harness = await setup(true, { interruptResumeMs: 10 });
	let resumedPrompt = "";
	faux.setResponses([
		async (_context: any, options: any) => {
			await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("已中断");
		},
	]);
	await harness.execute({
		action: "start", worker: "interrupted", prompt: "开始", model: "test/worker", thinking: "medium",
	});
	await expect(harness.execute({ action: "send", worker: "interrupted", prompt: "急件" }))
		.rejects.toThrow("急件先 interrupt 再 send");
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "interrupted" });
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("已中断");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.messages.at(-1).message.content).toContain("自动续跑提醒");

	faux.setResponses([(context: any) => {
		resumedPrompt = context.messages.filter((message: any) => message.role === "user")
			.map((message: any) => typeof message.content === "string" ? message.content : message.content?.map((part: any) => part.text).join(""))
			.join("\n");
		return fauxAssistantMessage("续跑完成");
	}]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "interrupted", prompt: "继续" });
	await delivered;
	expect(resumedPrompt).toContain("上次被外部中断");
	expect(resumedPrompt).toContain("git status");
	const listed = (await harness.execute({ action: "list" }).then((result) => result.details as any)).workers[0];
	expect(listed.interruptedAt).toBeUndefined();
});

test("第 16 个在飞 Worker 被 admission 拒绝并回报当前清单", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses(Array.from({ length: 15 }, (_, index) => async () => {
		await gate;
		return fauxAssistantMessage(`完成 ${index}`);
	}));
	const starts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => harness.execute({
		action: "start", worker: `slot-${index}`, prompt: "等待", model: "test/worker", thinking: "medium",
	})));
	const rejected = starts.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
	expect(rejected).toHaveLength(1);
	expect(String(rejected[0].reason)).toMatch(/并发上限 15.*slot-/);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
});

test("fire-review 不可用时拒绝 start/send 挂审查义务", async () => {
	const harness = await setup();
	await expect(harness.execute({
		action: "start", worker: "blocked-review", prompt: "实现", model: "test/worker", thinking: "medium", review: true,
	})).rejects.toThrow("fire-review 已关闭");
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "plain", prompt: "实现", model: "test/worker", thinking: "medium",
	});
	await delivered;
	await expect(harness.execute({ action: "send", worker: "plain", prompt: "加审查义务", review: true }))
		.rejects.toThrow("fire-review 已关闭");
});

test("审查义务只能经显式 review 履行，未履行拒绝 ack，kill 随票删除", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("待删除")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "obligation", prompt: "实现", model: "test/worker", thinking: "medium", review: true,
	});
	await delivered;
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("此票有审查义务");
	await expect(harness.execute({ action: "ack", worker: "obligation" })).rejects.toThrow("完成 review 后才能 ack");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "obligation" });
	await delivered;
	expect(harness.messages).toHaveLength(2);
	expect(harness.messages[1].message.content).toContain("审查通过（1 轮）");
	await harness.execute({ action: "ack", worker: "obligation" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "discard-obligation", prompt: "实现", model: "test/worker", thinking: "medium", review: true,
	});
	await delivered;
	await harness.execute({ action: "kill", worker: "discard-obligation" });
	expect((await harness.execute({ action: "list" }).then((result) => result.details as any)).workers)
		.not.toContainEqual(expect.objectContaining({ name: "discard-obligation" }));
});

test("crash 恢复只重投 pending 减 ack 的差集", async () => {
	const harness = await setup(false);
	harness.entries.push(
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e1", content: "未确认结果" } },
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e2", content: "已确认结果" } },
		{ type: "custom", customType: "firecode-master-event-ack", data: { ids: ["e2"] } },
	);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.emit("session_start", {});
	await delivered;
	expect(harness.messages.map((entry) => entry.message.content)).toEqual(["未确认结果"]);
	expect(harness.appended).toEqual([["firecode-master-event-ack", { ids: ["e1"] }]]);
});

test("send 对冷 Worker 透明复活、省略模型沿用、显式模型与 thinking 原地切换并入会话记录", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([
		fauxAssistantMessage("第一轮"),
		fauxAssistantMessage("沿用完成"),
		fauxAssistantMessage("切换完成"),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "revive", prompt: "第一轮", model: "test/worker", thinking: "medium",
	});
	await delivered;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "revive", prompt: "沿用" });
	await delivered;
	let listed = (await harness.execute({ action: "list" }).then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", model: "test/worker", thinking: "medium" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "send", worker: "revive", prompt: "切换", model: "test/worker-2", thinking: "high",
	});
	await delivered;
	listed = (await harness.execute({ action: "list" }).then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", model: "test/worker-2", thinking: "high" });
	const sessionText = await Bun.file(sessionPath).text();
	expect(sessionText).toContain('"type":"model_change"');
	expect(sessionText).toContain('"type":"thinking_level_change"');
});

test("v6 状态由所有者丢弃并产生脱管告知", async () => {
	const harness = await setup(false);
	const state = await loadFirecodeModule("master/state.js") as any;
	const path = state.masterStatePath(harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 6, workers: [] }));
	try {
		await harness.command("");
		expect(harness.notices.join("\n")).toContain("旧版 v6 子代理池已丢弃");
		expect(harness.notices.join("\n")).toContain("已脱管");
		expect(await readdir(dirname(path))).not.toContain(path.split("/").pop());
	} finally {
		await rm(path, { force: true });
	}
});

test("Worker checkout 守卫绑定子会话身份，不受进程级环境标记后续变化影响", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const cwd = join(directory, "checkout");
	await mkdir(cwd);
	const module = await loadFirecodeModule("master/index.js", {
		configJsonc: JSON.stringify({
			features: { master: true, review: false },
			review: TEST_REVIEW_CONFIG,
			master: { models: [TEST_MODEL, TEST_MODEL_2] },
		}),
	}) as any;
	const register = () => {
		const handlers = new Map<string, any[]>();
		module.registerMaster({
			registerMessageRenderer() {}, registerCommand() {}, registerTool() {},
			getActiveTools: () => [], setActiveTools() {},
			on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			events: { on() {}, emit() {} },
		});
		return handlers.get("tool_call")?.[0];
	};

	process.env.FIRECODE_MASTER_WORKER = "guarded";
	const workerGuard = register();
	delete process.env.FIRECODE_MASTER_WORKER;
	const ctx = { cwd };
	expect(await workerGuard({ toolName: "write", input: { path: "../outside.ts" } }, ctx)).toEqual({
		block: true,
		reason: "子代理只能修改当前 checkout：../outside.ts",
	});
	expect(await workerGuard({ toolName: "edit", input: { path: "inside.ts" } }, ctx)).toBeUndefined();

	const masterGuard = register();
	process.env.FIRECODE_MASTER_WORKER = "another-worker-is-loading";
	expect(await masterGuard({ toolName: "write", input: { path: "../outside.ts" } }, ctx)).toBeUndefined();
});

async function setup(activate = true, options: {
	idleTimeoutMs?: number;
	interruptResumeMs?: number;
	review?: boolean;
	mockReview?: boolean;
} = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-sdk-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	if (options.mockReview) {
		const extensions = join(agentDir, "extensions");
		await mkdir(extensions);
		await writeFile(join(extensions, "mock-review.ts"), mockReviewExtension());
	}
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.FIRECODE_MASTER_WORKER;
	faux = registerFauxProvider();
	const { ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("master/spawn.js");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const fauxModel = faux.getModel();
	const alternateModel = { ...fauxModel, id: "worker-2", name: "Worker 2" };
	modelRuntime.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [fauxModel, alternateModel].map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	if (!modelRuntime.hasConfiguredAuth("faux")) throw new Error("测试 Faux 模型认证未载入");
	const pool = new (spawnModule as any).InProcessSessionPool({
		agentDir,
		modelRuntime,
		...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
	});
	const module = await loadFirecodeModule("master/index.js", {
		configJsonc: JSON.stringify({
			features: { master: true, review: options.review === true },
			review: TEST_REVIEW_CONFIG,
			master: { models: [TEST_MODEL, TEST_MODEL_2], workerExcludeExtensions: [] },
		}),
	}) as any;
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notices: string[] = [];
	const messages: any[] = [];
	const appended: Array<[string, any]> = [];
	const entries: any[] = [];
	let onMessage: (() => void) | undefined;
	let idle = true;
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry: (type: string, data: any) => {
			appended.push([type, data]);
			entries.push({ type: "custom", customType: type, data });
		},
		sendMessage: (message: any, options: any) => { messages.push({ message, options }); onMessage?.(); },
	};
	const sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const ctx = {
		cwd,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	module.registerMaster(pi, {
		resolveModel: async (id: string) => id === TEST_MODEL_2.model ? alternateModel : fauxModel,
		pool,
		...(options.interruptResumeMs === undefined ? {} : { interruptResumeMs: options.interruptResumeMs }),
	});
	const command = (args: string) => commands.get("fire-master").handler(args, ctx);
	if (activate) await command("");
	return {
		cwd,
		sessionId,
		notices,
		messages,
		appended,
		entries,
		pool,
		set idle(value: boolean) { idle = value; },
		set onMessage(value: (() => void) | undefined) { onMessage = value; },
		command,
		emit: async (name: string, event: any) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		execute: (params: Record<string, unknown>) => tools.get("subagents").execute("call", params, undefined, undefined, ctx),
	};
}

function mockReviewExtension(): string {
	const base = {
		version: 5, runId: "mock-review-run", round: 1, focus: "", pending: null, repair: null, summary: null,
		consecutiveFailures: 0, startedAt: 1, roundStartedAt: 1,
	};
	const reviewing = {
		...base, seq: 1, phase: "reviewing", history: [], updatedAt: 1,
		active: { round: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "running", result: null }], settledCount: 0 },
	};
	const settled = {
		...base, seq: 2, phase: "settled", active: null, updatedAt: 2,
		history: [{
			round: 1, result: "passed", details: "verified", elapsedMs: 1,
			reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "passed", summary: "ok", details: "verified" }],
		}],
	};
	return `export default function(pi) {
		pi.registerCommand("fire-review", {
			description: "mock review",
			handler: () => {
				pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(reviewing)});
				pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(settled)});
			},
		});
	}`;
}
