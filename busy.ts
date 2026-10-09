/**
 * “会话进行中”的单一事实：指挥官回合在跑 || 有子代理在飞（定义见 master/outbox.ts）|| 主会话 /fire-review 进行中（review 的占用频道）。
 * 指挥官回合结束不等于歇下：回合结束后仍有子代理在飞、审查在跑，会话照旧进行中。
 * Master 是在飞子代理数的唯一发布者；轮记录器、上边框、本轮摘要与轮次时钟都经 watchBusy 读同一个事实并消费同一个歇下边沿。
 * 本段进行中的起点也只在这里记：首次变忙那一刻起，中途的人类输入与结果唤醒都不重置，歇下边沿报告整段事实：时长、终态、均速。
 * 频道名与 payload 只在本文件定义。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./format.js";
import { msg } from "./messages.js";
import { OCCUPANCY_CHANNEL, type OccupancyPayload } from "./review/occupancy.js";

/** 进程内事件总线：在飞子代理数变化时发布 `{ inFlight }`，激活/停用同步。 */
export const WORKERS_CHANNEL = "firecode:workers";
export interface WorkersPayload {
	inFlight: number;
	/** Master 停用遗弃在飞子代理：归零只结束本段，不是歇下。 */
	teardown?: true;
}

export interface BusyView {
	agentRunning: boolean;
	inFlight: number;
	/** 主会话 /fire-review 进行中（含修复与总结回合之间的等待）：算会话进行中，审查时长计入这一段。 */
	review: boolean;
	/** 会话进行中 = 指挥官回合在跑 || 有子代理在飞 || 主会话审查进行中。 */
	busy: boolean;
	/** 本段进行中的起点（Date.now）；当且仅当 busy 时存在。 */
	since?: number;
}
export const IDLE: BusyView = { agentRunning: false, inFlight: 0, review: false, busy: false };

/**
 * 本段最后一个指挥官回合的终态：宿主的回合中断信号（ctx.signal.aborted）为真即“已中断”——工具执行中被 Esc 时
 * 宿主给的终态是 error（“The operation was aborted.”），不能只看 stopReason；其余按最后一条助手消息的 stopReason。
 */
type Outcome = "complete" | "aborted" | "error";
export interface SettledRound {
	elapsed: number;
	outcome: Outcome;
	/**
	 * 均速（token/s）：指挥官各回合的输出 token 之和除以模型请求墙钟之和，等子代理与跑工具不算分母。
	 * 任一请求失败、中断、未配对或压缩失败则整段不给，不出半截的数。
	 */
	tps?: number;
}

/** 终态字样；完成不写字。 */
export const OUTCOME_TEXT: Record<Outcome, string> = { complete: "", ...msg.outcome };
const RATE_FORMAT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, useGrouping: false });

/** 落定记录的展示片段（未着色）：耗时，有均速再跟一段。上边框与摘要行共用。 */
export function roundTexts(round: SettledRound): string[] {
	return [formatDuration(round.elapsed), ...(round.tps ? [`${RATE_FORMAT.format(round.tps)} tps`] : [])];
}

/** 本段的模型请求计时；requestMs 为 undefined 表示本段已无法给出均速。 */
interface Requests {
	startedAt?: number;
	requestMs?: number;
	outputTokens: number;
}
const FRESH: Requests = { requestMs: 0, outputTokens: 0 };
/** 输出 token 少于这个数时均速没有意义（1 个 token 的快答算出来的 tps 只是噪声）。 */
const MIN_RATE_TOKENS = 20;

function settledRound(elapsed: number, outcome: Outcome, { startedAt, requestMs, outputTokens }: Requests): SettledRound {
	const valid = outcome === "complete" && startedAt === undefined && requestMs && outputTokens >= MIN_RATE_TOKENS;
	return { elapsed, outcome, ...(valid ? { tps: (outputTokens * 1_000) / requestMs } : {}) };
}

interface BusyHandlers {
	/** 任一来源变化后调用（含歇下那一次，先于 onSettled）。 */
	onChange?(view: BusyView, ctx: ExtensionContext | undefined): void;
	/** 会话歇下边沿：busy 由真变假时触发一次，带本段进行中的总时长与终态。两个来源——agent_settled 时在飞数为 0，或在飞数归零时指挥官已空闲。 */
	onSettled?(ctx: ExtensionContext | undefined, round: SettledRound): void;
}

