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
	expect((listed.details as any).workers).toEqual([{ ...worker, status: "idle" }]);
	expect(harness.messages[0]).toMatchObject({
		message: { content: "子代理 trace 已停下\n回复：\n确定性完成" },
		options: { deliverAs: "steer", triggerTurn: false },
	});
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

test("T3 动作在集成分支显式拒绝", async () => {
	const harness = await setup();
	for (const action of ["send", "interrupt", "review", "tail", "ack"])
		await expect(harness.execute({ action })).rejects.toThrow(`T3 未实现：${action}`);
});

async function setup(activate = true) {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-sdk-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
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
	modelRuntime.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [{
			id: fauxModel.id,
			name: fauxModel.name,
			api: fauxModel.api,
			reasoning: fauxModel.reasoning,
			input: fauxModel.input,
			cost: fauxModel.cost,
			contextWindow: fauxModel.contextWindow,
			maxTokens: fauxModel.maxTokens,
			baseUrl: fauxModel.baseUrl,
		}],
	});
	if (!modelRuntime.hasConfiguredAuth("faux")) throw new Error("测试 Faux 模型认证未载入");
	const pool = new (spawnModule as any).InProcessSessionPool({ agentDir, modelRuntime });
	const module = await loadFirecodeModule("master/index.js", {
		configJsonc: JSON.stringify({
			features: { master: true, review: false },
			review: TEST_REVIEW_CONFIG,
			master: { models: [TEST_MODEL], workerExcludeExtensions: [] },
		}),
	}) as any;
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notices: string[] = [];
	const messages: any[] = [];
	let onMessage: (() => void) | undefined;
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		sendMessage: (message: any, options: any) => { messages.push({ message, options }); onMessage?.(); },
	};
	const sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	module.registerMaster(pi, { resolveModel: async () => faux.getModel(), pool });
	const command = (args: string) => commands.get("fire-master").handler(args, ctx);
	if (activate) await command("");
	return {
		cwd,
		sessionId,
		notices,
		messages,
		set onMessage(value: (() => void) | undefined) { onMessage = value; },
		command,
		execute: (params: Record<string, unknown>) => tools.get("subagents").execute("call", params, undefined, undefined, ctx),
	};
}
