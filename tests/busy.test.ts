import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

/** 会话歇下边沿：sessionBusy（指挥官回合在跑 || 有子代理在飞）由真变假时恰好触发一次。 */
async function harness() {
	const { watchBusy } = await loadFirecodeModule("busy.ts") as any;
	const handlers = new Map<string, Function[]>();
	const bus = new Map<string, Function[]>();
	let settled = 0;
	watchBusy({
		on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		events: { on: (channel: string, fn: Function) => { bus.set(channel, [...(bus.get(channel) ?? []), fn]); return () => {}; } },
	}, { onSettled: () => { settled++; } });
	const ctx = {};
	return {
		get settled() { return settled; },
		agentStart: () => handlers.get("agent_start")?.forEach((fn) => fn({}, ctx)),
		agentSettled: () => handlers.get("agent_settled")?.forEach((fn) => fn({}, ctx)),
		inFlight: (inFlight: number) => bus.get("firecode:workers")?.forEach((fn) => fn({ inFlight })),
	};
}

test("普通回合：agent_settled 且无子代理在飞，歇下一次", async () => {
	const h = await harness();
	h.agentStart();
	expect(h.settled).toBe(0);
	h.agentSettled();
	expect(h.settled).toBe(1);
	h.agentSettled();
	expect(h.settled).toBe(1);
});

test("等待期不歇下：指挥官回合结束而子代理仍在飞，直到在飞数归零才歇下", async () => {
	const h = await harness();
	h.agentStart();
	h.inFlight(2);
	h.agentSettled();
	h.inFlight(1);
	expect(h.settled).toBe(0);
	h.inFlight(0);
	expect(h.settled).toBe(1);
});

test("闲时唤醒回合先于投递完成而结束：在飞数在 agent_settled 之后才归零，仍只歇下一次", async () => {
	const h = await harness();
	h.inFlight(1);
	h.agentStart();
	h.agentSettled();
	expect(h.settled).toBe(0);
	h.inFlight(0);
	expect(h.settled).toBe(1);
});
