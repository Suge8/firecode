import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactionEntry, CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../../jsonc.js";
import type { WindowLoss } from "../../messages.js";

const NATIVE_COMPACTION_STRATEGY = "openai-native-compact";
const NATIVE_COMPACTION_VERSION = 2;

const NATIVE_PROVIDERS = new Set(["openai", "openai-codex"]);
const NATIVE_APIS = new Set(["openai-responses", "openai-codex-responses"]);

/** OpenAI Responses 协议的两个入口：原生压缩与 verbosity / priority 选项共用这一判定。 */
export function isOpenAIResponsesApi(api: string): boolean {
	return NATIVE_APIS.has(api);
}

/** 压缩窗口只在产生它的那个后端上有效：供应商、协议、模型与基址都一致才能重放。 */
type NativeIdentity = { provider: string; api: string; model: string; baseUrl: string };

type NativeCompactionDetails = NativeIdentity & {
	strategy: typeof NATIVE_COMPACTION_STRATEGY;
	version?: number;
	compactedWindow: Record<string, unknown>[];
};

type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails> & { details: NativeCompactionDetails };

/** 当前模型能做原生压缩时给出它的身份；代理、其它供应商或没有基址都不行（历史不发往兼容代理）。 */
export function nativeIdentity(model: Model<Api> | undefined): NativeIdentity | undefined {
	if (!model || !NATIVE_PROVIDERS.has(model.provider) || !isOpenAIResponsesApi(model.api)) return undefined;
	const baseUrl = model.baseUrl?.trim().replace(/\/+$/, "");
	return baseUrl ? { provider: model.provider, api: model.api, model: model.id, baseUrl } : undefined;
}

export function describeIdentity(identity: Pick<NativeIdentity, "provider" | "model">): string {
	return `${identity.provider}/${identity.model}`;
}

function isNativeDetails(value: unknown): value is NativeCompactionDetails {
	return (
		isRecord(value) &&
		value.strategy === NATIVE_COMPACTION_STRATEGY &&
		["provider", "api", "model", "baseUrl"].every((key) => typeof value[key] === "string") &&
		Array.isArray(value.compactedWindow)
	);
}

/** 分支上最近一次压缩；它是原生压缩时一并给出检查点内容。 */
export function latestCompaction(entries: readonly SessionEntry[]): { native?: NativeCompactionEntry } | undefined {
	const entry = entries.findLast((entry) => entry.type === "compaction");
	return entry && { native: isNativeDetails(entry.details) ? (entry as NativeCompactionEntry) : undefined };
}

export function nativeWindowLoss(details: NativeCompactionDetails, model: Model<Api> | undefined, enabled: boolean): WindowLoss | undefined {
	const identity = nativeIdentity(model);
	const kind = details.version !== NATIVE_COMPACTION_VERSION ? "unreplayable"
		: !enabled ? "disabled"
		: !identity || !sameBackend(details, identity) ? "switched" : undefined;
	return kind && { kind, from: describeIdentity(details) };
}

function sameBackend(details: NativeIdentity, identity: NativeIdentity): boolean {
	return (
		details.provider === identity.provider &&
		details.api === identity.api &&
		details.model === identity.model &&
		details.baseUrl === identity.baseUrl
	);
}

export function createNativeCompactionResult(input: {
	firstKeptEntryId: string;
	tokensBefore: number;
	identity: NativeIdentity;
	compactedWindow: Record<string, unknown>[];
}): CompactionResult<NativeCompactionDetails> {
	return {
		// 宿主按摘要查找刚写入的条目；唯一标记避免第二次压缩误报旧检查点。
		summary: `[OpenAI native compaction checkpoint: ${randomUUID()}]`,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details: { strategy: NATIVE_COMPACTION_STRATEGY, version: NATIVE_COMPACTION_VERSION, ...input.identity, compactedWindow: input.compactedWindow },
	};
}
