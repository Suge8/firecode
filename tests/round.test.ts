import { expect, setSystemTime, test } from "bun:test";
import { featuresOnly, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

/** 以主会话或子会话注册整个 FireCode，跑一个回合，返回写进会话的轮记录。 */
async function recordedRounds(subsession: boolean, features: string[]) {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly(...features) }),
	}) as { registerFirecode(pi: unknown, subsession: boolean): void };
	const fake = fakePi();
	registerFirecode(fake.pi, subsession);
	const ctx = { isIdle: () => true, signal: { aborted: false }, hasUI: false, mode: "print" };
	for (const name of ["agent_start", "agent_end", "agent_settled"])
		await fake.fire(name, { messages: [{ role: "assistant", stopReason: "stop" }], aborted: false }, ctx);
	return fake.appended.filter(([type]) => type === "firecode-round").map(([, data]) => data);
}

test("轮记录在每个会话里由同一段代码写，且与界面无关：主会话、子代理会话、关掉工具渲染都照写，每段只写一条", async () => {
	for (const [subsession, features] of [[false, ["tools"]], [true, ["tools", "master"]], [false, []]] as const)
		expect(await recordedRounds(subsession, [...features])).toEqual([{ elapsed: expect.any(Number), outcome: "complete" }]);
});

/** 直接驱动记录器：宿主事件进，写进会话的轮记录出。 */
async function recorder() {
	const { registerRoundRecorder } = await loadFirecodeModule("round.ts") as { registerRoundRecorder(pi: unknown): void };
	const fake = fakePi();
	registerRoundRecorder(fake.pi);
	const ctx = { isIdle: () => true };
	const rounds = () => fake.appended.filter(([type]) => type === "firecode-round").map(([, data]) => data);
	return {
		rounds,
		get last() { return rounds().at(-1); },
		agentStart: () => void fake.fire("agent_start", {}, ctx),
		/** 一条助手消息结束：宿主在消息上给的实测请求耗时 durationMs。 */
		response: (output: number, durationMs: number | undefined, stopReason = "stop") =>
			void fake.fire("message_end", { message: { role: "assistant", usage: { output }, stopReason, durationMs } }, ctx),
		agentEnd: (stopReason?: string) => void fake.fire("agent_end", { messages: stopReason ? [{ role: "assistant", stopReason }] : [] }, ctx),
		/** aborted：宿主在回合落定时给的用户中断标记。 */
		agentSettled: (aborted = false) => void fake.fire("agent_settled", { aborted }, ctx),
		inFlight: (inFlight: number) => fake.pi.events.emit("firecode:workers", { inFlight }),
		review: (active: boolean) => fake.pi.events.emit("firecode:review", active ? { active, progress: () => undefined } : { active }),
	};
}

test("终态取最后一个回合的：Esc 中断但子代理还在飞时这一段没结束，结果回来、指挥官再跑完才落记录", async () => {
	const h = await recorder();
	try {
		setSystemTime(new Date(1_000_000));
		h.agentStart();
		h.inFlight(1);
		h.agentEnd("aborted");
		h.agentSettled(true);
		expect(h.rounds()).toEqual([]);
		h.inFlight(0);
		expect(h.last).toEqual({ elapsed: 0, outcome: "aborted" });
		h.agentStart();
		h.agentEnd("error");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 0, outcome: "error" });
	} finally {
		setSystemTime();
	}
});

test("均速：整段内指挥官各回合的输出 token 之和除以宿主实测请求耗时之和，等子代理与工具不算分母；请求失败或缺实测耗时则整段不给", async () => {
	const h = await recorder();
	try {
		setSystemTime(new Date(0));
		h.agentStart();
		h.response(800, 10_000, "toolUse");
		h.inFlight(2);
		h.agentSettled();
		// 等了 50 秒子代理，不计入分母。
		setSystemTime(new Date(60_000));
		h.agentStart();
		h.response(400, 10_000);
		setSystemTime(new Date(80_000));
		h.inFlight(0);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 80_000, outcome: "complete", tps: 60 });

		// 一次请求失败后续跑完成：不伪造整段均速。
		setSystemTime(new Date(200_000));
		h.agentStart();
		h.response(0, 500, "error");
		h.response(100, 1_000);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 0, outcome: "complete" });

		// 宿主没给实测耗时（旧会话、延后取回的结果）同样不给。
		h.agentStart();
		h.response(100, undefined);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 0, outcome: "complete" });
	} finally {
		setSystemTime();
	}
});

test("Esc 中断按宿主落定时给的中断标记判定：工具执行中被中断时宿主给的是 error 终态，仍记“已中断”；真实请求失败照旧", async () => {
	const h = await recorder();
	h.agentStart();
	h.agentEnd("error");
	h.agentSettled(true);
	expect(h.last.outcome).toBe("aborted");

	h.agentStart();
	h.agentEnd("error");
	h.agentSettled();
	expect(h.last.outcome).toBe("error");
});

test("上一段被中断后只跑审查（没有指挥官回合）：这一段不沿用上一段的中断终态", async () => {
	const h = await recorder();
	h.agentStart();
	h.agentEnd("aborted");
	h.agentSettled(true);
	expect(h.last.outcome).toBe("aborted");

	h.review(true);
	h.review(false);
	expect(h.rounds()).toHaveLength(2);
	expect(h.last.outcome).toBe("complete");
});

test("输出 token 太少（不足 20）不给均速：1 个 token 的快答不显示无意义的 tps", async () => {
	const h = await recorder();
	try {
		setSystemTime(new Date(0));
		h.agentStart();
		setSystemTime(new Date(1_000));
		h.response(1, 1_000);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 1_000, outcome: "complete" });

		h.agentStart();
		setSystemTime(new Date(2_000));
		h.response(20, 1_000);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last.tps).toBe(20);
	} finally {
		setSystemTime();
	}
});
