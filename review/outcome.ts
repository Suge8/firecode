import { readFileSync } from "node:fs";
import { CHECKPOINT_TYPE, isValidCheckpoint } from "./checkpoint.js";
import type { ReviewState } from "./state.js";

export type ReviewOutcome =
	| { status: "passed"; runId: string }
	| { status: "stopped"; runId: string }
	| { status: "failed"; runId: string; reason: string }
	| { status: "in_progress"; runId: string }
	| { status: "none"; runId?: string }
	| { status: "error"; message: string };

/** 只读 Worker session，解析最近一条 fire-review checkpoint 的判定。 */
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
	// 与 master/herdr.ts 的 readLatestAssistant 一致：session 尾行可能正写到一半，
	// 跳过损坏行并保留最近一条可验证记录，不能让截断尾行抹掉已有结果。
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

	if (latest.phase === "idle") return { status: "none", runId: latest.runId };
	if (latest.phase !== "settled") return { status: "in_progress", runId: latest.runId };
	const result = latest.history.at(-1)?.result;
	if (result === "passed") return { status: "passed", runId: latest.runId };
	// stopped（顾问叫停）与 failed（maxRounds 用尽）都是质量裁决终止；
	// error / cancelled / timed_out 是基础设施故障或人为中断，不弱化成“停止”。
	if (result === "stopped" || result === "failed") return { status: "stopped", runId: latest.runId };
	return { status: "failed", runId: latest.runId, reason: result ?? "unknown" };
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
