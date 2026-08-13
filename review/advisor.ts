/**
 * 顾问仲裁：连续 N 轮失败后介入，返回 continue | stop | narrow 三选一，
 * 防止审查循环无限拉锯。子进程失败不阻塞反馈投递：默认按 continue 处理。
 */
import type { Language } from "../config.js";
import type { AdvisorResult, AdvisorVerdict } from "./state.js";
import { runPiProcess } from "./process.js";
import type { ReviewModelConfig } from "./reviewer.js";

export interface RunAdvisorOptions {
	config: ReviewModelConfig;
	prompt: string;
	cwd: string;
	language: Language;
	signal?: AbortSignal;
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorResult> {
	const result = await runPiProcess({
		command: options.config.command,
		args: advisorArgs(options.config, options.prompt),
		cwd: options.cwd,
		timeoutMs: options.config.timeoutMs,
		signal: options.signal,
	});
	const text = result.kind === "output" ? result.text : "";
	return parseAdvisorOutput(text, options.language);
}

export function advisorArgs(config: ReviewModelConfig, prompt: string) {
	return [
		"--no-session",
		"--mode",
		"json",
		"--model",
		config.model,
		"--thinking",
		config.thinking,
		"--tools",
		config.tools.join(","),
		"--exclude-tools",
		"write,edit",
		"-p",
		prompt.replaceAll("\0", ""),
	];
}

const VERDICTS = new Set<AdvisorVerdict>(["continue", "stop", "narrow"]);

/** 首行严格三选一；解析失败或子进程失败一律回落 continue（不因顾问故障停掉循环）。 */
export function parseAdvisorOutput(
	text: string,
	language: Language,
): AdvisorResult {
	const trimmed = text.trim();
	const [firstLine = "", ...rest] = trimmed.split(/\r?\n/);
	const verdict = normalizeVerdict(firstLine);
	const advice = rest.join("\n").trim();
	if (!verdict)
		return {
			verdict: "continue",
			advice:
				language === "en"
					? "Advisor output was not parseable; continuing with the current findings."
					: "顾问输出无法解析，按继续处理当前发现。",
		};
	return {
		verdict,
		advice: advice || (language === "en" ? "(no advice)" : "（无建议）"),
	};
}

function normalizeVerdict(line: string): AdvisorVerdict | undefined {
	const normalized = line
		.trim()
		.replace(/^\*{1,2}(.+?)\*{1,2}$/u, "$1")
		.trim()
		.toLowerCase();
	if (VERDICTS.has(normalized as AdvisorVerdict)) return normalized as AdvisorVerdict;
	const match = /^(continue|stop|narrow)\b/u.exec(normalized);
	return match ? (match[1] as AdvisorVerdict) : undefined;
}
