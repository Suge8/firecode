/**
 * “会话进行中”的单一事实：指挥官回合在跑 || 有子代理处于 working/reviewing（已落定未收割的不算）。
 * Master 是在飞子代理数的唯一发布者；上边框、本轮摘要与轮次时钟、Bark 都订阅这里读同一个数。
 * 频道名与 payload 只在本文件定义。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export const sessionBusy = (agentRunning: boolean, inFlight: number): boolean => agentRunning || inFlight > 0;

/** 订阅在飞子代理数；返回取消函数。 */
export function subscribeInFlight(pi: ExtensionAPI, listener: (inFlight: number) => void): () => void {
	return pi.events.on(WORKERS_CHANNEL, (data) => listener((data as WorkersPayload).inFlight));
}
