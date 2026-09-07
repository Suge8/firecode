/** Tracks one provider response from request start through final output usage. */
import { performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 流中没有供应商给出可靠的输出计数（Anthropic 的 message_start 只带占位值，OpenAI 完全不带），
// 所以流中速度只能按字符估算；中文与摘要式思考会明显偏低，结束后的官方值才是精确值。
const TOKEN_CHARS = 4;
const MIN_SAMPLE_MS = 1_000;
const UPDATE_INTERVAL_MS = 250;

export type TpsStatus =
	| { phase: "live"; tokensPerSecond: number }
	| { phase: "complete"; elapsedSeconds: number; tokensPerSecond?: number };

function deltaText(event: { type: string; delta?: unknown }): string | undefined {
	if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") {
		return undefined;
	}
	return typeof event.delta === "string" ? event.delta : undefined;
}

export function registerTps(
	pi: ExtensionAPI,
	update: (status?: TpsStatus) => void,
	now = (): number => performance.now(),
): void {
	let requestStartedAt: number | undefined;
	let firstDeltaAt: number | undefined;
	let lastDeltaAt: number | undefined;
	let lastUpdateAt = 0;
	let estimatedTokens = 0;

	function resetMeasurement(): void {
		requestStartedAt = undefined;
		firstDeltaAt = undefined;
		lastDeltaAt = undefined;
		lastUpdateAt = 0;
		estimatedTokens = 0;
	}

	function clear(): void {
		resetMeasurement();
		update();
	}

	pi.on("session_start", clear);
	pi.on("model_select", clear);
	pi.on("before_provider_request", () => {
		resetMeasurement();
		requestStartedAt = now();
	});
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const delta = deltaText(event.assistantMessageEvent);
		if (delta === undefined) return;

		const current = now();
		lastDeltaAt = current;
		firstDeltaAt ??= current;
		estimatedTokens += delta.length / TOKEN_CHARS;

		const elapsed = current - firstDeltaAt;
		if (elapsed < MIN_SAMPLE_MS || current - lastUpdateAt < UPDATE_INTERVAL_MS) return;
		lastUpdateAt = current;
		update({ phase: "live", tokensPerSecond: Math.round((estimatedTokens * 1_000) / elapsed) });
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || firstDeltaAt === undefined || lastDeltaAt === undefined) return;
		const current = now();
		const generationMs = lastDeltaAt - firstDeltaAt;
		const outputTokens = event.message.usage.output;
		update({
			phase: "complete",
			elapsedSeconds: Math.max(0, (current - (requestStartedAt ?? firstDeltaAt)) / 1_000),
			...(generationMs > 0 && outputTokens > 0
				? { tokensPerSecond: Math.round((outputTokens * 1_000) / generationMs) }
				: {}),
		});
		resetMeasurement();
	});
	pi.on("session_shutdown", clear);
}
