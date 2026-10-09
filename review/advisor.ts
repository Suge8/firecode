/** 顾问仲裁：连续 N 轮失败后经独立进程内会话返回三选一裁决。 */
import { msg } from "./messages.js";
import type { PromptLayers } from "./prompt.js";
import { ADVISOR_VERDICTS, type AdvisorResult, type AdvisorVerdict } from "./state.js";
import type { ReviewModelConfig, ReviewSessionRunner } from "./session.js";

interface RunAdvisorOptions {
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
	runSession: ReviewSessionRunner;
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorResult> {
	const result = await options.runSession({
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

export function parseAdvisorOutput(text: string): AdvisorResult {
	const lines = unwrapCodeFence(text.trim().split(/\r?\n/));
	const firstLine = lines.find((line) => line.trim()) ?? "";
	let verdict: AdvisorVerdict | undefined;
	let verdictIndex = -1;
	let scanned = 0;
	for (let index = 0; index < lines.length && scanned < VERDICT_SCAN_LINES; index += 1) {
		if (!lines[index].trim()) continue;
		scanned += 1;
		const parsed = normalizeVerdict(lines[index]);
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
		const sample = firstLine.slice(0, 80);
		return {
			verdict: "continue",
			advice: msg.advisor.unparseable(sample),
		};
	}
	return {
		verdict,
		advice: advice || msg.advisor.noAdvice,
	};
}

function unwrapCodeFence(lines: string[]) {
	const fenced =
		lines.length >= 2 &&
		/^```\w*\s*$/u.test(lines[0].trim()) &&
		/^```\s*$/u.test(lines.at(-1)?.trim() ?? "");
	return fenced ? lines.slice(1, -1) : lines;
}

function normalizeVerdict(line: string): AdvisorVerdict | undefined {
	const normalized = line
		.trim()
		.replace(/^\*{1,2}(.+?)\*{1,2}$/u, "$1")
		.replace(/^#{1,6}\s*/u, "")
		.replace(/^(?:(?:verdict|裁决|结论)\s*[:：]\s*)/iu, "")
		// 提示词里裁决词本身带反引号展示，模型照抄 `continue` 很常见，剔掉包裹的反引号。
		.replace(/^`+(.+?)`+$/u, "$1")
		.trim()
		.toLowerCase();
	return ADVISOR_VERDICTS.find((verdict) => verdict === normalized);
}
