import { expect, test } from "bun:test";
import { featuresOnly, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

/** 按会话角色注册整个 FireCode，跑一个回合，返回写进会话的轮记录。 */
async function recordedRounds(role: "main" | "worker", features: string[]) {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly(...features) }),
	}) as { registerFirecode(pi: unknown, role: string): void };
	const fake = fakePi();
	registerFirecode(fake.pi, role);
	const ctx = { isIdle: () => true, signal: { aborted: false }, hasUI: false, mode: "print" };
	for (const name of ["agent_start", "agent_end", "agent_settled"])
		await fake.fire(name, { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	return fake.appended.filter(([type]) => type === "firecode-round").map(([, data]) => data);
}

test("轮记录在每个会话里由同一段代码写：主会话与子代理会话都写，且每段只写一条", async () => {
	expect(await recordedRounds("main", ["tools"])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
	expect(await recordedRounds("worker", ["tools", "master"])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
});

test("轮记录与界面无关：关掉工具渲染也照写", async () => {
	expect(await recordedRounds("main", [])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
});
