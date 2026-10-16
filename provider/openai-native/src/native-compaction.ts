import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { msg, type WindowLoss } from "../../messages.js";
import { executeNativeCompaction } from "./compact-client.js";
import { captureHostPayload, leadingPromptLength, type ResponsesPayload } from "./host-stream.js";
import {
	createNativeCompactionResult,
	describeIdentity,
	latestCompaction,
	nativeIdentity,
	sameBackend,
} from "./native-details.js";

type NativeCompactionHookResult = {
	cancel?: boolean;
	compaction?: CompactionResult;
};

/** 没有界面（print、rpc）时提示写到 stderr，不能无声。 */
export function notify(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}


function buildInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	return guidance
		? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`
		: systemPrompt;
}

/**
 * 原生压缩这次做不成时的唯一规则：手动 /compact 取消并说明，会话不变，用户可以重试或切回模型；
 * 自动压缩退回宿主的摘要压缩并明说——取消的话下一轮照样失败，上下文满了连溢出补救也被取消，会话就卡死了。
 * windowLost：最近一次压缩是原生压缩，退回摘要时它窗口里的旧历史进不了摘要。
 */
function decline(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	decision: { cause: string; hint: string; windowLost: boolean },
): NativeCompactionHookResult | undefined {
	if (event.reason === "manual") {
		notify(ctx, msg.compaction.cancelled(decision.cause, decision.hint), "error");
		return { cancel: true };
	}
	notify(ctx, msg.compaction.fallback(decision.cause, decision.windowLost), "warning");
	return undefined;
}

function windowUnusable(event: SessionBeforeCompactEvent, ctx: ExtensionContext, from: string): NativeCompactionHookResult | undefined {
	return decline(event, ctx, { cause: msg.compaction.windowUnusable(from), hint: msg.compaction.switchBack(from), windowLost: true });
}

export async function compactWithOpenAINative(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<NativeCompactionHookResult | undefined> {
	if (event.signal.aborted) return { cancel: true };

	const model = ctx.model;
	const identity = nativeIdentity(model);
	const latest = latestCompaction(event.branchEntries);
	const prior = latest?.native?.details;
	if (!model || !identity) return prior ? windowUnusable(event, ctx, describeIdentity(prior)) : undefined;
	if (latest && !prior) return undefined;
	if (prior && !sameBackend(prior, identity)) return windowUnusable(event, ctx, describeIdentity(prior));

	const system: AgentMessage = {
		role: "system",
		content: buildInstructions(ctx.getSystemPrompt(), event.customInstructions),
		timestamp: Date.now(),
	};
	// 已有窗口时窗口代表此前的全部历史，只补压缩之后的条目；否则压缩整段会话（其开头的系统消息由上面的压缩指令取代）。
	let history: AgentMessage[];
	if (latest) {
		history = event.branchEntries.slice(latest.index + 1).flatMap(sessionEntryToContextMessages);
	} else {
		const all = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
		history = all[0]?.role === "system" ? all.slice(1) : all;
	}

	const result = await executeNativeCompaction({
		ctx,
		model,
		messages: [system, ...history],
		priorWindow: prior?.compactedWindow,
		signal: event.signal,
	});
	if (!result.ok) {
		if (result.reason === "aborted") return { cancel: true };
		const cause = msg.compaction.failed(result.reason, result.status, result.detail);
		return decline(event, ctx, { cause, hint: msg.compaction.retryLater, windowLost: prior !== undefined });
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

/** 最近一次压缩是原生压缩，这次请求却没能带上它的窗口：请求照宿主原样发出，窗口里的旧历史不在上下文里。 */
export type WindowLossReport = WindowLoss & { ok: false; compactionId: string };

export type Replay = { ok: true; payload: ResponsesPayload } | WindowLossReport;

/** 开关关着不重放；但最近一次压缩是原生的话，它的窗口里的旧历史同样不在上下文里。 */
export function declineDisabledReplay(ctx: ExtensionContext): WindowLossReport | undefined {
	const native = latestCompaction(ctx.sessionManager.getBranch())?.native;
	return native && { ok: false, kind: "disabled", from: describeIdentity(native.details), compactionId: native.id };
}

function sameItem(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 思考档标记：宿主在支持的模型上（OpenAI API key 下的 GPT-6）把每条回复的思考档写成它前面的一条 configuration_update，
 * 只标注其后回复的档位，不是对话内容。量保留段时宿主不带思考档，产出里没有标记，所以比对时跳过请求体里的标记；
 * 保留段里的标记随保留段一起换成窗口，之后的照原样留下。
 */
const isEffortMarker = (item: Record<string, unknown>) => item.type === "configuration_update";

/**
 * 把宿主请求体里“压缩摘要 + 压缩时保留的那段”换成压缩窗口，其后的对话原样接上。
 * 保留段有多长，让宿主对压缩那一刻的上下文再序列化一遍来量（不发请求），并要求它确是本次请求体系统提示之后的前缀：
 * 前缀对不上就说明请求体的构造与会话记录脱节（例如上下文被别处改写），宁可不重放。
 * undefined：没有原生压缩要重放。
 */
export async function replayOpenAINative(payload: unknown, ctx: ExtensionContext): Promise<Replay | undefined> {
	const branch = ctx.sessionManager.getBranch();
	const latest = latestCompaction(branch);
	const native = latest?.native;
	const model = ctx.model;
	if (!latest || !native || !model) return undefined;
	const lost = (kind: WindowLoss["kind"]): WindowLossReport => ({
		ok: false,
		kind,
		from: describeIdentity(native.details),
		compactionId: native.id,
	});

	const identity = nativeIdentity(model);
	if (!identity || !sameBackend(native.details, identity)) return lost("switched");
	const firstKept = branch.findIndex((entry, index) => index < latest.index && entry.id === native.firstKeptEntryId);
	if (firstKept < 0) return lost("unreplayable");

	// 宿主压缩后的上下文：压缩条目（系统消息与摘要）、保留段里的非系统消息，其后是压缩之后的全部条目。
	const covered = [native, ...branch.slice(firstKept, latest.index).filter((entry) => !(entry.type === "message" && entry.message.role === "system"))];
	const prefix = await captureHostPayload(ctx, model, covered.flatMap(sessionEntryToContextMessages));
	const input = (payload as Partial<ResponsesPayload> | null)?.input;
	if (!prefix || !Array.isArray(input)) return lost("unreplayable");

	// 系统提示不参与比对：不支持中途系统消息的模型把后来的更新折进首条提示，保留段之后的更新会让它与量出来的不同。
	const keptItems = prefix.input.slice(leadingPromptLength(prefix.input));
	const lead = leadingPromptLength(input);
	let end = lead;
	for (const item of keptItems) {
		while (end < input.length && isEffortMarker(input[end])) end++;
		if (!sameItem(item, input[end++])) return lost("unreplayable");
	}
	return {
		ok: true,
		payload: {
			...(payload as ResponsesPayload),
			input: [...input.slice(0, lead), ...native.details.compactedWindow, ...input.slice(end)],
		},
	};
}
