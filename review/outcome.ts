import { readFileSync } from "node:fs";
import { checkpointOf, refusalOf, type Snapshot } from "./checkpoint.js";
import { msg } from "./messages.js";
import { roundText } from "./state.js";

/**
 * 对外中止一场进行中的审查：在审查所在的会话里执行这条命令（`session.prompt`）。走用户取消的同一条路径——
 * 结局记为取消、终态 checkpoint 照写、在途审查会话与投递中止；该会话没有进行中的审查时只提示，不留拒绝记录。
 * Master 的 interrupt 对审查中的子代理用它。
 */
export const CANCEL_REVIEW_ARG = "--cancel";
export const CANCEL_REVIEW_COMMAND = `/fire-review ${CANCEL_REVIEW_ARG}`;

export type ReviewOutcome =
	| { status: "passed"; runId: string; rounds: number }
	| { status: "stopped"; runId: string; rounds: number; advisorAdvice?: string }
	| { status: "failed"; runId: string; rounds: number; reason: string }
	/** 被取消（用户或 CANCEL_REVIEW_COMMAND）；不是故障，也不是质量裁决。 */
	| { status: "cancelled"; runId: string; rounds: number }
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
	const state = checkpointOf(entry);
	if (state?.phase !== "reviewing") return undefined;
	return { round: state.round, settled: state.slots.filter((slot) => slot.result).length, total: state.slots.length };
}

function outcomeOf(latest: Snapshot): ReviewOutcome {
	if (latest.phase === "idle") return { status: "none", runId: latest.runId };
	if (latest.phase !== "settled") return { status: "in_progress", runId: latest.runId };
	const { runId } = latest;
	const { rounds, last } = latest;
	switch (latest.end) {
		case "passed":
			return { status: "passed", runId, rounds };
		// 顾问叫停与轮数用尽都是质量裁决终止；顾问叫停时把裁决带给读取方：Master 拿到停止原因才能调整方向。
		case "stopped":
			return { status: "stopped", runId, rounds, ...(last?.advisor?.advice ? { advisorAdvice: last.advisor.advice } : {}) };
		case "exhausted":
			return { status: "stopped", runId, rounds };
		// 故障与超时是基础设施故障，取消是人为中断，都不弱化成“停止”；原因给人话，不把枚举名交给读取方。
		case "error":
			return { status: "failed", runId, rounds, reason: (last && roundText(last).trim()) || msg.outcome.error };
		case "cancelled":
			return { status: "cancelled", runId, rounds };
		case "timed_out":
			return { status: "failed", runId, rounds, reason: msg.outcome.timedOut };
	}
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
