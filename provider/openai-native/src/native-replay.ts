import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	BranchSummaryEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { cloneStructuredValue, type NativeCompactionEntry } from "./native-details";
import { isRecord } from "../../../jsonc.js";
import type { ResponsesRequestPayload } from "./native-runtime";
import {
	hasAnchoredToolAdditions,
	serializeMessagesToResponsesInput,
	type ResponsesInputContentItem,
	type ResponsesInputItem,
	type ResponsesInputMessageItem,
} from "./responses-input";

export type NativeReplayFailureReason =
	| "compaction-boundary-not-found"
	| "first-kept-entry-not-found"
	| "unsupported-instructions"
	| "invalid-compacted-window"
	| "unexpected-compaction-after-boundary"
	| "unsupported-tool-additions"
	| "expected-pi-replay-mismatch";

export type NativeReplayResult =
	| { ok: true; payload: ResponsesRequestPayload }
	| { ok: false; reason: NativeReplayFailureReason };

function isResponsesInputContentItem(value: unknown): value is ResponsesInputContentItem {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	if (value.type === "input_text") {
		return typeof value.text === "string";
	}
	return value.type === "input_image" && value.detail === "auto" && typeof value.image_url === "string";
}

function isResponsesInputMessageItem(value: unknown): value is ResponsesInputMessageItem {
	if (!isRecord(value) || (value.role !== "user" && value.role !== "developer" && value.role !== "system")) {
		return false;
	}
	return typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isResponsesInputContentItem));
}

function isPromptEnvelopeItem(value: unknown): value is ResponsesInputMessageItem {
	return isResponsesInputMessageItem(value) && (value.role === "developer" || value.role === "system");
}

function cloneInputContent(item: ResponsesInputContentItem): ResponsesInputContentItem {
	return item.type === "input_text"
		? { type: "input_text", text: item.text }
		: { type: "input_image", detail: "auto", image_url: item.image_url };
}

function cloneInputMessage(item: ResponsesInputMessageItem): ResponsesInputMessageItem {
	return {
		role: item.role,
		content: typeof item.content === "string" ? item.content : item.content.map(cloneInputContent),
	};
}

function cloneResponsesInput(items: readonly unknown[]): ResponsesInputItem[] | undefined {
	try {
		return items.map((item) => cloneStructuredValue(item) as ResponsesInputItem);
	} catch {
		return undefined;
	}
}

function cloneCompactedWindow(items: readonly unknown[]): unknown[] | undefined {
	try {
		return items.map(cloneStructuredValue);
	} catch {
		return undefined;
	}
}

function areEquivalentValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => areEquivalentValues(item, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) {
		return false;
	}
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		areEquivalentValues(leftKeys, rightKeys) &&
		leftKeys.every((key) => areEquivalentValues(left[key], right[key]))
	);
}

function toBranchSummaryMessage(entry: BranchSummaryEntry): AgentMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toCustomMessage(entry: CustomMessageEntry): AgentMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toReplayMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return (entry as SessionMessageEntry).message;
	}
	if (entry.type === "custom_message") {
		return toCustomMessage(entry);
	}
	if (entry.type === "branch_summary") {
		return toBranchSummaryMessage(entry);
	}
	return undefined;
}

function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		const message = toReplayMessage(entry);
		if (message) {
			messages.push(message);
		}
	}
	return messages;
}

function createCompactionSummary(entry: NativeCompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function extractLeadingPromptInput(payload: ResponsesRequestPayload): ResponsesInputMessageItem[] | undefined {
	if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
		return undefined;
	}
	let boundary = 0;
	while (boundary < payload.input.length && isPromptEnvelopeItem(payload.input[boundary])) {
		boundary += 1;
	}
	return payload.input.slice(0, boundary).map((item) => cloneInputMessage(item as ResponsesInputMessageItem));
}

export function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
	model: Model<TApi>;
	entries: readonly SessionEntry[];
}): ResponsesInputItem[] {
	return serializeMessagesToResponsesInput(args.model, collectReplayMessages(args.entries));
}

export function rewriteNativeResponsesPayload<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayResult {
	const boundaryIndex = args.branchEntries.findIndex((entry) => entry.id === args.compactionEntry.id);
	if (boundaryIndex < 0) {
		return { ok: false, reason: "compaction-boundary-not-found" };
	}
	const firstKeptEntryIndex = args.branchEntries.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === args.compactionEntry.firstKeptEntryId,
	);
	if (firstKeptEntryIndex < 0) {
		return { ok: false, reason: "first-kept-entry-not-found" };
	}

	const leadingInput = extractLeadingPromptInput(args.payload);
	if (!leadingInput) {
		return { ok: false, reason: "unsupported-instructions" };
	}
	if (args.branchEntries.slice(boundaryIndex + 1).some((entry) => entry.type === "compaction")) {
		return { ok: false, reason: "unexpected-compaction-after-boundary" };
	}

	const compactedWindow = cloneCompactedWindow(args.compactionEntry.details.compactedWindow);
	if (!compactedWindow) {
		return { ok: false, reason: "invalid-compacted-window" };
	}

	// 宿主的上下文是 [压缩时的系统消息, 摘要, 保留窗口里的非系统消息, 压缩之后的全部消息]（buildContextEntries），
	// 序列化必须在这一个序列里做：中途系统消息的位置、序号和工具新增都依赖整段上下文。
	const systemMessage = args.compactionEntry.systemMessage;
	const keptEntries = args.branchEntries
		.slice(firstKeptEntryIndex, boundaryIndex)
		.filter((entry) => !(entry.type === "message" && entry.message.role === "system"));
	const throughKept = [
		...(systemMessage ? [systemMessage as AgentMessage] : []),
		createCompactionSummary(args.compactionEntry),
		...collectReplayMessages(keptEntries),
	];
	const throughTail = [...throughKept, ...collectReplayMessages(args.branchEntries.slice(boundaryIndex + 1))];
	const options = { leadingSystemMessage: systemMessage !== undefined };
	if (hasAnchoredToolAdditions(args.model, throughTail, options)) {
		return { ok: false, reason: "unsupported-tool-additions" };
	}
	const keptInput = serializeMessagesToResponsesInput(args.model, throughKept, options);
	const bodyInput = serializeMessagesToResponsesInput(args.model, throughTail, options);

	// 请求末尾可能还有提供方追加的提示；其余部分必须逐项等于宿主重放。
	const bodyEnd = leadingInput.length + bodyInput.length;
	const trailingInput = args.payload.input.slice(bodyEnd);
	const bodyMatches = areEquivalentValues(args.payload.input.slice(0, bodyEnd), [...leadingInput, ...bodyInput]);
	if (!bodyMatches || !trailingInput.every(isPromptEnvelopeItem)) {
		return { ok: false, reason: "expected-pi-replay-mismatch" };
	}

	const tail = cloneResponsesInput(args.payload.input.slice(leadingInput.length + keptInput.length, bodyEnd));
	if (!tail) {
		return { ok: false, reason: "expected-pi-replay-mismatch" };
	}

	return {
		ok: true,
		payload: {
			...args.payload,
			input: [...leadingInput, ...compactedWindow, ...tail, ...trailingInput.map((item) => cloneInputMessage(item))],
		},
	};
}
