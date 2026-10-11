/**
 * /fire-review 的持久化：custom entry（不进 LLM 上下文）存 reducer 状态快照。
 *
 * 一份会话分支上有三种记录：
 * - checkpoint：状态快照，append-only，最新一条为准；已收口轮次里各审查者的全文（details）不在其中，
 *   所以单条快照体积只随轮数线性增长的轮元数据，不随审查全文增长；
 * - 轮全文：每收口一轮追加一条，各审查者的 details 只在这里存一份，写入先于引用它的快照；
 * - 拒绝记录：命令入口拒绝启动的原因（无 UI 的 Worker 里这是唯一出口）。
 * 校验只守版本与关键字段：数据是本代码写的，字段形状由类型保证，版本门挡住旧档，不做字段级兼容。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../jsonc.js";
import { PHASES, SETTLED_ENDS, TURN_STATUSES, type ReviewRound, type ReviewState } from "./state.js";

const CHECKPOINT_TYPE = "firecode-review-checkpoint";
const DETAILS_TYPE = "firecode-review-round-details";
const REFUSAL_TYPE = "firecode-review-refusal";

const VERSION = 7;

/** 命令入口拒绝启动的记录：无 UI 的会话（Worker）里这是拒绝原因唯一的读取通道，id 让读取方区分每一次拒绝。 */
export function recordRefusal(pi: ExtensionAPI, message: string): void {
	pi.appendEntry(REFUSAL_TYPE, { id: crypto.randomUUID(), message });
}

export function refusalOf(entry: unknown): { id: string; message: string } | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== REFUSAL_TYPE || !isRecord(entry.data)) return undefined;
	const { id, message } = entry.data;
	return typeof id === "string" && typeof message === "string" ? { id, message } : undefined;
}

/** 一个会话里一场审查的写入口：记得已经写过多少轮全文。写不进去时抛错，由执行器收口。 */
export class CheckpointWriter {
	private written: number;

	/** restored 是从会话恢复出来的状态（其历史全文已在会话里）；新审查不传。 */
	constructor(private readonly pi: ExtensionAPI, restored?: ReviewState) {
		this.written = restored?.history.length ?? 0;
	}

	write(state: ReviewState): void {
		for (const round of state.history.slice(this.written)) {
			this.pi.appendEntry(DETAILS_TYPE, { runId: state.runId, round: round.round, details: round.reviewers.map((item) => item.details) });
			this.written += 1;
		}
		this.pi.appendEntry(CHECKPOINT_TYPE, { version: VERSION, ...withoutDetails(state) });
	}
}

/** 终态封存（按取消收尾）：把活动态改成 settled 写下去，调用方负责处理写不进去的情况。 */
export function sealCheckpoint(pi: ExtensionAPI, state: ReviewState): void {
	new CheckpointWriter(pi, state).write({ ...state, phase: "settled", end: "cancelled", updatedAt: Date.now() } as ReviewState);
}

function withoutDetails(state: ReviewState): ReviewState {
	return { ...state, history: state.history.map((round) => ({ ...round, reviewers: round.reviewers.map((item) => ({ ...item, details: "" })) })) };
}

/** 会话记录里的一条是不是有效 checkpoint；是则给出状态（已收口轮的审查全文为空，需要全文用 readCheckpoint）。 */
export function checkpointOf(entry: unknown): ReviewState | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !isStored(entry.data)) return undefined;
	const { version: _version, ...state } = entry.data;
	return state as ReviewState;
}

/** 读当前分支上最近一个 checkpoint 并补回已收口轮的审查全文；无、损坏或版本不匹配都返回 undefined。 */
export function readCheckpoint(ctx: { sessionManager: { getBranch(): unknown[] } }): ReviewState | undefined {
	const entries = ctx.sessionManager.getBranch();
	const index = entries.findLastIndex((entry) => isRecord(entry) && entry.customType === CHECKPOINT_TYPE);
	const state = checkpointOf(entries[index]);
	if (!state) return undefined;
	const details = new Map<number, string[]>();
	for (const entry of entries.slice(0, index)) {
		if (!isRecord(entry) || entry.customType !== DETAILS_TYPE || !isRecord(entry.data)) continue;
		const { runId, round, details: list } = entry.data;
		if (runId === state.runId && typeof round === "number" && Array.isArray(list)) details.set(round, list as string[]);
	}
	return { ...state, history: state.history.map((round) => withDetails(round, details.get(round.round))) };
}

function withDetails(round: ReviewRound, details: string[] = []): ReviewRound {
	return { ...round, reviewers: round.reviewers.map((item, at) => ({ ...item, details: details[at] ?? "" })) };
}

function isStored(value: unknown): value is ReviewState & { version: number } {
	if (!isRecord(value) || value.version !== VERSION || typeof value.runId !== "string" || !PHASES.includes(value.phase as never)) return false;
	if (!Array.isArray(value.history)) return false;
	switch (value.phase) {
		case "reviewing":
			return Array.isArray(value.slots);
		case "needs_fix":
			return Array.isArray(value.voters);
		case "settled":
			return SETTLED_ENDS.includes(value.end as never);
		case "awaiting_fix":
		case "summarizing":
			return TURN_STATUSES.includes(value.turn as never);
		default:
			return true;
	}
}
