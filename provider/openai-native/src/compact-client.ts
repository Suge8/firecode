import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "../../../jsonc.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { leadingPromptLength, postThroughHost } from "./host-stream.js";

/**
 * 压缩走服务端压缩（请求参数 context_management），不在输入末尾追加 compaction_trigger：ChatGPT 订阅登录（Sign in with ChatGPT）
 * 拒收 compaction_trigger 输入项，context_management 则 API key、Codex 订阅与 ChatGPT 订阅都接受（2026-10 实测）。
 * 阈值取接口下限 1000。不要压低 max_output_tokens：它也会截断压缩摘要，实测窗口存在但丢了原文里的事实。
 * 只接受完整结束的响应；后续回答不进入历史窗口。
 */
const CONTEXT_MANAGEMENT = [{ type: "compaction", compact_threshold: 1000 }];

type ParsedOutput = { output: Record<string, unknown>[] };

type ParsedFailure = {
	reason: "input-too-large" | "response-failed";
	detail?: string;
};

export type NativeCompactionFailureReason =
	| "network-error"
	| "non-2xx"
	| "empty-body"
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
	const failed = value.type === "response.failed" || value.type === "error" || response.status === "failed";
	const incomplete = value.type === "response.incomplete" || response.status === "incomplete";
	if (!failed && !incomplete) return undefined;
	const error = providerError(value);
	const code = typeof error?.code === "string" ? error.code : undefined;
	const detail = error ? JSON.stringify(error) : incomplete
		? JSON.stringify(response.incomplete_details ?? { status: "incomplete" }) : errorMessage(value);
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

function parseSseOutput(responseText: string): ParsedOutput | ParsedFailure | undefined {
	let completed = false;
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
		if (event.type === "response.completed") {
			completed = true;
			continue;
		}
		failure = parseFailedResponse(event) ?? failure;
	}
	if (failure) return failure;
	return completed ? { output: streamedItems } : undefined;
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
	const posted = await postThroughHost(args.ctx, args.model, args.messages, {
		signal: args.signal,
		rewrite: ({ model, instructions, input }) => {
			const lead = leadingPromptLength(input);
			const body = [...input.slice(0, lead), ...(args.priorWindow ?? []), ...input.slice(lead)];
			return {
				model,
				...(instructions === undefined ? {} : { instructions }),
				input: body,
				context_management: CONTEXT_MANAGEMENT,
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

	const parsed = parseSseOutput(text);
	if (!parsed) return { ok: false, reason: "malformed-response", status };
	if ("reason" in parsed) return { ok: false, ...parsed, status };
	// 同一条流可以多次越过阈值；官方契约允许丢掉最新压缩项之前的全部内容。
	const latest = parsed.output.findLast((item) => item.type === "compaction");
	return latest ? { ok: true, compactedWindow: [latest] } : { ok: false, reason: "missing-compaction", status };
}
