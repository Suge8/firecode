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

async function barkHarness(run: (h: { emit: (event: string, ...args: unknown[]) => void; ctx: unknown }) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "firecode-bark-home-"));
	try {
		await writeFile(join(home, "bark-key"), "https://bark.test/key/\n");
		process.env.PI_CODING_AGENT_DIR = home;
		const pushes: string[] = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => { pushes.push(init.body); return new Response("ok"); }) as never;
		const { registerBark } = await loadFirecodeModule("session/bark.ts") as any;
		const handlers = new Map<string, Function[]>();
		registerBark({
			on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
			events: { on() {} },
			getSessionName: () => "会话",
		});
		const ctx = { cwd: "/tmp/project", isIdle: () => true, sessionManager: { getSessionId: () => "sid" } };
		await run({
			emit: (event, ...args) => handlers.get(event)?.forEach((fn) => fn(...args)),
			ctx,
		});
		await Bun.sleep(5);
		return pushes;
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const reply = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }], usage: { output: 3 }, stopReason: "stop" } });

test("会话歇下时推送最后一条回复", async () => {
	const pushes = await barkHarness(async ({ emit, ctx }) => {
		emit("agent_start", {}, ctx);
		emit("message_end", reply("已完成"));
		emit("agent_settled", {}, ctx);
	});
	expect(pushes.map((body) => JSON.parse(body).body)).toEqual(["已完成"]);
});
