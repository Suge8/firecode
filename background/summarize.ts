/**
 * 后台模型链写压缩摘要。切点、保留段、上次摘要与摘要提示词都是 pi 自己的：直接调 pi 导出的 compact()，只换写摘要的模型。
 * 请求经池的模型运行时发出（鉴权、baseUrl 由它解析），选择与冷却记账走 tryOnChain，与子代理、进展行共用一张冷却表。
 * 候选按这次的真实输入（序列化成文本的对话、上次摘要、提示词）加输出余量放不进上下文窗口就跳过，不发注定失败的请求。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, serializeConversation, type CompactionResult, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { ModelFailure } from "../model-route.js";
import type { InProcessSessionPool } from "../spawn.js";
import { msg } from "./messages.js";

export type Preparation = SessionBeforeCompactEvent["preparation"];

/** pi 的摘要提示词与包裹标签约 600 token，留宽。 */
const PROMPT_TOKENS = 2_000;
/** 摘要的输出余量，取 pi 默认的 reserveTokens；宿主发请求时还会按窗口夹紧 maxTokens，这里只挡住明显放不下的。 */
const OUTPUT_TOKENS = 16_384;
/** 与 pi 的 estimateTokens 同一口径。 */
const CHARS_PER_TOKEN = 4;

/** 一次摘要请求的输入量：拆分回合时是两次请求，取大的那次；手动 /compact 的附加指令两次都带。 */
function inputTokens(preparation: Preparation, customInstructions: string | undefined): number {
	const chars = (messages: Preparation["messagesToSummarize"]) => messages.length ? serializeConversation(convertToLlm(messages)).length : 0;
	const history = chars(preparation.messagesToSummarize) + (preparation.previousSummary?.length ?? 0);
	const extra = customInstructions?.length ?? 0;
	return Math.ceil((Math.max(history, chars(preparation.turnPrefixMessages)) + extra) / CHARS_PER_TOKEN) + PROMPT_TOKENS;
}

export async function summarize(
	pool: InProcessSessionPool,
	chain: ModelChain,
	preparation: Preparation,
	customInstructions: string | undefined,
	signal: AbortSignal,
): Promise<CompactionResult> {
	const need = inputTokens(preparation, customInstructions) + OUTPUT_TOKENS;
	const { value } = await pool.tryOnChain(
		chain,
		signal,
		(candidate) => candidate.contextWindow > 0 && need > candidate.contextWindow ? msg.windowTooSmall(need, candidate.contextWindow) : undefined,
		async ({ model: candidate, thinking }, runtime) => {
			// compact() 只抛文字：留下最后一次回复，按它的 stopReason 区分模型报错（记冷却）与输出截断（不记）。
			let last: AssistantMessage | undefined;
			const stream: StreamFn = (target, context, options) => {
				const events = runtime.streamSimple(target, context, options);
				void events.result().then((message) => { last = message; });
				return events;
			};
			try {
				return await compact(preparation, candidate, undefined, undefined, customInstructions, signal, thinking === "off" ? undefined : thinking, stream);
			} catch (error) {
				throw new ModelFailure(error instanceof Error ? error.message : String(error), last?.stopReason === "error");
			}
		},
	);
	return value;
}
