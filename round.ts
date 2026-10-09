/**
 * 轮记录：一段会话进行中（一次人类输入到歇下，含等子代理）的事后事实——整段时长、终态与均速。
 * 本文件拥有它的全部：测量（终态、均速）、持久化格式、一轮多条的合成规则、读取与字样，以及写记录的记录器。
 * 宿主渲染适配（零行标记组件）在 tools/round.ts。
 *
 * 记录器每个会话都注册——主会话与每个子代理会话跑的是同一段代码、同一个歇下判定（busy.ts），与界面无关：
 * 主会话的摘要行、输入框外壳、子代理全过程视图都只读记录；Master 结果事件的“本次运行”耗时也读子代理会话里的
 * 这份记录，不再在指挥官这边另外计时——同一段时长只有一个事实源，视图与事件不会对不上。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watchBusy } from "./busy.js";
import { parseEnvelopes } from "./deliver.js";
import { formatDuration, textOf } from "./format.js";
import { msg } from "./messages.js";

export const ROUND_ENTRY = "firecode-round";
/**
 * 轮记录写进会话之后在进程内总线上发布（无 payload）：订阅方此刻读分支一定已含这条记录，不依赖歇下边沿的订阅顺序。
 * 频道名只在本文件，读者经 watchRoundRecorded。
 */
const ROUND_RECORDED_CHANNEL = "firecode:round-recorded";

/**
 * 本段最后一个指挥官回合的终态：宿主的回合中断信号（ctx.signal.aborted）为真即“已中断”——工具执行中被 Esc 时
 * 宿主给的终态是 error（“The operation was aborted.”），不能只看 stopReason；其余按最后一条助手消息的 stopReason。
 */
type Outcome = "complete" | "aborted" | "error";

/** 写进会话的轮记录内容。 */
export interface SettledRound {
	elapsed: number;
	outcome: Outcome;
	/**
	 * 均速（token/s）：指挥官各回合的输出 token 之和除以模型请求墙钟之和，等子代理与跑工具不算分母。
	 * 任一请求失败、中断、未配对或压缩失败则整段不给，不出半截的数。
	 */
	tps?: number;
}

export interface Round extends SettledRound {
	/** 歇下时刻（宿主记录的 entry 时间戳）。 */
	at: number;
}

export const roundAt = (data: SettledRound, timestamp: string): Round => ({ ...data, at: Date.parse(timestamp) });

/** 终态字样；完成不写字。 */
export const OUTCOME_TEXT: Record<Outcome, string> = { complete: "", ...msg.outcome };
const RATE_FORMAT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, useGrouping: false });

/** 落定记录的展示片段（未着色）：耗时，有均速再跟一段。上边框与摘要行共用。 */
export function roundTexts(round: SettledRound): string[] {
	return [formatDuration(round.elapsed), ...(round.tps ? [`${RATE_FORMAT.format(round.tps)} tps`] : [])];
}

// ---- 测量与记录器 ----

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

function outcomeOf(messages: readonly { role: string; stopReason?: string }[]): Outcome {
	const stop = messages.findLast((message) => message.role === "assistant")?.stopReason;
	return stop === "aborted" || stop === "error" ? stop : "complete";
}

export function registerRoundRecorder(pi: ExtensionAPI): void {
	let outcome: Outcome = "complete";
	let requests = FRESH;
	let busy = false;
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
	watchBusy(pi, {
		onChange: (view) => {
			if (view.busy && !busy) requests = FRESH;
			busy = view.busy;
		},
		onSettled: (elapsed) => {
			pi.appendEntry(ROUND_ENTRY, settledRound(elapsed, outcome, requests));
			pi.events.emit(ROUND_RECORDED_CHANNEL, undefined);
		},
	});
}

/** 订阅“轮记录已写入”；返回退订函数。 */
export function watchRoundRecorded(pi: ExtensionAPI, listener: () => void): () => void {
	return pi.events.on(ROUND_RECORDED_CHANNEL, listener);
}

// ---- 合成与读取 ----

/**
 * 一轮可能有多条记录（中断后又跑了一段，如 /fire-review 或命令触发的再次进行）。合成规则不丢信息：
 * 耗时累加（用户关心这一轮总共花了多久），终态与落定时刻取最后一条（这一轮最终怎样），更早的中断/请求失败
 * 以“中断过 N 次”追加；多段的均速没有请求墙钟无法合成，按“不出半截的数”不给。
 */
export interface TurnRecord {
	round: Round;
	/** 一轮里更早的非完成终态的短标记。 */
	earlier: string[];
}

export function combineRounds(rounds: readonly Round[]): TurnRecord | undefined {
	const last = rounds.at(-1);
	if (!last) return undefined;
	const elapsed = rounds.reduce((total, round) => total + round.elapsed, 0);
	const round: Round = rounds.length === 1 ? last : { elapsed, outcome: last.outcome, at: last.at };
	const earlier = (["aborted", "error"] as const).flatMap((outcome) => {
		const count = rounds.slice(0, -1).filter((round) => round.outcome === outcome).length;
		return count ? [msg.earlier[outcome](count)] : [];
	});
	return { round, earlier };
}

/** 会话分支条目里本模块读到的部分（宿主 SessionEntry 的结构子集）。 */
export type BranchEntry =
	| { type: "custom"; customType: string; data?: unknown; timestamp: string }
	| { type: "message"; message: { role: string; content?: unknown } }
	| { type: string };

const isHumanEntry = (entry: BranchEntry) => entry.type === "message" && "message" in entry
	&& entry.message.role === "user" && !parseEnvelopes(textOf(entry.message.content));

/** 会话条目若是轮记录，给出它（带落定时刻）；子代理全过程视图与 Master 的本次运行耗时都按它读子代理会话。 */
export function roundFromEntry(entry: unknown): Round | undefined {
	const record = entry as { type?: unknown; customType?: unknown; data?: unknown; timestamp?: unknown };
	if (record?.type !== "custom" || record.customType !== ROUND_ENTRY || typeof record.timestamp !== "string") return undefined;
	return roundAt(record.data as SettledRound, record.timestamp);
}

/**
 * 当前分支最近一轮的落定事实：最近一条人类消息之后的全部轮记录，按 combineRounds 合成。
 * 输入框上边框落定态读它，与摘要行是同一份记录、同一条合成规则。
 */
export function latestTurnRecord(branch: readonly BranchEntry[]): TurnRecord | undefined {
	const rounds: Round[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isHumanEntry(entry)) break;
		const round = roundFromEntry(entry);
		if (round) rounds.unshift(round);
	}
	return combineRounds(rounds);
}
