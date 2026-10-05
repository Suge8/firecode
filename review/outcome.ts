import { readFileSync } from "node:fs";
import { CHECKPOINT_TYPE, isValidCheckpoint } from "./checkpoint.js";
import type { ReviewState } from "./state.js";

export type ReviewOutcome =
	| { status: "passed"; runId: string; rounds: number }
	| { status: "stopped"; runId: string; rounds: number; advisorAdvice?: string }
	| { status: "failed"; runId: string; rounds: number; reason: string }
	| { status: "in_progress"; runId: string }
	| { status: "none"; runId?: string }
	| { status: "error"; message: string };

/** 只读 Worker session，解析最近一条 fire-review checkpoint 的判定；会话结束时的一次性兜底读取用它。 */
export function readReviewOutcome(sessionPath: string): ReviewOutcome {
	let content: string;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { status: "none" };
		return { status: "error", message: `无法读取 session 文件：${errorMessage(error)}` };
	}

	let latest: ReviewState | undefined;
	let damage: string | undefined;
	// session 尾行可能正写到一半；跳过损坏行并保留最近一条可验证记录，
	// 不能让截断尾行抹掉已有结果。
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			damage ??= `session 第 ${index + 1} 行不是有效 JSON`;
			continue;
		}
		if (!isCheckpointEntry(entry)) continue;
		if (isValidCheckpoint(entry.data)) latest = entry.data as ReviewState;
		else damage ??= "fire-review checkpoint 格式无效";
	}
	if (!latest) return damage ? { status: "error", message: damage } : { status: "none" };
	return outcomeOf(latest);
}

/** 会话事件里刚追加的一条记录若是有效 checkpoint，给出它的判定；订阅方据此增量跟进，不重读整份 JSONL。 */
export function outcomeOfEntry(entry: unknown): ReviewOutcome | undefined {
	const state = checkpointOf(entry);
	return state && outcomeOf(state);
}

/** 审查进行中的轮次与审查者进度；不是审查相的 checkpoint 或不是 checkpoint 都给 undefined。 */
export interface ReviewProgress {
	round: number;
	settled: number;
	total: number;
}

export function reviewProgressOf(entry: unknown): ReviewProgress | undefined {
	const active = checkpointOf(entry)?.active;
	return active ? { round: active.round, settled: active.settledCount, total: active.reviewers.length } : undefined;
}

function checkpointOf(entry: unknown): ReviewState | undefined {
	return isCheckpointEntry(entry) && isValidCheckpoint(entry.data) ? entry.data as ReviewState : undefined;
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

function isCheckpointEntry(value: unknown): value is { data: unknown } {
	return typeof value === "object" && value !== null
		&& (value as Record<string, unknown>).type === "custom"
		&& (value as Record<string, unknown>).customType === CHECKPOINT_TYPE
		&& "data" in value;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null
		&& (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
