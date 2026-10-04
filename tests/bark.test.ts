import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const worker = (disposition?: "pending" | "reminded") => ({
	name: "w1",
	role: "工程师",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
	status: "idle",
	sessionPath: "/tmp/w1.jsonl",
	...(disposition ? { disposition } : {}),
});

test("有待拍板事件时升 timeSensitive 并带副标题，否则 active 无副标题", async () => {
	const { buildBarkPayload } = await loadFirecodeModule("session/bark.ts") as any;
	const base = { title: "s", body: "b", group: "g", sessionId: "sid" };
	const urgent = buildBarkPayload({ ...base, awaitingDecision: true });
	expect(urgent.level).toBe("timeSensitive");
	expect(urgent.subtitle).toBe("待拍板");
	const normal = buildBarkPayload({ ...base, awaitingDecision: false });
	expect(normal.level).toBe("active");
	expect(normal.subtitle).toBeUndefined();
	// 同会话固定 id：新通知经 APNs CollapseID 顶掉旧通知。
	expect(urgent.id).toBe("sid");
});

test("v8 待发落 Worker 触发待拍板，空池、文件缺失与损坏均不触发", async () => {
	const { hasPendingDisposition } = await loadFirecodeModule("session/bark.ts") as any;
	const dir = await mkdtemp(join(tmpdir(), "firecode-bark-"));
	try {
		const path = join(dir, "state.json");
		await writeFile(path, JSON.stringify({ version: 8, workers: [worker("pending")] }));
		expect(hasPendingDisposition(path)).toBe(true);
		await writeFile(path, JSON.stringify({ version: 8, workers: [worker()] }));
		expect(hasPendingDisposition(path)).toBe(false);
		expect(hasPendingDisposition(join(dir, "missing.json"))).toBe(false);
		await writeFile(path, "not json");
		expect(hasPendingDisposition(path)).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

const realFetch = globalThis.fetch;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	await cleanupFirecodeModules();
});

test("Bark 只在会话真正歇下时推送：有子代理在飞的等待期不推，最后一个落定且指挥官歇下后推一次", async () => {
	const home = await mkdtemp(join(tmpdir(), "firecode-bark-home-"));
	try {
		await writeFile(join(home, "bark-key"), "https://bark.test/key/\n");
		process.env.PI_CODING_AGENT_DIR = home;
		const pushes: string[] = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => { pushes.push(init.body); return new Response("ok"); }) as never;
		const { registerBark } = await loadFirecodeModule("session/bark.ts") as any;
		// busy.ts 与 bark 都订阅 message_end：同名事件保留全部处理器。
		const handlers = new Map<string, Function[]>();
		const events = { get: (event: string) => (...args: unknown[]) => handlers.get(event)?.forEach((fn) => fn(...args)) };
		const bus = new Map<string, Function>();
		registerBark({
			on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
			events: { on: (channel: string, fn: Function) => bus.set(channel, fn) },
			getSessionName: () => "会话",
		});
		const ctx = { cwd: "/tmp/project", isIdle: () => true, sessionManager: { getSessionId: () => "sid" } };
		events.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "已派发" }], usage: { output: 3 }, stopReason: "stop" } });
		const settle = async () => { events.get("agent_settled")!({}, ctx); await Bun.sleep(5); };

		bus.get("firecode:workers")!({ inFlight: 2 });
		await settle();
		expect(pushes).toHaveLength(0);
		bus.get("firecode:workers")!({ inFlight: 1 });
		await settle();
		expect(pushes).toHaveLength(0);

		bus.get("firecode:workers")!({ inFlight: 0 });
		await settle();
		expect(pushes).toHaveLength(1);
		expect(JSON.parse(pushes[0]).body).toBe("已派发");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("闲时唤醒回合先于投递完成而结束：agent_settled 时不推，在飞数归零时恰好推一次", async () => {
	const home = await mkdtemp(join(tmpdir(), "firecode-bark-home-"));
	try {
		await writeFile(join(home, "bark-key"), "https://bark.test/key/\n");
		process.env.PI_CODING_AGENT_DIR = home;
		const pushes: string[] = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => { pushes.push(init.body); return new Response("ok"); }) as never;
		const { registerBark } = await loadFirecodeModule("session/bark.ts") as any;
		// busy.ts 与 bark 都订阅 message_end：同名事件保留全部处理器。
		const handlers = new Map<string, Function[]>();
		const events = { get: (event: string) => (...args: unknown[]) => handlers.get(event)?.forEach((fn) => fn(...args)) };
		const bus = new Map<string, Function>();
		registerBark({
			on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
			events: { on: (channel: string, fn: Function) => bus.set(channel, fn) },
			getSessionName: () => "会话",
		});
		const ctx = { cwd: "/tmp/project", isIdle: () => true, sessionManager: { getSessionId: () => "sid" } };
		bus.get("firecode:workers")!({ inFlight: 1 });
		events.get("agent_start")!({}, ctx);
		events.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "结果已处理" }], usage: { output: 3 }, stopReason: "stop" } });
		events.get("agent_settled")!({}, ctx);
		await Bun.sleep(5);
		expect(pushes).toHaveLength(0);

		bus.get("firecode:workers")!({ inFlight: 0 });
		await Bun.sleep(5);
		expect(pushes).toHaveLength(1);
		events.get("agent_settled")!({}, ctx);
		await Bun.sleep(5);
		expect(pushes).toHaveLength(1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
