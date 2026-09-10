/** 主会话处理段的静态收尾；只写展示记录，不向模型投递消息。 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatDuration } from "../format.js";

const ENTRY_TYPE = "firecode-run-summary";
const RATE_FORMAT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, useGrouping: false });
type Outcome = "complete" | "aborted" | "error";
type RunSummary = { elapsedMs: number; outcome: Outcome; tps?: number };
type Run = Readonly<{
	startedAt: number;
	requestStartedAt?: number;
	requestMs: number | undefined;
	outputTokens: number;
	stopReason?: AssistantMessage["stopReason"];
	signal?: AbortSignal;
}>;

function recordResponse(run: Run, message: AssistantMessage, endedAt: number): Run {
	const duration = run.requestStartedAt === undefined ? 0 : endedAt - run.requestStartedAt;
	const output = message.usage.output;
	const valid = run.requestMs !== undefined && duration > 0 && Number.isFinite(output) && output > 0
		&& (message.stopReason === "stop" || message.stopReason === "toolUse");
	return {
		...run, requestStartedAt: undefined, stopReason: message.stopReason,
		requestMs: valid ? run.requestMs! + duration : undefined,
		outputTokens: valid ? run.outputTokens + output : run.outputTokens,
	};
}

function finish(run: Run, endedAt: number): RunSummary {
	const outcome = run.signal?.aborted || run.stopReason === "aborted" ? "aborted"
		: run.stopReason === "stop" || run.stopReason === "toolUse" ? "complete" : "error";
	const tps = outcome === "complete" && run.requestStartedAt === undefined && run.requestMs && run.outputTokens > 0
		? (run.outputTokens * 1_000) / run.requestMs : undefined;
	return { elapsedMs: Math.max(0, endedAt - run.startedAt), outcome, ...(tps ? { tps } : {}) };
}

function readSummary(value: unknown): RunSummary {
	const summary = value as RunSummary | undefined;
	if (!summary || !Number.isFinite(summary.elapsedMs) || summary.elapsedMs < 0
		|| !["complete", "aborted", "error"].includes(summary.outcome)
		|| (summary.tps !== undefined && (!Number.isFinite(summary.tps) || summary.tps <= 0)))
		throw new Error("处理摘要数据无效");
	return summary;
}

function renderSummary(summary: RunSummary, theme: Theme, width: number): string[] {
	const budget = Math.max(0, width - 1);
	const duration = formatDuration(summary.elapsedMs);
	let left = theme.fg("dim", `◷ 处理 ${duration}`);
	const right = summary.outcome === "aborted" ? theme.fg("warning", "⊘ 已中断")
		: summary.outcome === "error" ? theme.fg("error", "! 请求失败")
		: summary.tps === undefined ? ""
		: `${theme.fg("dim", "↗ 均速 ")}${theme.fg("accent", `${RATE_FORMAT.format(summary.tps)} tps`)}`;
	const separator = theme.fg("dim", "  ·  ");
	if (right && visibleWidth(left + separator + right) <= budget) return [` ${left}${separator}${right}`];
	if (right && summary.outcome !== "complete") {
		left = theme.fg("dim", `◷ ${duration}`);
		return [budget ? ` ${clip(left + separator + right, budget)}` : ""];
	}
	return [budget ? ` ${clip(left, budget)}` : ""];
}

export function registerRunSummary(pi: ExtensionAPI, now = () => performance.now()): void {
	let enabled = false;
	let submittedAt: number | undefined;
	let run: Run | undefined;
	const reset = () => { submittedAt = undefined; run = undefined; };
	const start = (startedAt: number): Run => run ??= { startedAt, requestMs: 0, outputTokens: 0 };
	const clearRequest = () => { if (run) run = { ...run, requestStartedAt: undefined }; };

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const summary = readSummary(entry.data);
		return { render: (width) => renderSummary(summary, theme, width), invalidate() {} };
	});
	pi.on("session_start", (_event, ctx) => { reset(); enabled = ctx.mode === "tui"; });
	pi.on("session_shutdown", () => { enabled = false; reset(); });
	pi.on("session_tree", reset);
	pi.on("input", (event, ctx) => {
		if (!enabled || !ctx.isIdle()) return;
		reset();
		if (event.source !== "extension") submittedAt = now();
	});
	pi.on("before_agent_start", () => {
		if (!enabled) return;
		start(submittedAt ?? now());
		submittedAt = undefined;
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!enabled) return;
		run = { ...start(now()), signal: ctx.signal };
		submittedAt = undefined;
	});
	pi.on("before_provider_request", () => {
		if (!run) return;
		run = {
			...run, requestStartedAt: now(),
			requestMs: run.requestStartedAt === undefined ? run.requestMs : undefined,
		};
	});
	pi.on("message_end", ({ message }) => {
		if (!run || message.role !== "assistant") return;
		run = recordResponse(run, message, now());
	});
	// 压缩的模型调用没有助手 message_end，不能把它的起点借给下一条回复。
	pi.on("session_before_compact", clearRequest);
	pi.on("session_compact", clearRequest);
	pi.on("session_compact_failed", (event) => {
		if (run) run = {
			...run, requestStartedAt: undefined, requestMs: undefined,
			stopReason: event.aborted ? "aborted" : "error",
		};
	});
	pi.on("agent_settled", () => {
		if (!run) return;
		const summary = finish(run, now());
		reset();
		pi.appendEntry(ENTRY_TYPE, summary);
	});
}
