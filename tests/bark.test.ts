import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

const worker = (disposition?: "pending" | "reminded") => ({
	name: "w1",
	role: "工程师",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
	status: "idle",
	sessionPath: "/tmp/w1.jsonl",
	launch: 1,
	...(disposition ? { disposition } : {}),
});

const realFetch = globalThis.fetch;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	await cleanupFirecodeModules();
});

async function barkHarness(
	run: (h: { emit: (event: string, ...args: unknown[]) => void; ctx: unknown }) => Promise<void>,
	poolState?: string,
) {
	const home = await mkdtemp(join(tmpdir(), "firecode-bark-home-"));
	try {
		await writeFile(join(home, "bark-key"), "https://bark.test/key/\n");
		if (poolState !== undefined) {
			await mkdir(join(home, "tmp"));
			await writeFile(join(home, "tmp", "firecode-master-sid.json"), poolState);
		}
		process.env.PI_CODING_AGENT_DIR = home;
		const pushes: string[] = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => { pushes.push(init.body); return new Response("ok"); }) as never;
		const { registerBark } = await loadFirecodeModule("session/bark.ts") as any;
		const fake = fakePi({ getSessionName: () => "会话" });
		registerBark(fake.pi);
		const ctx = { cwd: "/tmp/project", isIdle: () => true, sessionManager: { getSessionId: () => "sid" } };
		await run({
			emit: (event, ...args) => void fake.fire(event, ...args),
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

test("子代理池有待发落事件时升 timeSensitive 并带“待拍板”副标题；空池、文件缺失与损坏都按普通通知", async () => {
	const settle = async ({ emit, ctx }: { emit: (event: string, ...args: unknown[]) => void; ctx: unknown }) => {
		emit("agent_start", {}, ctx);
		emit("message_end", reply("要你决定"));
		emit("agent_settled", {}, ctx);
	};
	const pool = (disposition?: "pending") => JSON.stringify({ version: 9, workers: [worker(disposition)] });
	const cases: Array<[string | undefined, string, string | undefined]> = [
		[pool("pending"), "timeSensitive", "待拍板"],
		[pool(), "active", undefined],
		[undefined, "active", undefined],
		["not json", "active", undefined],
	];
	for (const [state, level, subtitle] of cases) {
		const [push] = (await barkHarness(settle, state)).map((body) => JSON.parse(body));
		expect(push.level).toBe(level);
		expect(push.subtitle).toBe(subtitle);
		// 同会话固定 id：新通知经 APNs CollapseID 顶掉旧通知。
		expect(push.id).toBe("sid");
	}
});
