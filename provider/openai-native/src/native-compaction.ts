import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { msg, type WindowLoss } from "../../messages.js";
import { physicalModel } from "../../../model-route.js";
import { executeNativeCompaction } from "./compact-client.js";
import { captureHostPayload, leadingPromptLength, type ResponsesPayload } from "./host-stream.js";
import {
	createNativeCompactionResult,
	describeIdentity,
	latestCompaction,
	nativeIdentity,
	nativeWindowLoss,
} from "./native-details.js";

type NativeCompactionHookResult = { cancel?: boolean; compaction?: CompactionResult };

/** 没有界面（print、rpc）时提示写到 stderr，不能无声。 */
export function notify(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}

function buildInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	return guidance
		? `${systemPrompt}\n\n${msg.compaction.guidance(guidance)}`
		: systemPrompt;
}

export async function compactWithOpenAINative(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	enabled: boolean,
): Promise<NativeCompactionHookResult | undefined> {
	if (event.signal.aborted) return { cancel: true };
	const model = physicalModel(ctx.model);
	const identity = nativeIdentity(model);
	const latest = latestCompaction(event.branchEntries);
	const prior = latest?.native?.details;
	const loss = prior && nativeWindowLoss(prior, model, enabled);
	if (loss) {
		notify(ctx, msg.compaction.replayDeclined(loss), "error");
		return { cancel: true };
	}
	if (!enabled || !model || !identity || (latest && !prior)) return undefined;

	const system: AgentMessage = {
		role: "system",
		content: buildInstructions(ctx.getSystemPrompt(), event.customInstructions),
		timestamp: Date.now(),
	};
	// 宿主已按 context_edit 投影并划定保留边界；窗口只代表边界之前的内容，保留段始终由宿主管理。
	const result = await executeNativeCompaction({
		ctx,
		model,
		messages: [system, ...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
		priorWindow: prior?.compactedWindow,
		signal: event.signal,
	});
	if (!result.ok) {
		if (result.reason === "aborted") return { cancel: true };
		const cause = msg.compaction.failed(result.reason, result.status, result.detail);
		// 没有原生窗口时宿主仍有完整原文；已有窗口时占位摘要不能替代它。
		if (event.reason !== "manual" && !prior) {
			notify(ctx, msg.compaction.fallback(cause), "warning");
			return undefined;
		}
		notify(ctx, msg.compaction.cancelled(cause), "error");
		return { cancel: true };
	}
	return {
		compaction: createNativeCompactionResult({
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			identity,
			compactedWindow: result.compactedWindow,
		}),
	};
}

type WindowLossReport = WindowLoss & { ok: false };
type Replay = { ok: true; payload: ResponsesPayload } | WindowLossReport;

/** 只替换宿主序列化的检查点摘要，保留段及其后续编辑、删除、系统更新不参与窗口重放的匹配。 */
export async function replayOpenAINative(payload: unknown, ctx: ExtensionContext, enabled: boolean): Promise<Replay | undefined> {
	const native = latestCompaction(ctx.sessionManager.getBranch())?.native;
	if (!native) return undefined;
	const model = physicalModel(ctx.model);
	const loss = nativeWindowLoss(native.details, model, enabled);
	if (loss) return { ok: false, ...loss };
	const lost: WindowLossReport = { ok: false, kind: "unreplayable", from: describeIdentity(native.details) };
	const summary = sessionEntryToContextMessages(native).filter((message) => message.role !== "system");
	const prefix = await captureHostPayload(ctx, model!, summary);
	const input = (payload as Partial<ResponsesPayload> | null)?.input;
	if (!prefix || !Array.isArray(input)) return lost;
	const summaryItems = prefix.input.slice(leadingPromptLength(prefix.input));
	const lead = leadingPromptLength(input);
	if (!summaryItems.length || summaryItems.some((item, index) => JSON.stringify(item) !== JSON.stringify(input[lead + index]))) {
		return lost;
	}
	return {
		ok: true,
		payload: {
			...(payload as ResponsesPayload),
			input: [...input.slice(0, lead), ...native.details.compactedWindow, ...input.slice(lead + summaryItems.length)],
		},
	};
}
