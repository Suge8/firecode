/**
 * /fire-review 的持久化：custom entry（不进 LLM 上下文）。
 *
 * 一份会话分支上有三种记录：
 * - 轮记录：每收口一轮追加一条完整的 ReviewRound（含审查全文），只写一次，写入先于引用它的快照；
 * - checkpoint 快照：append-only，最新一条为准。它不带 history，只带当前相的数据、轮数和末轮的轻量副本
 *   （去掉审查全文与摘要；Master 单凭一条快照就能给出终态判定），所以每条快照体积有界，
 *   一场审查的累计写入量随轮数线性增长；
 * - 拒绝记录：命令入口拒绝启动的原因（无 UI 的 Worker 里这是唯一出口）。
 * 校验只守版本与关键字段：数据是本代码写的，字段形状由类型保证，版本门挡住旧档，不做字段级兼容。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { matchModels } from "../model-match.js";
import { isRecord } from "../jsonc.js";
import { PHASES, SETTLED_ENDS, TURN_STATUSES, type ReviewRound, type ReviewState } from "./state.js";

const CHECKPOINT_TYPE = "firecode-review-checkpoint";
const ROUND_TYPE = "firecode-review-round";
const REFUSAL_TYPE = "firecode-review-refusal";

const VERSION = 8;

/** 命令入口拒绝启动的记录：无 UI 的会话（Worker）里这是拒绝原因唯一的读取通道，id 让读取方区分每一次拒绝。 */
export function recordRefusal(pi: ExtensionAPI, message: string): void {
	pi.appendEntry(REFUSAL_TYPE, { id: crypto.randomUUID(), message });
}

export function refusalOf(entry: unknown): { id: string; message: string } | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== REFUSAL_TYPE || !isRecord(entry.data)) return undefined;
	const { id, message } = entry.data;
	return typeof id === "string" && typeof message === "string" ? { id, message } : undefined;
}

type WithoutHistory<S> = S extends unknown ? Omit<S, "history"> : never;
/** 快照：状态去掉 history，换成轮数与末轮轻量副本。 */
export type Snapshot = WithoutHistory<ReviewState> & { rounds: number; last: ReviewRound | null };

/** 一个会话里一场审查的写入口：记得已经写过多少轮。写不进去时抛错，由执行器收口。 */
export class CheckpointWriter {
	private written: number;

	/** restored 是从会话恢复出来的状态（其历史已在会话里）；新审查不传。 */
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly reviewers: ModelChain[],
		private readonly available: () => readonly Model<Api>[],
		restored?: ReviewState,
	) {
		this.written = restored?.history.length ?? 0;
	}

	write(state: ReviewState): void {
		for (const round of state.history.slice(this.written)) {
			this.pi.appendEntry(ROUND_TYPE, { runId: state.runId, round });
			this.written += 1;
		}
		this.pi.appendEntry(CHECKPOINT_TYPE, { version: VERSION, ...snapshotOf(state, this.reviewers, this.available) });
	}
}

/** 终态封存（按取消收尾）：把活动态改成 settled 写下去，调用方负责处理写不进去的情况。 */
export function sealCheckpoint(pi: ExtensionAPI, state: ReviewState): void {
	new CheckpointWriter(pi, [], () => [], state).write({ ...state, phase: "settled", end: "cancelled", updatedAt: Date.now() } as ReviewState);
}

function snapshotOf(state: ReviewState, reviewers: ModelChain[], available: () => readonly Model<Api>[]): Snapshot {
	const { history, ...rest } = state;
	const last = history.at(-1);
	if (state.phase !== "reviewing") return { ...rest, rounds: history.length, last: last ? light(last) : null } as Snapshot;
	// v8 的旧审查器从快照读取席位模型与 fallback；只在写盘时从当前配置和宿主模型表投影，恢复后不留第二套链。
	const models = available().filter((model) => model.api !== "pi-virtual");
	const slots = state.slots.map((slot, index) => {
		const seen = new Set<string>();
		const chain = reviewers[index].flatMap((atom) => {
			const matches = matchModels(models, atom.model);
			const candidates = matches.length ? matches.map((model) => ({ model: `${model.provider}/${model.id}`, thinking: atom.thinking })) : [atom];
			return candidates.filter((candidate) => {
				if (seen.has(candidate.model)) return false;
				seen.add(candidate.model);
				return true;
			});
		});
		const [primary, ...fallback] = chain;
		return { ...primary, fallback, result: slot.result };
	});
	return { ...rest, slots, rounds: history.length, last: last ? light(last) : null } as Snapshot;
}

function light(round: ReviewRound): ReviewRound {
	return { ...round, reviewers: round.reviewers.map((item) => ({ ...item, summary: "", details: "" })) };
}

/** 会话记录里的一条是不是有效快照。 */
export function checkpointOf(entry: unknown): Snapshot | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !isStored(entry.data)) return undefined;
	const { version: _version, ...snapshot } = entry.data;
	return snapshot as Snapshot;
}

/**
 * 读当前分支上最近一个快照并按轮记录补回 history；没有存档、旧版本存档（格式升级不迁移）都返回 undefined 且不出声。
 * 存档损坏（同版本但字段无效，或快照记的轮数与轮记录条数对不上，不分审查是否已收口）也返回 undefined，
 * 但先调 onDamaged：调用方借此告诉用户这场审查的进度读不出来，并写一份空的已收口存档作废它（否则每次开会话都重复提示）。
 */
export function readCheckpoint(ctx: { sessionManager: { getBranch(): unknown[] } }, onDamaged?: () => void): ReviewState | undefined {
	const entries = ctx.sessionManager.getBranch();
	const index = entries.findLastIndex((entry) => isRecord(entry) && entry.customType === CHECKPOINT_TYPE);
	if (index < 0) return undefined;
	const snapshot = checkpointOf(entries[index]);
	if (!snapshot) {
		const data = (entries[index] as { data?: unknown }).data;
		if (isRecord(data) && data.version === VERSION) onDamaged?.();
		return undefined;
	}
	const rounds = new Map<number, ReviewRound>();
	for (const entry of entries.slice(0, index)) {
		if (!isRecord(entry) || entry.customType !== ROUND_TYPE || !isRecord(entry.data) || entry.data.runId !== snapshot.runId) continue;
		const round = entry.data.round as ReviewRound;
		if (isRecord(round) && typeof round.round === "number" && Array.isArray(round.reviewers)) rounds.set(round.round, round);
	}
	if (rounds.size !== snapshot.rounds) {
		onDamaged?.();
		return undefined;
	}
	const { rounds: _rounds, last: _last, ...rest } = snapshot;
	const history = [...rounds.values()].sort((a, b) => a.round - b.round);
	return rest.phase === "reviewing"
		? { ...rest, slots: rest.slots.map(({ result }) => ({ result })), history }
		: { ...rest, history } as ReviewState;
}

function isStored(value: unknown): value is Snapshot & { version: number } {
	if (!isRecord(value) || value.version !== VERSION || typeof value.runId !== "string" || !PHASES.includes(value.phase as never)) return false;
	if (typeof value.rounds !== "number" || !(value.last === null || isRecord(value.last))) return false;
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
