import { expect, setSystemTime, test } from "bun:test";
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

/** 直接驱动记录器：宿主事件进，写进会话的轮记录出。 */
async function recorder() {
	const { registerRoundRecorder } = await loadFirecodeModule("round.ts") as { registerRoundRecorder(pi: unknown): void };
	const fake = fakePi();
	registerRoundRecorder(fake.pi);
	let idle = true;
	let aborted = false;
	const ctx = { isIdle: () => idle, get signal() { return { aborted }; } };
	const rounds = () => fake.appended.filter(([type]) => type === "firecode-round").map(([, data]) => data);
	return {
		set idle(value: boolean) { idle = value; },
		/** 宿主当前回合的中断信号（用户 Esc 等）。 */
		set aborted(value: boolean) { aborted = value; },
		rounds,
		get last() { return rounds().at(-1); },
		agentStart: () => void fake.fire("agent_start", {}, ctx),
		request: () => void fake.fire("before_provider_request", {}, ctx),
		response: (output: number, stopReason = "stop") => void fake.fire("message_end", { message: { role: "assistant", usage: { output }, stopReason } }, ctx),
		compact: (name: string, event = {}) => void fake.fire(name, event, ctx),
		agentEnd: (stopReason?: string) => void fake.fire("agent_end", { messages: stopReason ? [{ role: "assistant", stopReason }] : [] }, ctx),
		agentSettled: () => void fake.fire("agent_settled", {}, ctx),
		inFlight: (inFlight: number) => fake.pi.events.emit("firecode:workers", { inFlight }),
	};
}

test("终态取最后一个回合的：Esc 中断但子代理还在飞时这一段没结束，结果回来、指挥官再跑完才落记录", async () => {
	const h = await recorder();
	try {
		setSystemTime(new Date(1_000_000));
		h.agentStart();
		h.inFlight(1);
		h.agentEnd("aborted");
		h.agentSettled();
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

test("均速：整段内指挥官各回合的输出 token 之和除以请求墙钟之和，等子代理与工具不算分母；请求失败、压缩失败或未配对则整段不给", async () => {
	const h = await recorder();
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
		expect(h.last).toEqual({ elapsed: 80_000, outcome: "complete", tps: 40 });

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
		expect(h.last).toEqual({ elapsed: 3_000, outcome: "complete", tps: 100 });

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
		expect(h.last).toEqual({ elapsed: 1_000, outcome: "complete" });

		// 压缩失败同样整段不给。
		setSystemTime(new Date(300_000));
		h.agentStart();
		h.request();
		setSystemTime(new Date(301_000));
		h.response(100);
		h.compact("session_compact_failed", { aborted: true });
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 1_000, outcome: "complete" });
	} finally {
		setSystemTime();
	}
});

test("Esc 中断按宿主的中断信号判定：工具执行中被中断时宿主给的是 error 终态，仍记“已中断”；真实请求失败照旧", async () => {
	const h = await recorder();
	h.agentStart();
	h.aborted = true;
	h.agentEnd("error");
	h.agentSettled();
	expect(h.last.outcome).toBe("aborted");

	h.aborted = false;
	h.agentStart();
	h.agentEnd("error");
	h.agentSettled();
	expect(h.last.outcome).toBe("error");
});

test("输出 token 太少（不足 20）不给均速：1 个 token 的快答不显示无意义的 tps", async () => {
	const h = await recorder();
	try {
		setSystemTime(new Date(0));
		h.agentStart();
		h.request();
		setSystemTime(new Date(1_000));
		h.response(1);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last).toEqual({ elapsed: 1_000, outcome: "complete" });

		h.agentStart();
		h.request();
		setSystemTime(new Date(2_000));
		h.response(20);
		h.agentEnd("stop");
		h.agentSettled();
		expect(h.last.tps).toBe(20);
	} finally {
		setSystemTime();
	}
});
