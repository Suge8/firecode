import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction, type NativeCompactionResult } from "./compact-client.js";
import {
	cloneStructuredValue,
	createNativeCompactionDetails,
	createNativeCompactionResult,
	isNativeCompactionDetails,
	resolveLatestNativeCompaction,
} from "./native-details.js";
import { rewriteNativeResponsesPayload, serializeLiveTailToResponsesInput } from "./native-replay.js";
import {
	resolveNativeCompactionRuntime,
	resolveNativeCompactionTarget,
	type ResponsesRequestPayload,
} from "./native-runtime.js";
import {
	serializeMessagesToCompactRequest,
	type NativeCompactionRequest,
} from "./responses-input.js";

type NativeCompactionHookResult = {
	cancel?: boolean;
	compaction?: CompactionResult;
};

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	return guidance
		? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`
		: systemPrompt;
}

function reportCompactionFailure(ctx: ExtensionContext, message: string): void {
	const fullMessage = `pi-openai-native: ${message}`;
	if (ctx.hasUI) {
		ctx.ui.notify(fullMessage, "error");
		return;
	}
	console.error(fullMessage);
}

function cancelCompaction(ctx: ExtensionContext, message: string): NativeCompactionHookResult {
	reportCompactionFailure(ctx, message);
	return { cancel: true };
}

function failureMessage(result: Extract<NativeCompactionResult, { ok: false }>): string {
	const status = result.status ? ` (HTTP ${result.status})` : "";
	const detail = result.detail ? `: ${result.detail}` : "";
	const message = `native compaction failed: ${result.reason}${status}${detail}`;
	return message.endsWith(".") ? message : `${message}.`;
}

export async function compactWithOpenAINative(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<NativeCompactionHookResult | undefined> {
	if (event.signal.aborted) {
		return { cancel: true };
	}

	const target = resolveNativeCompactionTarget(ctx);
	if (!target.ok) {
		return undefined;
	}

	const runtime = await resolveNativeCompactionRuntime(ctx, target.target);
	if (!runtime.ok) {
		return cancelCompaction(ctx, `native compaction is unavailable: ${runtime.reason}.`);
	}

	try {
		const latestCompaction = resolveLatestNativeCompaction(event.branchEntries, runtime.runtime);
		let request: NativeCompactionRequest;
		if (latestCompaction.ok) {
			const compactedWindow = latestCompaction.entry.details.compactedWindow.map(cloneStructuredValue);
			request = {
				model: runtime.runtime.model,
				input: [
					...compactedWindow,
					...serializeLiveTailToResponsesInput({
						model: runtime.runtime.currentModel,
						entries: event.branchEntries.slice(latestCompaction.index + 1),
					}),
				],
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			};
		} else if (latestCompaction.reason === "no-compaction") {
			request = serializeMessagesToCompactRequest({
				model: runtime.runtime.currentModel,
				messages: buildSessionContext(
					ctx.sessionManager.getEntries(),
					ctx.sessionManager.getLeafId(),
				).messages,
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			});
		} else {
			return undefined;
		}

		const result = await executeNativeCompaction({
			runtime: runtime.runtime,
			request,
			signal: event.signal,
		});
		if (!result.ok) {
			return result.reason === "aborted" ? { cancel: true } : cancelCompaction(ctx, failureMessage(result));
		}

		return {
			compaction: createNativeCompactionResult({
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: createNativeCompactionDetails({
					provider: runtime.runtime.provider,
					api: runtime.runtime.api,
					model: runtime.runtime.model,
					baseUrl: runtime.runtime.baseUrl,
					compactedWindow: result.compactedWindow,
					createdAt: result.createdAt,
				}),
			}),
		};
	} catch (error) {
		return cancelCompaction(ctx, `native compaction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 最近一次压缩是原生压缩却没能重放：请求照宿主原样发出，压缩窗口里的旧历史不在上下文里。 */
export type NativeReplayDeclined = { ok: false; reason: string; compactionId: string };

function latestNativeCompaction(ctx: ExtensionContext) {
	const latest = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
	return latest && isNativeCompactionDetails(latest.details) ? latest : undefined;
}

/** 开关关着不重放；但最近一次压缩是原生的话，它的窗口里的旧历史同样不在上下文里。 */
export function declineDisabledReplay(ctx: ExtensionContext): NativeReplayDeclined | undefined {
	const latest = latestNativeCompaction(ctx);
	return latest && { ok: false, reason: "nativeCompaction-disabled", compactionId: latest.id };
}

/**
 * undefined：没有原生压缩要重放（最近一次压缩不是原生的，或根本没压缩过）。
 * 只要最近一次压缩是原生的，当前请求没能重放（换了模型或供应商、请求体对不上……）就必须报出来，不能折叠成 undefined。
 */
export function replayOpenAINative(
	payload: unknown,
	ctx: ExtensionContext,
): { ok: true; payload: ResponsesRequestPayload } | NativeReplayDeclined | undefined {
	const latest = latestNativeCompaction(ctx);
	if (!latest) {
		return undefined;
	}
	const branchEntries = ctx.sessionManager.getBranch();
	const declined = (reason: string): NativeReplayDeclined => ({ ok: false, reason, compactionId: latest.id });

	const target = resolveNativeCompactionTarget(ctx, payload);
	if (!target.ok) {
		return target.reason === "missing-model" ? undefined : declined(target.reason);
	}
	const latestCompaction = resolveLatestNativeCompaction(branchEntries, target.target);
	if (!latestCompaction.ok || !target.target.payload) {
		return declined(latestCompaction.ok ? "unsupported-payload" : latestCompaction.reason);
	}

	const rewrite = rewriteNativeResponsesPayload({
		model: target.target.currentModel,
		payload: target.target.payload,
		branchEntries,
		compactionEntry: latestCompaction.entry,
	});
	return rewrite.ok ? rewrite : declined(rewrite.reason);
}
