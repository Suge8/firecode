import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "../../../jsonc.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { leadingPromptLength, postThroughHost } from "./host-stream.js";

/**
 * 压缩走服务端压缩（请求参数 context_management），不在输入末尾追加 compaction_trigger：ChatGPT 订阅登录（Sign in with ChatGPT）
 * 拒收 compaction_trigger 输入项，context_management 则 API key、Codex 订阅与 ChatGPT 订阅都接受（2026-10 实测）。
 * 阈值取接口下限 1000：值得压缩的会话必然越线，服务端先压缩、在流里给出压缩项。压缩项之后的回答没有用，
 * max_output_tokens 取接口下限 16，回答随即以 response.incomplete 截断，不白付一轮生成。
 */
const CONTEXT_MANAGEMENT = [{ type: "compaction", compact_threshold: 1000 }];
const MAX_OUTPUT_TOKENS = 16;
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

type ParsedOutput = { output: Record<string, unknown>[] };

type ParsedFailure = {
	reason: "input-too-large" | "response-failed";
	detail?: string;
};

export type NativeCompactionFailureReason =
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "missing-compaction"
	| "input-too-large"
	| "response-failed";

export type NativeCompactionResult =
	| { ok: true; compactedWindow: Record<string, unknown>[] }
	| { ok: false; reason: "aborted" }
	| { ok: false; reason: NativeCompactionFailureReason; status?: number; detail?: string };

function errorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.message === "string" && value.message.trim()) {
		return value.message.trim();
	}
	if (isRecord(value.error)) {
		return errorMessage(value.error);
	}
	if (isRecord(value.response)) {
		return errorMessage(value.response);
	}
	return undefined;
}

function providerError(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (isRecord(value.error)) {
		return value.error;
	}
	return providerError(value.response);
}

function parseFailedResponse(value: unknown): ParsedFailure | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const response = isRecord(value.response) ? value.response : value;
	if (value.type !== "response.failed" && value.type !== "error" && response.status !== "failed") {
		return undefined;
	}
	const error = providerError(value);
	const code = typeof error?.code === "string" ? error.code : undefined;
	const detail = error ? JSON.stringify(error) : errorMessage(value);
	return {
		reason: code === "context_length_exceeded" ? "input-too-large" : "response-failed",
		...(detail ? { detail } : {}),
	};
}

function parseErrorDetail(responseText: string): string | undefined {
	try {
		return errorMessage(JSON.parse(responseText));
	} catch {
		return undefined;
	}
}

function isOutputArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(isRecord);
}

function parseJsonOutput(value: unknown): ParsedOutput | undefined {
	if (!isRecord(value) || !isOutputArray(value.output)) {
		return undefined;
	}
	return { output: value.output };
}

function parseSseOutput(responseText: string): ParsedOutput | ParsedFailure | undefined {
	let completed: ParsedOutput | undefined;
	const streamedItems: Record<string, unknown>[] = [];
	let failure: ParsedFailure | undefined;
	for (const block of responseText.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			continue;
		}
		if (!isRecord(event)) {
			continue;
		}
		if (event.type === "response.output_item.done" && isRecord(event.item)) {
			streamedItems.push(event.item);
			continue;
		}
		// 压缩请求按设计在压缩项之后被输出上限截断，以 response.incomplete 结束，与 completed 同为正常终点。
		if (event.type === "response.completed" || event.type === "response.incomplete") {
			completed = parseJsonOutput(event.response) ?? { output: [] };
			continue;
		}
		failure = parseFailedResponse(event) ?? failure;
	}
	if (completed?.output.length) {
		return completed;
	}
	if (completed && streamedItems.length > 0) {
		return { output: streamedItems };
	}
	return failure;
}

