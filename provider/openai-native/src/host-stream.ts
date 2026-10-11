import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../../jsonc.js";

/**
 * Pi 会话消息 → Responses 请求体，一律交给宿主自己的流做：序列化、鉴权头、地址、重试都是宿主的事，
 * 这里只在宿主把请求体交给 onPayload 时截下或改写，并在 fetch 上记下最终响应。
 * 自己再写一份序列化会与宿主分叉（带语法约束的工具调用、外来 call_id 的规整、中途系统消息都曾因此出错）。
 */
export type Auth = { apiKey: string; headers?: ProviderHeaders };

export type ResponsesPayload = { model: string; input: Record<string, unknown>[]; instructions?: string; [key: string]: unknown };

type Wire = { status: number; text: string };

const CAPTURED = new Error("payload captured");

function isResponsesPayload(value: unknown): value is ResponsesPayload {
	return isRecord(value) && typeof value.model === "string" && Array.isArray(value.input);
}

/** 请求体最前面的系统提示条目（developer / system 消息）个数；其后才是对话。 */
export function leadingPromptLength(input: readonly Record<string, unknown>[]): number {
	const end = input.findIndex((item) => item.type !== undefined || (item.role !== "developer" && item.role !== "system"));
	return end < 0 ? input.length : end;
}

function run(
	model: Model<Api>,
	messages: AgentMessage[],
	auth: Auth,
	options: { signal?: AbortSignal; onPayload: (payload: unknown) => unknown; fetch?: typeof fetch },
) {
	return streamSimple(model, { messages: convertToLlm(messages) }, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		transport: "sse",
		...options,
	}).result();
}

/** 宿主对这批消息会发出的请求体；不发请求。不是 Responses 请求体时返回 undefined。 */
export async function captureHostPayload(model: Model<Api>, messages: AgentMessage[], auth: Auth): Promise<ResponsesPayload | undefined> {
	let captured: unknown;
	await run(model, messages, auth, {
		onPayload: (payload) => {
			captured = payload;
			throw CAPTURED;
		},
	});
	return isResponsesPayload(captured) ? captured : undefined;
}

export type PostResult = { wire: Wire } | { wire?: undefined; aborted: boolean; error?: string };

/** 把宿主为这批消息构造的请求体改写成 rewrite 的结果后真实发出，返回最终的原始响应；重试由宿主负责。 */
export async function postThroughHost(
	model: Model<Api>,
	messages: AgentMessage[],
	auth: Auth,
	options: { signal?: AbortSignal; rewrite: (payload: ResponsesPayload) => Record<string, unknown> },
): Promise<PostResult> {
	let wire: Wire | undefined;
	const result = await run(model, messages, auth, {
		signal: options.signal,
		onPayload: (payload) => {
			if (!isResponsesPayload(payload)) throw new Error("unexpected request payload");
			return options.rewrite(payload);
		},
		fetch: async (input, init) => {
			const response = await fetch(input, init);
			wire = { status: response.status, text: await response.clone().text() };
			return response;
		},
	});
	if (wire) return { wire };
	return { aborted: options.signal?.aborted === true, error: result.errorMessage };
}
