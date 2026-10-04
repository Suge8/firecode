/**
 * “会话进行中”的单一事实：指挥官回合在跑 || 有子代理在飞（working/reviewing，或已落定但结果事件尚未交给指挥官；已交出事件的未收割子代理不算）。
 * Master 是在飞子代理数的唯一发布者；上边框、本轮摘要与轮次时钟、Bark 都经 watchBusy 读同一个事实并消费同一个歇下边沿。
 * 本段进行中的起点也只在这里记：首次变忙那一刻起，中途的人类输入与结果唤醒都不重置，歇下边沿报告整段时长。
 * 频道名与 payload 只在本文件定义。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 进程内事件总线：在飞子代理数变化时发布 `{ inFlight }`，激活/停用同步。 */
export const WORKERS_CHANNEL = "firecode:workers";
export interface WorkersPayload {
	inFlight: number;
}

/**
 * herdr 通用“进行中”频道，与 herdr:blocked 同构：消费者按 active 的 true/false 做计数配对。
 * Master 只在在飞数 0↔正数跃迁时发布，保证配对；指挥官自己的回合 herdr 已由 agent_start/settled 得知。
 */
export const HERDR_WORKING_CHANNEL = "herdr:working";
export interface HerdrWorkingPayload {
	active: boolean;
	label?: string;
}
export const HERDR_WORKING_LABEL = "子代理进行中";

export interface BusyView {
	agentRunning: boolean;
	inFlight: number;
	/** 会话进行中 = 指挥官回合在跑 || 有子代理在飞。 */
	busy: boolean;
	/** 本段进行中的起点（Date.now）；当且仅当 busy 时存在。 */
	since?: number;
}
export const IDLE: BusyView = { agentRunning: false, inFlight: 0, busy: false };

export interface BusyHandlers {
	/** 任一来源变化后调用（含歇下那一次，先于 onSettled）。 */
	onChange?(view: BusyView, ctx: ExtensionContext | undefined): void;
	/** 会话歇下边沿：busy 由真变假时触发一次，带本段进行中的总时长。两个来源——agent_settled 时在飞数为 0，或在飞数归零时指挥官已空闲。 */
	onSettled(ctx: ExtensionContext | undefined, elapsed: number): void;
}

/**
 * 会话进行中的唯一判定与歇下边沿：上边框、轮次时钟与 Bark 都只消费这里，不各自拼装。
 * 指挥官回合以 agent_start → agent_settled（且 ctx.isIdle()）为界（宿主 sendUserMessage 会 await 整个唤醒回合，
 * 所以投递完成、在飞数归零可能晚于 agent_settled，歇下必须在两个来源都满足的那一刻触发）。
 */
export function watchBusy(pi: ExtensionAPI, handlers: BusyHandlers): void {
	let agentRunning = false;
	let inFlight = 0;
	/** 本段起点；有值即进行中。 */
	let since: number | undefined;
	let ctx: ExtensionContext | undefined;
	const update = () => {
		const now = Date.now();
		const busy = agentRunning || inFlight > 0;
		if (busy) since ??= now;
		const started = since;
		if (!busy) since = undefined;
		handlers.onChange?.({ agentRunning, inFlight, busy, since }, ctx);
		if (!busy && started !== undefined) handlers.onSettled(ctx, now - started);
	};
	pi.on("agent_start", (_event, context) => {
		ctx = context;
		agentRunning = true;
		update();
	});
	pi.on("agent_settled", (_event, context) => {
		ctx = context;
		// 宿主在 agent_settled 期间可能已有排队/延后的动作（isIdle 为 false），紧接着会再 agent_start：不算回合结束。
		agentRunning = context.isIdle() !== true;
		update();
	});
	pi.events.on(WORKERS_CHANNEL, (data) => {
		inFlight = (data as WorkersPayload).inFlight;
		update();
	});
}