function outcomeOf(messages: readonly { role: string; stopReason?: string }[]): Outcome {
	const stop = messages.findLast((message) => message.role === "assistant")?.stopReason;
	return stop === "aborted" || stop === "error" ? stop : "complete";
}

const HUBS = Symbol.for("firecode.busy");

/**
 * 会话进行中的唯一判定与歇下边沿：上边框与轮次时钟都只订阅这里，不各自拼装。
 * 每个 pi 只有一份状态机，首个订阅者安装宿主事件，之后只追加订阅；登记挂在 globalThis 上，
 * 宿主按文件加载模块副本时同一个 pi 仍只命中一份。
 * 指挥官回合以 agent_start → agent_settled（且 ctx.isIdle()）为界。在飞数归零与回合落定先后不定
 * （闲时前门投递在宿主记录这条消息后才算送达，见 deliver.ts），歇下必须在两个来源都满足的那一刻触发。
 * 拆会话（session_shutdown）与 Master 停用遗弃子代理只结束本段，不发歇下边沿。
 */
export function watchBusy(pi: ExtensionAPI, handlers: BusyHandlers): void {
	const hubs = ((globalThis as Record<symbol, unknown>)[HUBS] ??= new WeakMap()) as WeakMap<ExtensionAPI, BusyHandlers[]>;
	const subscribers = hubs.get(pi);
	if (subscribers) {
		subscribers.push(handlers);
		return;
	}
	const list = [handlers];
	hubs.set(pi, list);
	installBusy(pi, list);
}

function installBusy(pi: ExtensionAPI, subscribers: readonly BusyHandlers[]): void {
	let agentRunning = false;
	let inFlight = 0;
	let review = false;
	/** 本段起点；有值即进行中。 */
	let since: number | undefined;
	let outcome: Outcome = "complete";
	let requests = FRESH;
	let ctx: ExtensionContext | undefined;
	let closed = false;
	const update = (teardown = false) => {
		if (closed) return;
		const now = Date.now();
		const busy = agentRunning || inFlight > 0 || review;
		if (busy && since === undefined) {
			since = now;
			requests = FRESH;
		}
		const started = since;
		if (!busy) since = undefined;
		const view: BusyView = { agentRunning, inFlight, review, busy, since };
		for (const subscriber of subscribers) subscriber.onChange?.(view, ctx);
		if (busy || started === undefined || teardown) return;
		const round = settledRound(now - started, outcome, requests);
		for (const subscriber of subscribers) subscriber.onSettled?.(ctx, round);
	};
	pi.on("session_shutdown", () => {
		closed = true;
	});
	pi.on("agent_end", (event, context) => {
		outcome = context.signal?.aborted ? "aborted" : outcomeOf(event.messages);
	});
	pi.on("before_provider_request", () => {
		// 上一次请求没有等到助手 message_end 就又发起：起止无法配对。
		requests = { ...requests, startedAt: Date.now(), requestMs: requests.startedAt === undefined ? requests.requestMs : undefined };
	});
	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant") return;
		const duration = requests.startedAt === undefined ? 0 : Date.now() - requests.startedAt;
		const output = message.usage.output;
		const valid = requests.requestMs !== undefined && duration > 0 && Number.isFinite(output) && output > 0
			&& (message.stopReason === "stop" || message.stopReason === "toolUse");
		requests = valid
			? { requestMs: requests.requestMs! + duration, outputTokens: requests.outputTokens + output }
			: { requestMs: undefined, outputTokens: requests.outputTokens };
	});
	// 压缩的模型调用没有助手 message_end，不把它的起点借给下一条回复；压缩失败则本段不给均速。
	const clearRequest = () => { requests = { ...requests, startedAt: undefined }; };
	pi.on("session_before_compact", clearRequest);
	pi.on("session_compact", clearRequest);
	pi.on("session_compact_failed", () => { requests = { requestMs: undefined, outputTokens: requests.outputTokens }; });
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
	// 主会话审查算会话进行中：审查与修复、总结回合同属这一段，审查时长计入轮记录。
	pi.events.on(OCCUPANCY_CHANNEL, (data) => {
		review = (data as OccupancyPayload).active;
		update();
	});
	pi.events.on(WORKERS_CHANNEL, (data) => {
		const payload = data as WorkersPayload;
		inFlight = payload.inFlight;
		update(payload.teardown === true);
	});
}
