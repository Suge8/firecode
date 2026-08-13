/**
 * 会话证据组装：取会话分支 entries 转纯文本，按 token 预算裁剪。
 *
 * 根因规避：首条用户消息是原始需求锚点，固定保留，不参与预算竞争；
 * 预算只裁剪中间的旧消息，从最新往前保留最近工作，审查者既知道要什么也知道做了什么。
 * 跳过 toolResult（输出体积大且非一手证据——审查者应自行重跑验证命令）。
 */
import type { Language } from "../config.js";

export const DEFAULT_EVIDENCE_TOKENS = 24_000;
/** 单条消息渲染上限，防单条超长消息撑爆预算。 */
const MESSAGE_MAX_CHARS = 3_000;

export interface Evidence {
	text: string;
	/** 被预算裁剪掉的中间消息条数。 */
	omitted: number;
}

export function buildEvidence(
	entries: readonly unknown[],
	language: Language,
	budgetTokens = DEFAULT_EVIDENCE_TOKENS,
): Evidence {
	const blocks = entries.flatMap((entry) => renderEntry(entry, language));
	if (blocks.length === 0) return { text: "", omitted: 0 };
	// 锚点必须是首条用户消息（原始需求）：它之前可能排着其他扩展的可显示消息，
	// 盲取第一块会把真正的需求锚点让进预算竞争、在长会话里被裁掉。
	const anchorIndex = Math.max(
		0,
		blocks.findIndex((block) => block.role === "user"),
	);
	const anchor = blocks[anchorIndex];
	const rest = blocks.filter((_, index) => index !== anchorIndex);
	const recent: string[] = [];
	let used = estimateTokens(anchor.text);
	let omitted = 0;
	for (let index = rest.length - 1; index >= 0; index -= 1) {
		const block = rest[index];
		const cost = estimateTokens(block.text);
		if (used + cost > budgetTokens) {
			omitted += 1;
			continue;
		}
		recent.push(block.text);
		used += cost;
	}
	recent.reverse();
	const text =
		recent.length === 0
			? anchor.text
			: `${anchor.text}\n\n${omitted > 0 ? gapLabel(omitted, language) : ""}${recent.join("\n\n")}`;
	return { text, omitted };
}

function gapLabel(omitted: number, language: Language) {
	return language === "en"
		? `[${omitted} intermediate message(s) omitted under the evidence budget]\n\n`
		: `[证据预算省略了 ${omitted} 条中间消息]\n\n`;
}

type EvidenceBlock = { text: string; role?: "user" };

function renderEntry(entry: unknown, language: Language): EvidenceBlock[] {
	if (!isRecord(entry)) return [];
	switch (entry.type) {
		case "message": {
			const message = asRecord(entry.message);
			if (!message) return [];
			if (message.role === "user")
				return [
					{
						text: `## ${userLabel(language)}\n${clip(messageText(message.content))}`,
						role: "user" as const,
					},
				];
			if (message.role === "assistant")
				return [{ text: `## ${assistantLabel(language)}\n${clip(messageText(message.content))}` }];
			return [];
		}
		case "custom_message": {
			if (entry.display !== true) return [];
			return [{ text: `## ${customLabel(language, String(entry.customType ?? ""))}\n${clip(messageText(entry.content))}` }];
		}
		case "compaction":
			return typeof entry.summary === "string" && entry.summary
				? [{ text: `## ${summaryLabel(language)}\n${clip(entry.summary)}` }]
				: [];
		case "branch_summary":
			return typeof entry.summary === "string" && entry.summary
				? [{ text: `## ${branchSummaryLabel(language)}\n${clip(entry.summary)}` }]
				: [];
		default:
			return [];
	}
}

function userLabel(language: Language) {
	return language === "en" ? "User" : "用户";
}

function assistantLabel(language: Language) {
	return language === "en" ? "Assistant" : "助手";
}

function customLabel(language: Language, customType: string) {
	return language === "en" ? `Message (${customType})` : `消息（${customType}）`;
}

function summaryLabel(language: Language) {
	return language === "en" ? "History summary (compacted)" : "历史摘要（已压缩）";
}

function branchSummaryLabel(language: Language) {
	return language === "en" ? "Branch summary" : "分支摘要";
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("\n");
}

function clip(text: string) {
	if (text.length <= MESSAGE_MAX_CHARS) return text.trim();
	return `${text.slice(0, MESSAGE_MAX_CHARS).trim()}\n[…]`;
}

/**
 * 粗略 token 估计：CJK 每字 1 token，其余按 4 字符/token。
 * 用于预算裁剪的相对量级，不追求精确。
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (isCjk(char)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}

function isCjk(char: string) {
	const code = char.codePointAt(0) ?? 0;
	return (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0xf900 && code <= 0xfaff)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}
