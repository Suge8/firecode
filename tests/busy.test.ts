import { afterEach, expect, setSystemTime, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

/** 会话歇下边沿：sessionBusy（指挥官回合在跑 || 有子代理在飞）由真变假时恰好触发一次。 */
async function harness() {
	const { watchBusy } = await loadFirecodeModule("busy.ts") as any;
	const handlers = new Map<string, Function[]>();
	const bus = new Map<string, Function[]>();
	let settled = 0;
	let result: any;
	let view: any;
	watchBusy({
		on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		events: { on: (channel: string, fn: Function) => { bus.set(channel, [...(bus.get(channel) ?? []), fn]); return () => {}; } },
	}, { onChange: (next: any) => { view = next; }, onSettled: (_ctx: unknown, settledResult: unknown) => { settled++; result = settledResult; } });
	let idle = true;
	const ctx = { isIdle: () => idle };
	return {
		set idle(value: boolean) { idle = value; },
		get settled() { return settled; },
		get result() { return result; },
		get view() { return view; },
		agentStart: () => handlers.get("agent_start")?.forEach((fn) => fn({}, ctx)),
		request: () => handlers.get("before_provider_request")?.forEach((fn) => fn({}, ctx)),
		response: (output: number, stopReason = "stop") => handlers.get("message_end")?.forEach((fn) => fn({ message: { role: "assistant", usage: { output }, stopReason } }, ctx)),
		compact: (name: string, event = {}) => handlers.get(name)?.forEach((fn) => fn(event, ctx)),
		agentEnd: (stopReason?: string) => handlers.get("agent_end")?.forEach((fn) => fn({ messages: stopReason ? [{ role: "assistant", stopReason }] : [] }, ctx)),
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

test("agent_settled 时宿主仍有排队/延后的动作（isIdle 为 false）不算回合结束：不歇下，紧接着的再次回合结束才歇下", async () => {
	const h = await harness();
	h.agentStart();
	h.idle = false;
	h.agentSettled();
	expect(h.settled).toBe(0);
	// 排队的动作随即开跑，又一次回合落定且这次真空闲。
	h.agentStart();
	h.idle = true;
	h.agentSettled();
	expect(h.settled).toBe(1);
});

test("本段起点自首次变忙起：指挥官被结果唤醒不重置，歇下边沿报告整段时长与最后一个回合的终态", async () => {
	const h = await harness();
	try {
		setSystemTime(new Date(1_000_000));
		h.agentStart();
		h.inFlight(1);
		expect(h.view.since).toBe(1_000_000);
		setSystemTime(new Date(1_020_000));
		h.agentSettled();
		h.agentStart();
		expect(h.view.since).toBe(1_000_000);
		h.inFlight(0);
		setSystemTime(new Date(1_080_000));
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.view.since).toBeUndefined();
		expect(h.result).toEqual({ elapsed: 80_000, outcome: "complete" });

		// Esc 中断但子代理还在飞：这一段没结束；结果回来、指挥官再跑完，终态取最后一个回合的。
		setSystemTime(new Date(2_000_000));
		h.agentStart();
		h.inFlight(1);
		h.agentEnd("aborted");
		h.agentSettled();
		expect(h.settled).toBe(1);
		h.inFlight(0);
		expect(h.result).toEqual({ elapsed: 0, outcome: "aborted" });
		h.agentStart();
		h.agentEnd("error");
		h.agentSettled();
		expect(h.result).toEqual({ elapsed: 0, outcome: "error" });
	} finally {
		setSystemTime();
	}
});

test("均速：整段内指挥官各回合的输出 token 之和除以请求墙钟之和，等子代理与工具不算分母；请求失败、压缩失败或未配对则整段不给", async () => {
	const h = await harness();
	try {
		setSystemTime(new Date(0));
		h.agentStart();
		h.request();
		setSystemTime(new Date(10_000));
		h.response(800, "toolUse");
		h.inFlight(2);
		h.agentSettled();
		// 等了 50 秒子代理，不计入分母。
		setSystemTime(new Date(60_000));
		h.agentStart();
		h.request();
		setSystemTime(new Date(80_000));
		h.response(400);
		h.inFlight(0);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.result).toEqual({ elapsed: 80_000, outcome: "complete", tps: 40 });

		// 压缩的模型调用没有助手 message_end，不把它的起点借给下一条回复。
		setSystemTime(new Date(100_000));
		h.agentStart();
		h.request();
		setSystemTime(new Date(101_000));
		h.response(100);
		h.compact("session_before_compact");
		h.request();
		setSystemTime(new Date(102_000));
		h.compact("session_compact");
		h.request();
		setSystemTime(new Date(103_000));
		h.response(100);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.result).toEqual({ elapsed: 3_000, outcome: "complete", tps: 100 });

		// 一次请求失败后续跑完成：不伪造整段均速。
		setSystemTime(new Date(200_000));
		h.agentStart();
		h.request();
		h.response(0, "error");
		h.request();
		setSystemTime(new Date(201_000));
		h.response(100);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.result).toEqual({ elapsed: 1_000, outcome: "complete" });

		// 压缩失败同样整段不给。
		setSystemTime(new Date(300_000));
		h.agentStart();
		h.request();
		setSystemTime(new Date(301_000));
		h.response(100);
		h.compact("session_compact_failed", { aborted: true });
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.result).toEqual({ elapsed: 1_000, outcome: "complete" });
	} finally {
		setSystemTime();
	}
});

test("在飞数归零时指挥官回合因 isIdle 为 false 仍算在跑：不歇下，等它真正落定", async () => {
	const h = await harness();
	h.inFlight(1);
	h.agentStart();
	h.idle = false;
	h.agentSettled();
	h.inFlight(0);
	expect(h.settled).toBe(0);
	h.idle = true;
	h.agentSettled();
	expect(h.settled).toBe(1);
});
