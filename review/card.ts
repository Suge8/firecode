/**
 * 结果卡：渲染器 + payload 校验 + 各状态卡构建。
 *
 * 渲染器在 registerReview 顶层无条件注册（不懒加载、不挂 session_start），
 * 因此 live 与 reload 走同一个纯渲染路径，外观只有一种。渲染器永不抛异常：
 * details 校验不过就降级渲染 content 纯文本（pi 对抛异常的渲染器会静默回落默认框，
 * 与未注册表现相同，必须从源头避免）。
 *
 * payload 校验零外部依赖：纯函数一次性整体校验，不做字段级兼容。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
import { clip } from "../format.js";
import type { CardData, StopReason } from "./state.js";

export const CARD_TYPE = "firecode-review-card";
const VERSION = 1;

const CARD_KINDS = new Set([
	"queued",
	"start",
	"pass",
	"fail",
	"stop",
	"cancel",
	"timeout",
	"error",
]);
const CARD_TONES = new Set(["success", "warning", "error", "neutral", "accent"]);

export type CardDetails = {
	version: typeof VERSION;
	kind: CardData["kind"];
	title: string;
	lines: string[];
	tone: "success" | "warning" | "error" | "neutral" | "accent";
	icon: string;
};

/** 一次性整体校验结果卡 payload；结构不符返回 false（渲染器降级 content 纯文本）。 */
export function isValidCardDetails(value: unknown): value is CardDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 6) return false;
	if (record.version !== VERSION) return false;
	if (typeof record.kind !== "string" || !CARD_KINDS.has(record.kind)) return false;
	if (typeof record.title !== "string") return false;
	if (!Array.isArray(record.lines) || !record.lines.every((line) => typeof line === "string"))
		return false;
	if (typeof record.tone !== "string" || !CARD_TONES.has(record.tone)) return false;
	return typeof record.icon === "string";
}

export interface BuiltCard {
	content: string;
	details: CardDetails;
}

export function registerCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CardDetails>(
		CARD_TYPE,
		(message, _options, theme) => new ReviewCard(message.details, message.content, theme),
	);
}

class ReviewCard implements Component {
	constructor(
		private readonly details: CardDetails | undefined,
		private readonly content: string | (string | unknown)[],
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		try {
			return this.renderCard(width);
		} catch {
			return this.renderFallback(width);
		}
	}

	private renderCard(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (!isValidCardDetails(this.details))
			return this.renderFallback(width);
		const borderColor = borderFor(this.details.tone);
		const title = ` ${this.details.icon} ${this.details.title} `;
		const top = centeredTitle(title, safeWidth, (text) =>
			this.theme.fg(borderColor, text),
		);
		const body = this.details.lines.flatMap((line) =>
			cardBodyLines(line, safeWidth, this.theme),
		);
		const border = this.theme.fg(
			borderColor,
			"─".repeat(Math.max(1, safeWidth)),
		);
		return [top, ...body, border];
	}

	private renderFallback(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const text =
			typeof this.content === "string"
				? this.content
				: Array.isArray(this.content)
					? this.content.map(plainPart).filter(Boolean).join("\n")
					: "";
		return text
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.map((line) => padLine(line, safeWidth));
	}

	invalidate(): void {}
}

function plainPart(part: unknown): string {
	return typeof part === "object" && part !== null && "text" in part
		? String((part as { text: unknown }).text)
		: "";
}

function cardBodyLines(line: string, width: number, _theme: Theme): string[] {
	return line
		.split(/\r?\n/u)
		.flatMap((part) => wrapLine(plainCardLine(part), width))
		.map((part) => padLine(part, width));
}

