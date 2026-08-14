import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const savedEnv = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "FIRECODE_MASTER_WORKER"].map(
	(name) => [name, process.env[name]] as const,
);

afterEach(async () => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await cleanupFirecodeModules();
});

test("master mode is opt-in and only appends herdr_agents", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js")) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { promptGuidelines?: string[] }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	let activeTools = ["read", "write", "edit", "bash"];
	const notices: string[] = [];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; promptGuidelines?: string[] }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx(notices);
	module.registerMaster(pi);
	expect([...tools.keys()]).toEqual(["herdr_agents"]);
	expect(tools.get("herdr_agents")?.promptGuidelines?.join()).toContain("custom follow-up message");
	expect(activeTools).toEqual(["read", "write", "edit", "bash"]);

	await commands.get("fire-master")?.handler("", ctx);
	expect(activeTools).toEqual(["read", "write", "edit", "bash", "herdr_agents"]);
	for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "reload" }, ctx);
	expect(activeTools).toEqual(["read", "write", "edit", "bash"]);
});

test("a failed recovery rolls activation back so the next attempt retries", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					static resumeCalls = 0;
					async resume() {
						HerdrWorkers.resumeCalls += 1;
						if (HerdrWorkers.resumeCalls === 1) throw new Error("temporary Herdr failure");
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let activeTools = ["read", "bash"];
	const notices: string[] = [];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = tools; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx(notices);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	expect(activeTools).toEqual(["read", "bash"]);
	await commands.get("fire-master")?.handler("", ctx);
	expect(notices[0]).toContain("temporary Herdr failure");
	expect(activeTools).toEqual(["read", "bash", "herdr_agents"]);
});

test("Worker results return as follow-up custom messages", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.notify = options.notifyMaster; }
					async resume() {}
					async start() {
						this.notify("Worker worker-1 已停下\\n回复：完成");
						return { name: "worker-1", model: "p/m", thinking: "medium", status: "idle" };
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	let activeTools = ["read", "bash"];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => messages.push({ message, options }),
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx([]);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	await tools.get("herdr_agents")?.execute("call", { action: "start", prompt: "做" }, undefined, undefined, ctx);
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(messages).toEqual([{
		message: { customType: "firecode-master-event", content: "Worker worker-1 已停下\n回复：完成", display: true },
		options: { deliverAs: "followUp", triggerTurn: true },
	}]);
});

test("review action exposes reviewing in Master status without accepting prompt content", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.store = options.store; }
					async resume() {}
					async start() {
						const worker = { name: "worker-1", paneId: "w1:p2", tabId: "w1:t2", sessionPath: "/tmp/worker.jsonl", model: "p/m", thinking: "medium", status: "idle" };
						this.store.dispatch({ type: "UPSERT_WORKER", worker });
						return worker;
					}
					async review(worker) {
						if (arguments.length !== 1) throw new Error("review received injected parameters");
						const current = this.store.state.workers.find((item) => item.name === worker);
						this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "reviewing" } });
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	let activeTools = ["read"];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = {
		...makeCtx(notices),
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value?: string) => statuses.push(value),
		},
	};
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	await tools.get("herdr_agents")?.execute("call", { action: "start", prompt: "做" }, undefined, undefined, ctx);
	const result = await tools.get("herdr_agents")?.execute(
		"call",
		{ action: "review", worker: "worker-1", prompt: "malicious override" },
		undefined,
		undefined,
		ctx,
	);
	await commands.get("fire-master")?.handler("status", ctx);
	expect(result?.details).toEqual({ reviewing: true });
	expect(statuses.at(-1)).toContain("1 reviewing");
	expect(notices.at(-1)).toContain("worker-1 reviewing");
	await commands.get("fire-master")?.handler("off", ctx);
});

test("Worker keeps pi default tools minus the Master tool and cannot edit/write outside the checkout", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.FIRECODE_MASTER_WORKER = "worker";
	const module = (await loadFirecodeModule("master/index.js")) as { registerMaster: (pi: unknown) => void };
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	let activeTools = ["read", "bash", "herdr_agents"];
	const pi = {
		registerCommand() {},
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const ctx = makeCtx([], directory);
	module.registerMaster(pi);
	for (const start of handlers.get("session_start") ?? []) await start({}, ctx);
	// ADR-0004：Worker 就是普通 pi（含 bash），只拿不到 Master 工具。
	expect(activeTools).toEqual(["read", "bash"]);
	const guard = handlers.get("tool_call")?.[0];
	expect(guard).toBeDefined();
	for (const path of [
		"package.json",
		"vcpkg.json",
		"node_modules/pkg/source.ts",
		"__pypackages__/lib/source.py",
	]) expect(await guard?.({ toolName: "edit", input: { path } }, ctx)).toBeUndefined();
	expect(await guard?.({ toolName: "write", input: { path: "../outside.ts" } }, ctx)).toEqual({
		block: true,
		reason: "工人只能修改当前 checkout：../outside.ts",
	});
	expect(await guard?.({ toolName: "edit", input: { path: "src/index.ts" } }, ctx)).toBeUndefined();
	await rm(directory, { recursive: true, force: true });
});

test("review action is refused before delivery when fire-review is unavailable", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		configJsonc: '{"features":{"review":false}}',
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.store = options.store; }
					async resume() {}
					async review() { throw new Error("review 不应被投递"); }
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
	let activeTools = ["read"];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx([]);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	await expect(
		tools.get("herdr_agents")?.execute("call", { action: "review", worker: "w" }, undefined, undefined, ctx),
	).rejects.toThrow("fire-review 已关闭");
});

test("worker events wait out a running Master turn and merge into one follow-up", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { globalThis.__fcNotify = options.notifyMaster; }
					async resume() {}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: string[] = [];
	let activeTools = ["read"];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage: (message: { content: string }) => { sent.push(message.content); },
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	// isIdle 恒为 true：宿主在 emit agent_settled 前就置 idle，合并门槛必须是显式回合位而非 isIdle。
	const ctx = { ...makeCtx([]), isIdle: () => true };
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	const notify = (globalThis as { __fcNotify?: (content: string) => void }).__fcNotify;
	// 回合开始（agent_start）后到达的两条错峰结果都不投递，哪怕 isIdle 已经报 true。
	for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
	notify?.("结果 A");
	await new Promise((resolve) => setTimeout(resolve, 150));
	notify?.("结果 B");
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(sent).toEqual([]);
	// agent_settled 才是回合边界：之后合并成一条 follow-up。
	for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(sent).toEqual(["结果 A\n\n结果 B"]);
	delete (globalThis as { __fcNotify?: unknown }).__fcNotify;
});

function makeCtx(notices: string[], cwd = "/tmp") {
	return {
		cwd,
		isIdle: () => true,
		hasPendingMessages: () => false,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "medium",
		sessionManager: { getSessionId: () => crypto.randomUUID(), getBranch: () => [] },
		ui: { notify: (message: string) => notices.push(message), setStatus() {} },
	};
}
