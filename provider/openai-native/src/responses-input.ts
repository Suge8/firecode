import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { renderSystemMessageUpdate, resolveTranscriptTools } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
/** Pi session messages to OpenAI Responses input. Pi does not export this converter. */
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

export type NativeCompactionRequest = {
	model: string;
	input: unknown[];
	instructions: string;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
	/** messages[0] 是系统提示本身（已由 instructions 或请求前导携带），不再输出；否则所有系统消息都是对话中途的更新。 */
	leadingSystemMessage?: boolean;
};

type ResponsesCompat = {
	supportsDeveloperRole?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function compatOf(model: Model<Api>): ResponsesCompat {
	return (model.compat ?? {}) as ResponsesCompat;
}

function instructionRole(model: Model<Api>): "developer" | "system" {
	return model.reasoning && compatOf(model).supportsDeveloperRole !== false ? "developer" : "system";
}

/**
 * 宿主会把中途系统消息新增的工具原位发成 additional_tools / tool_search 项；
 * 扩展拿不到宿主的工具声明转换器（扩展运行时只暴露 pi-ai 根入口），这类历史无法逐项复现。
 */
export function hasAnchoredToolAdditions(
	model: Model<Api>,
	messages: AgentMessage[],
	options: Pick<SerializeResponsesMessagesOptions, "leadingSystemMessage"> = {},
): boolean {
	const compat = compatOf(model);
	if (compat.supportsMidConvoSystemMessages !== true) return false;
	const llmMessages = convertToLlm(messages);
	const supportsAdditions = compat.supportsAdditionalTools === true || compat.supportsToolSearch === true;
	if (!resolveTranscriptTools(llmMessages, supportsAdditions).anchorsAdditions) return false;
	return llmMessages.some(
		(message, index) =>
			message.role === "system" && !(options.leadingSystemMessage && index === 0) && (message.toolsAdded?.length ?? 0) > 0,
	);
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequest {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages, { leadingSystemMessage: true }),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	const transformedMessages = transformMessagesForResponses(convertToLlm(messages), model);
	const compat = compatOf(model);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: instructionRole(model),
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	for (const [sourceIndex, message] of transformedMessages.entries()) {
		if (message.role === "system") {
			// 与宿主 convertResponsesMessages 一致：模型不支持中途系统消息时宿主把它们折进首条提示，输入里没有对应项；
			// 支持时原位发出更新文本并占一个消息序号；新增工具项不发：压缩请求本身不带工具声明。
			if (options.leadingSystemMessage && sourceIndex === 0) continue;
			if (compat.supportsMidConvoSystemMessages !== true) continue;
			const text = renderSystemMessageUpdate(message);
			if (text.length > 0) input.push({ role: instructionRole(model), content: sanitizeSurrogates(text) });
			messageIndex++;
			continue;
		}

		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex);
			if (items.length > 0) {
				input.push(...items);
			}
			messageIndex++;
			continue;
		}

		input.push(serializeToolResultMessage(message, model));
		messageIndex++;
	}

	return input;
}

function normalizeAssistantContent<TApi extends Api>(
	message: AssistantMessage,
	model: Model<TApi>,
): AssistantMessage["content"] {
	const isSameModel =
		message.provider === model.provider && message.api === model.api && message.model === model.id;
	const content: AssistantMessage["content"] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			if (block.redacted) {
				if (isSameModel) content.push(block);
				continue;
			}
			if (isSameModel) {
				if (block.thinkingSignature) content.push(block);
				continue;
			}
			if (block.thinking.trim()) {
				content.push({ type: "text", text: block.thinking });
			}
			continue;
		}

		if (block.type === "text" && !isSameModel) {
			content.push({ type: "text", text: block.text });
			continue;
		}

		content.push(block);
	}

	return content;
}

function transformMessagesForResponses<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const transformed: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant") {
			if (pendingToolCalls.length > 0) {
				transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
				pendingToolCalls = [];
				existingToolResultIds = new Set<string>();
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			const normalizedContent = normalizeAssistantContent(message, model);
			transformed.push({ ...message, content: normalizedContent });
			const toolCalls = normalizedContent.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set<string>();
			}
			continue;
		}

		if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			transformed.push(message);
			continue;
		}

		if (pendingToolCalls.length > 0) {
			transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
			pendingToolCalls = [];
			existingToolResultIds = new Set<string>();
		}
		transformed.push(message);
	}

	return transformed;
}

function createSyntheticToolResults(
	pendingToolCalls: readonly ToolCall[],
	existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
	const syntheticResults: ToolResultMessage[] = [];

	for (const toolCall of pendingToolCalls) {
		if (existingToolResultIds.has(toolCall.id)) {
			continue;
		}

		syntheticResults.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: Date.now(),
		});
	}

	return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

function serializeAssistantMessage(message: AssistantMessage, messageIndex: number): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) {
				items.push(reasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex),
				phase: signature?.phase,
			});
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		items.push({
			type: "function_call",
			id: rawItemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
	const [callId] = message.toolCallId.split("|");
	const textOutput = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = message.content.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of message.content) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type: "function_call_output",
			call_id: callId,
			output,
		};
	}

	return {
		type: "function_call_output",
		call_id: callId,
		output: hasText ? textOutput : "(see attached image)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return undefined;
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number): string {
	if (!id) {
		return `msg_${messageIndex}`;
	}

	if (id.length <= 64) {
		return id;
	}

	return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