/** 卡片展示纯文本，不把审查者输出里的 Markdown 语法当视觉内容。 */
function plainCardLine(line: string) {
	return line
		.replace(/^#{1,6}\s+/u, "")
		.replace(/^[-*+]\s+/u, "• ")
		.replace(/^```[\w-]*$/u, "")
		.replace(/`([^`]+)`/gu, "$1");
}

function centeredTitle(
	title: string,
	width: number,
	color: (text: string) => string,
): string {
	const visible = visibleWidth(title);
	if (visible >= width) return color(clip(title, width));
	const fill = width - visible;
	const left = Math.floor(fill / 2);
	const right = fill - left;
	return `${color("─".repeat(left))}${title}${color("─".repeat(right))}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

function wrapLine(line: string, width: number): string[] {
	if (!line) return [""];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const { segment } of graphemeSegmenter.segment(line)) {
		const segmentWidth = visibleWidth(segment);
		if (currentWidth + segmentWidth > width && current) {
			lines.push(current);
			current = "";
			currentWidth = 0;
			if (segment === " ") continue;
		}
		current += segment;
		currentWidth += segmentWidth;
	}
	lines.push(current);
	return lines;
}

function padLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? line : `${line}${" ".repeat(width - visible)}`;
}

function borderFor(tone: CardDetails["tone"]) {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "error") return "error";
	if (tone === "neutral") return "muted";
	return "accent";
}

// ---- 卡构建：content 给 LLM（纯文本事实），details 给渲染（本地化成品行）----

export function buildCard(card: CardData, language: Language): BuiltCard {
	switch (card.kind) {
		case "queued":
			return queued(card, language);
		case "start":
			return started(card, language);
		case "pass":
			return passed(card, language);
		case "fail":
			return failed(card, language);
		case "stop":
			return stopped(card, language);
		case "cancel":
			return cancelled(card, language);
		case "timeout":
			return timedOut(card, language);
		case "error":
			return errored(card, language);
	}
}

function queued(card: Extract<CardData, { kind: "queued" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review queued" : "审查已排队";
	const focusLine = card.focus
		? [language === "en" ? `Focus: ${card.focus}` : `关注点：${card.focus}`]
		: [];
	const lines = focusLine;
	return spec(language, "queued", title, lines, "neutral", "·");
}

function started(card: Extract<CardData, { kind: "start" }>, language: Language): BuiltCard {
	const title =
		language === "en" ? `Review · Round ${card.round}` : `审查 · 第 ${card.round} 轮`;
	const lines = [
		language === "en" ? `Models: ${card.models.map(shortModel).join(", ")}` : `模型：${card.models.map(shortModel).join("、")}`,
		...(card.focus
			? [language === "en" ? `Focus: ${card.focus}` : `关注点：${card.focus}`]
			: []),
	];
	return spec(language, "start", title, lines, "accent", "◆");
}

function shortModel(model: string) {
	return model.split("/").at(-1) || model;
}

function passed(card: Extract<CardData, { kind: "pass" }>, language: Language): BuiltCard {
	const title =
		language === "en"
			? `Quality check passed · Round ${card.round}`
			: `审查通过 · 第 ${card.round} 轮`;
	const lines = [
		card.summary,
		"",
		language === "en"
			? `Elapsed: ${elapsedLabel(card.elapsedMs, language)}`
			: `用时：${elapsedLabel(card.elapsedMs, language)}`,
	];
	return spec(language, "pass", title, lines, "success", "✓");
}

function failed(card: Extract<CardData, { kind: "fail" }>, language: Language): BuiltCard {
	const title =
		language === "en" ? `Review failed · Round ${card.round}` : `审查未通过 · 第 ${card.round} 轮`;
	// 顾问可能裁定 stop，反馈就永远不会投递：卡片不能提前宣布尚未发生的动作。
	const headline = card.awaitingAdvisor
		? language === "en"
			? "Advisor arbitration in progress; findings have not been sent back."
			: "顾问仲裁中，尚未交回修复。"
		: language === "en"
			? "Findings sent back for fixes."
			: "发现已交回修复。";
	const lines = [
		headline,
		"",
		...card.details.split("\n"),
		...(card.advisor && card.advisor.advice
			? ["", language === "en" ? "Advisor note" : "顾问建议", card.advisor.advice]
			: []),
	];
	return spec(language, "fail", title, lines, "warning", "×");
}

function stopped(card: Extract<CardData, { kind: "stop" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review stopped" : "审查已停止";
	const reason =
		card.reason === "advisor"
			? language === "en"
				? "Advisor recommends ending the loop."
				: "顾问建议结束循环。"
			: card.reason === "max_rounds"
				? language === "en"
					? "Maximum round limit reached."
					: "已达到最大轮数。"
				: "";
	const lines = [reason, ...(card.details ? [card.details] : [])];
	return spec(language, "stop", title, lines, "warning", "—");
}

function cancelled(card: Extract<CardData, { kind: "cancel" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review cancelled" : "审查已取消";
	const lines = [reasonText(card.reason, language)];
	return spec(language, "cancel", title, lines, "neutral", "—");
}

function timedOut(card: Extract<CardData, { kind: "timeout" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review timed out" : "审查超时";
	return spec(language, "timeout", title, [], "error", "◷");
}

/** 终止原因的展示文案（reducer 只出枚举，这里本地化）。 */
function reasonText(reason: StopReason, language: Language) {
	if (reason === "user")
		return language === "en" ? "Cancelled by user." : "已按你的操作停止。";
	if (reason === "shutdown")
		return language === "en" ? "Stopped on session close." : "会话关闭，已停止。";
	if (reason === "timeout")
		return language === "en" ? "Stopped after the overall timeout." : "总体超时，已停止。";
	return language === "en" ? "Stopped." : "已停止。";
}

function errored(card: Extract<CardData, { kind: "error" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review error" : "审查出错";
	const lines = [
		language === "en" ? "No valid findings were produced." : "未产生有效发现。",
		"",
		card.message,
	];
	return spec(language, "error", title, lines, "error", "!");
}

function spec(
	language: Language,
	kind: CardDetails["kind"],
	title: string,
	lines: string[],
	tone: CardDetails["tone"],
	icon: string,
): BuiltCard {
	const localized = localize(lines, language);
	return {
		content: `${title}\n${lines.join("\n")}`,
		details: { version: VERSION, kind, title, lines: localized, tone, icon },
	};
}

/** details 行已本地化成品；content 里除标题外都是事实，不做二次翻译。 */
function localize(lines: string[], language: Language) {
	return lines;
}

function elapsedLabel(ms: number, language: Language) {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return language === "en" ? `${seconds}s` : `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return language === "en"
		? `${minutes}m ${rest}s`
		: `${minutes} 分 ${rest} 秒`;
}
