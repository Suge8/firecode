import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, featuresOnly, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

/** 按会话角色注册整个 FireCode，跑一个回合，返回写进会话的轮记录。 */
async function recordedRounds(role: "main" | "worker", features: string[]) {
	const harness = await loadFirecodeModule("role-harness.js", {
		configJsonc: JSON.stringify({ features: await featuresOnly(...features) }),
		extraFiles: {
			"role-harness.ts": [
				'import firecode from "./index.js";',
				'import { withSubsessionRole } from "./master/role.js";',
				'export const register = (pi: unknown, role: string) => role === "main"',
				'	? Promise.resolve(firecode(pi as never))',
				'	: withSubsessionRole(role as never, async () => firecode(pi as never));',
			].join("\n"),
		},
	}) as { register: (pi: unknown, role: string) => Promise<void> };
	const handlers = new Map<string, Function[]>();
	const appended: [string, unknown][] = [];
	await harness.register({
		registerMessageRenderer() {}, registerEntryRenderer() {}, registerShortcut() {}, registerFlag() {},
		registerCommand() {}, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [],
		on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		events: { on: () => () => {}, emit() {} },
		appendEntry: (type: string, data: unknown) => appended.push([type, data]),
	}, role);
	const ctx = { isIdle: () => true, signal: { aborted: false }, hasUI: false, mode: "print" };
	for (const name of ["agent_start", "agent_end", "agent_settled"])
		for (const handler of handlers.get(name) ?? []) await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	return appended.filter(([type]) => type === "firecode-round").map(([, data]) => data);
}

test("轮记录在每个会话里由同一段代码写：主会话与子代理会话都写，且每段只写一条", async () => {
	expect(await recordedRounds("main", ["tools"])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
	await cleanupFirecodeModules();
	expect(await recordedRounds("worker", ["tools", "master"])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
});

test("轮记录与界面无关：关掉工具渲染也照写", async () => {
	expect(await recordedRounds("main", [])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
});
