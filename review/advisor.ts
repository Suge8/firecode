/** 顾问仲裁：连续 N 轮失败后经独立进程内会话返回三选一裁决。 */
import { msg } from "./messages.js";
import type { PromptLayers } from "./prompt.js";
import { ADVISOR_VERDICTS, type AdvisorResult, type AdvisorVerdict } from "./state.js";
import { runReviewSession, type ReviewModelConfig } from "./session.js";
import type { InProcessSessionPool } from "../spawn.js";
import { verdictWord } from "./verdict.js";

interface RunAdvisorOptions {
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
	pool: InProcessSessionPool;
}

/** 顾问会话没有产出时抛错，由执行器改成“顾问不可用，已跳过”并继续修复。 */
export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorResult> {
	const result = await runReviewSession(options.pool, {
		config: options.config,
		prompt: options.prompt,
		cwd: options.cwd,
		signal: options.signal,
	});
	if (result.kind !== "output")
		throw new Error(msg.advisor.unavailable(result.kind === "error" ? result.message : result.kind));
	return parseAdvisorOutput(result.text);
}

/** 首行应为裸裁决词；容忍模型前言，在前几个非空行内识别裁决行，
 * 其余行（含前言）并入 advice；完全识别不出才回落 continue。 */
const VERDICT_SCAN_LINES = 8;

function parseAdvisorOutput(text: string): AdvisorResult {
	const lines = unwrapCodeFence(text.trim().split(/\r?\n/));
	const firstLine = lines.find((line) => line.trim()) ?? "";
	let verdict: AdvisorVerdict | undefined;
	let verdictIndex = -1;
	let scanned = 0;
	for (let index = 0; index < lines.length && scanned < VERDICT_SCAN_LINES; index += 1) {
		if (!lines[index].trim()) continue;
		scanned += 1;
		const parsed = ADVISOR_VERDICTS.find((word) => word === verdictWord(lines[index]));
		if (parsed) {
			verdict = parsed;
			verdictIndex = index;
			break;
		}
	}
	const advice = lines
		.filter((_, index) => index !== verdictIndex)
		.join("\n")
		.trim();
	if (!verdict) {
		// 把首行原文带回去：顾问会话跑完即释放、原始输出不落盘，这是事后诊断解析失败的唯一线索。
		return { verdict: "continue", advice: msg.advisor.unparseable(firstLine.slice(0, 80)) };
	}
	return { verdict, advice: advice || msg.advisor.noAdvice };
}

function unwrapCodeFence(lines: string[]) {
	const fenced =
		lines.length >= 2 &&
		/^```\w*\s*$/u.test(lines[0].trim()) &&
		/^```\s*$/u.test(lines.at(-1)?.trim() ?? "");
	return fenced ? lines.slice(1, -1) : lines;
}