function parseResponseOutput(responseText: string):
	| { ok: true; parsed: ParsedOutput }
	| { ok: false; reason: "invalid-json" | "malformed-response" | ParsedFailure["reason"]; detail?: string } {
	const trimmed = responseText.trim();
	if (trimmed.startsWith("{")) {
		try {
			const value = JSON.parse(trimmed);
			const failure = parseFailedResponse(value);
			if (failure) {
				return { ok: false, ...failure };
			}
			const parsed = parseJsonOutput(value);
			if (parsed) {
				return { ok: true, parsed };
			}
			const detail = errorMessage(value);
			return { ok: false, reason: "malformed-response", ...(detail ? { detail } : {}) };
		} catch {
			return { ok: false, reason: "invalid-json" };
		}
	}

	const sse = parseSseOutput(trimmed);
	if (sse && "output" in sse) {
		return { ok: true, parsed: sse };
	}
	return sse
		? { ok: false, ...sse }
		: { ok: false, reason: "malformed-response" };
}

function isRetainedInputItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && (value.role === "user" || value.role === "developer" || value.role === "system");
}

function itemText(item: Record<string, unknown>): string {
	if (typeof item.content === "string") {
		return item.content;
	}
	if (!Array.isArray(item.content)) {
		return "";
	}
	return item.content
		.filter(isRecord)
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

function estimateTokens(item: Record<string, unknown>): number {
	return Math.max(1, Math.ceil(itemText(item).length / 4));
}

function buildCompactedWindow(input: Record<string, unknown>[], compactionItem: Record<string, unknown>): Record<string, unknown>[] {
	const retained: Record<string, unknown>[] = [];
	let remaining = RETAINED_MESSAGE_TOKEN_BUDGET;
	for (let index = input.length - 1; index >= 0 && remaining > 0; index--) {
		const item = input[index];
		if (!isRetainedInputItem(item)) {
			continue;
		}
		const tokens = estimateTokens(item);
		if (tokens > remaining) {
			continue;
		}
		retained.push(structuredClone(item));
		remaining -= tokens;
	}
	retained.reverse();
	return [...retained, structuredClone(compactionItem)];
}

/**
 * 原生压缩：宿主按这批消息构造请求体，这里在它前面补上上次的压缩窗口、带上服务端压缩参数后真实发出。
 * 输入是否超窗由服务端裁决（context_length_exceeded → input-too-large）；本地字符估算既不准也是第二事实源，
 * 历史上曾把正常触发线（窗口 − 预留）上的压缩全部误拒。
 */
export async function executeNativeCompaction(args: {
	ctx: ExtensionContext;
	model: Model<Api>;
	/** 第一条是系统提示（压缩指令），其后是要压缩的对话。 */
	messages: AgentMessage[];
	/** 上一次压缩留下的窗口：它代表消息之前的全部历史，接在系统提示之后。 */
	priorWindow?: Record<string, unknown>[];
	signal: AbortSignal;
}): Promise<NativeCompactionResult> {
	let retained: Record<string, unknown>[] = [];
	const posted = await postThroughHost(args.ctx, args.model, args.messages, {
		signal: args.signal,
		rewrite: ({ model, instructions, input }) => {
			const lead = leadingPromptLength(input);
			const body = [...input.slice(0, lead), ...(args.priorWindow ?? []), ...input.slice(lead)];
			retained = body.slice(lead);
			return {
				model,
				...(instructions === undefined ? {} : { instructions }),
				input: body,
				context_management: CONTEXT_MANAGEMENT,
				max_output_tokens: MAX_OUTPUT_TOKENS,
				store: false,
				stream: true,
			};
		},
	});
	if (!posted.wire) {
		return posted.aborted ? { ok: false, reason: "aborted" } : { ok: false, reason: "network-error", detail: posted.error };
	}

	const { status, text } = posted.wire;
	if (status < 200 || status >= 300) {
		const detail = parseErrorDetail(text);
		return { ok: false, reason: "non-2xx", status, ...(detail ? { detail } : {}) };
	}
	if (!text.trim()) return { ok: false, reason: "empty-body", status };

	const parsed = parseResponseOutput(text);
	if (!parsed.ok) return { ...parsed, status };
	const compactionItems = parsed.parsed.output.filter((item) => item.type === "compaction");
	if (compactionItems.length !== 1) return { ok: false, reason: "missing-compaction", status };
	return { ok: true, compactedWindow: buildCompactedWindow(retained, compactionItems[0]!) };
}
