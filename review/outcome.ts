import { readFileSync } from "node:fs";
import { isCheckpointEntry, isValidCheckpoint, refusalOf } from "./checkpoint.js";
import { msg } from "./messages.js";
import type { ReviewState } from "./state.js";

export type ReviewOutcome =
	| { status: "passed"; runId: string; rounds: number }
	| { status: "stopped"; runId: string; rounds: number; advisorAdvice?: string }
	| { status: "failed"; runId: string; rounds: number; reason: string }
	| { status: "in_progress"; runId: string }
	/** 命令入口拒绝启动（配置问题、已有审查在跑、参数错误）；runId 是这次拒绝的 id，message 是原因原文。 */
	| { status: "refused"; runId: string; message: string }
	| { status: "none"; runId?: string }
	| { status: "error"; message: string };

/** 只读 Worker session，解析最近一条 fire-review checkpoint 或拒绝记录的判定；会话结束时的一次性兜底读取用它。 */
export function readReviewOutcome(sessionPath: string): ReviewOutcome {
	let content: string;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { status: "none" };
		return { status: "error", message: msg.failure.cannotReadSession(error instanceof Error ? error.message : String(error)) };
	}

	let latest: ReviewOutcome | undefined;
	let damage: string | undefined;
	// session 尾行可能正写到一半；跳过损坏行并保留最近一条可验证记录，
	// 不能让截断尾行抹掉已有结果。其他版本写的 checkpoint 与 checkpoint.ts 读取时一样按没有处理。
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			damage ??= msg.failure.badJsonLine(index + 1);
			continue;
		}
		latest = outcomeOfEntry(entry) ?? latest;
	}
	if (!latest) return damage ? { status: "error", message: damage } : { status: "none" };
	return latest;
}

/** 会话事件里刚追加的一条记录若是有效 checkpoint 或拒绝记录，给出它的判定；订阅方据此增量跟进，不重读整份 JSONL。 */
export function outcomeOfEntry(entry: unknown): ReviewOutcome | undefined {
	const state = checkpointOf(entry);
	if (state) return outcomeOf(state);
	const refusal = refusalOf(entry);
	return refusal && { status: "refused", runId: refusal.id, message: refusal.message };
}

/** 审查进行中的轮次与审查者进度；不是审查相的 checkpoint 或不是 checkpoint 都给 undefined。 */
export interface ReviewRoundProgress {
	round: number;
	settled: number;
	total: number;
}

export function reviewProgressOf(entry: unknown): ReviewRoundProgress | undefined {
	const active = checkpointOf(entry)?.active;
	return active ? { round: active.round, settled: active.settledCount, total: active.reviewers.length } : undefined;
}

function checkpointOf(entry: unknown): ReviewState | undefined {
	return isCheckpointEntry(entry) && isValidCheckpoint(entry.data) ? entry.data : undefined;
}

function outcomeOf(latest: ReviewState): ReviewOutcome {
	if (latest.phase === "idle") return { status: "none", runId: latest.runId };
	if (latest.phase !== "settled") return { status: "in_progress", runId: latest.runId };
	const rounds = latest.history.length;
	const last = latest.history.at(-1);
	const result = last?.result;
	if (result === "passed") return { status: "passed", runId: latest.runId, rounds };
	// stopped（顾问叫停）与 failed（maxRounds 用尽）都是质量裁决终止；
	// error / cancelled / timed_out 是基础设施故障或人为中断，不弱化成“停止”。
	if (result === "stopped" || result === "failed") {
		// 顾问叫停时把裁决带给读取方：Master 拿到停止原因才能调整方向。
		const advice = last?.advisor?.advice;
		return { status: "stopped", runId: latest.runId, rounds, ...(advice ? { advisorAdvice: advice } : {}) };
	}
	// 轮记录的 details 已写明故障形态（超时/供应商报错）；枚举名只是它缺失时的兜底。
	return { status: "failed", runId: latest.runId, rounds, reason: last?.details?.trim() || result || "unknown" };
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
