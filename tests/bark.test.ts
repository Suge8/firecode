import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBarkPayload, hasPendingDisposition } from "../session/bark.js";
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

test("有待拍板事件时升 timeSensitive 并带副标题，否则 active 无副标题", () => {
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
const realHome = process.env.HOME;
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	await cleanupFirecodeModules();
});

test("Bark 只在会话真正歇下时推送：有子代理在飞的等待期不推，最后一个落定且指挥官歇下后推一次", async () => {
	const home = await mkdtemp(join(tmpdir(), "firecode-bark-home-"));
	try {
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, ".pi", "agent", "bark-key"), "https://bark.test/key/\n");
		process.env.HOME = home;
		const pushes: string[] = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => { pushes.push(init.body); return new Response("ok"); }) as never;
		const { registerBark } = await loadFirecodeModule("session/bark.ts") as any;
		const events = new Map<string, Function>();
		const bus = new Map<string, Function>();
		registerBark({
			on: (event: string, fn: Function) => events.set(event, fn),
			events: { on: (channel: string, fn: Function) => bus.set(channel, fn) },
			getSessionName: () => "会话",
		});
		const ctx = { cwd: "/tmp/project", isIdle: () => true, sessionManager: { getSessionId: () => "sid" } };
		events.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "已派发" }] } });
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
