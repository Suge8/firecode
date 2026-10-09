import { expect, setSystemTime, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

/** 会话歇下边沿：sessionBusy（指挥官回合在跑 || 有子代理在飞）由真变假时恰好触发一次。 */
async function harness() {
	const { watchBusy } = await loadFirecodeModule("busy.ts") as any;
	const fake = fakePi();
	const pi = fake.pi;
	let settled = 0;
	let elapsed: number | undefined;
	let view: any;
	watchBusy(pi, { onChange: (next: any) => { view = next; }, onSettled: (ms: number) => { settled++; elapsed = ms; } });
	let idle = true;
	const ctx = { isIdle: () => idle };
	return {
		set idle(value: boolean) { idle = value; },
		review: (active: boolean) => fake.pi.events.emit("firecode:review", active ? { active, progress: () => undefined } : { active }),
		get settled() { return settled; },
		/** 最近一次歇下边沿报告的整段时长（毫秒）。 */
		get elapsed() { return elapsed; },
		get view() { return view; },
		agentStart: () => void fake.fire("agent_start", {}, ctx),
		agentSettled: () => void fake.fire("agent_settled", {}, ctx),
		inFlight: (inFlight: number, teardown?: boolean) => fake.pi.events.emit("firecode:workers", { inFlight, ...(teardown ? { teardown } : {}) }),
		shutdown: () => void fake.fire("session_shutdown", { reason: "quit" }, ctx),
		watch: (onSettled: (elapsed: number) => void) => watchBusy(pi, { onSettled }),
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

test("本段起点自首次变忙起：指挥官被结果唤醒不重置，歇下边沿报告整段时长", async () => {
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
		h.agentSettled();
		expect(h.view.since).toBeUndefined();
		expect(h.elapsed).toBe(80_000);
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

test("拆会话不是歇下：退出/new/resume 后 Master 停用发布的归零不触发边沿", async () => {
	const h = await harness();
	h.agentStart();
	h.inFlight(2);
	h.agentSettled();
	h.shutdown();
	h.inFlight(0);
	expect(h.settled).toBe(0);
});

test("停用 Master 遗弃在飞子代理不是歇下：teardown 归零只结束本段，不触发边沿", async () => {
	const h = await harness();
	h.agentStart();
	h.inFlight(2);
	h.agentSettled();
	h.inFlight(0, true);
	expect(h.settled).toBe(0);
	expect(h.view.busy).toBe(false);
	// 之后的新一段照常歇下。
	h.agentStart();
	h.agentSettled();
	expect(h.settled).toBe(1);
});

test("每个 pi 只有一份状态机：多个消费者只订阅，全部收到同一份歇下事实", async () => {
	const h = await harness();
	const seen: number[] = [];
	h.watch((elapsed) => seen.push(elapsed));
	h.watch((elapsed) => seen.push(elapsed));
	h.agentStart();
	h.agentSettled();
	expect(h.settled).toBe(1);
	expect(seen).toEqual([h.elapsed, h.elapsed]);
});

test("主会话审查进行中算会话进行中：审查期间不歇下，视图标出审查，审查时长计入这一段", async () => {
	const h = await harness();
	try {
		setSystemTime(new Date(0));
		h.agentStart();
		setSystemTime(new Date(10_000));
		h.review(true);
		h.agentSettled();
		expect(h.settled).toBe(0);
		expect(h.view).toMatchObject({ busy: true, review: expect.any(Function), agentRunning: false });
		// 修复回合在审查期间照常开跑、落定，都不切段。
		h.agentStart();
		h.agentSettled();
		expect(h.settled).toBe(0);
		setSystemTime(new Date(240_000));
		h.review(false);
		expect(h.settled).toBe(1);
		expect(h.elapsed).toBe(240_000);
		expect(h.view).toMatchObject({ busy: false, review: undefined });
	} finally {
		setSystemTime();
	}
});

