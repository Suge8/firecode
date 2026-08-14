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
import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
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
	"advisor",
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
	private readonly card: Component | undefined;
	private readonly fallback: Component;

	constructor(details: CardDetails | undefined, content: string | (string | unknown)[], theme: Theme) {
		this.fallback = new Text(plainContent(content), 0, 0);
		let card: Component | undefined;
		try {
			card = isValidCardDetails(details) ? nativeCard(details, theme) : undefined;
		} catch {
			card = undefined;
		}
		this.card = card;
	}

	render(width: number): string[] {
		try {
			return (this.card ?? this.fallback).render(Math.max(1, width));
		} catch {
			try {
				return this.fallback.render(Math.max(1, width));
			} catch {
				return [];
			}
		}
	}

	invalidate(): void {
		this.card?.invalidate?.();
		this.fallback.invalidate?.();
	}
}

function nativeCard(details: CardDetails, theme: Theme): Component {
	const container = new Container();
	const box = new Box(1, 1, (text) => theme.bg(backgroundFor(details.tone), text));
	box.addChild(new Text(`${details.icon} ${details.title}`, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(details.lines.join("\n"), 0, 0, getMarkdownTheme()));
	container.addChild(new Spacer(1));
	container.addChild(box);
	return container;
}

function backgroundFor(tone: CardDetails["tone"]) {
	if (tone === "success") return "toolSuccessBg" as const;
	if (tone === "warning" || tone === "error") return "toolErrorBg" as const;
	return "customMessageBg" as const;
}

function plainContent(content: string | (string | unknown)[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(plainPart).filter(Boolean).join("\n");
}

function plainPart(part: unknown): string {
	return typeof part === "object" && part !== null && "text" in part
		? String((part as { text: unknown }).text)
		: "";
}

// ---- 卡构建：content 给 LLM（纯文本事实），details 给渲染（本地化成品行）----

export function buildCard(card: CardData, language: Language): BuiltCard {
	switch (card.kind) {
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
		case "advisor":
			return advisorCard(card, language);
	}
}

// "queued" 仍留在 CARD_KINDS：旧会话的排队卡 reload 时要能继续按卡渲染，只是不再新发。

function started(card: Extract<CardData, { kind: "start" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review started" : "审查开始";
	const lines = [
		language === "en"
			? `Models: ${card.models.map(shortModel).join(", ")}`
			: `模型：${card.models.map(shortModel).join("、")}`,
	];
	return spec(language, "start", title, lines, "neutral", "💯");
}

function shortModel(model: string) {
	return model.split("/").at(-1) || model;
}

function passed(card: Extract<CardData, { kind: "pass" }>, language: Language): BuiltCard {
	const title = qualityTitle(card.round, language === "en" ? "Review passed" : "审查通过", language);
	const lines = withFooter(formatReviewResultLines(card.summary), [
		elapsedLine(card.elapsedMs, card.totalElapsedMs, card.round > 1, language),
	]);
	return spec(language, "pass", title, lines, "success", "✅");
}

function failed(card: Extract<CardData, { kind: "fail" }>, language: Language): BuiltCard {
	const title = qualityTitle(card.round, language === "en" ? "Review failed" : "审查未通过", language);
	const footer = [
		...(card.advisor?.advice
			? [language === "en" ? "Advisor note" : "顾问建议", card.advisor.advice]
			: []),
		...(card.elapsedMs === undefined
			? []
			: [elapsedLine(card.elapsedMs, card.totalElapsedMs, false, language)]),
	];
	return spec(
		language,
		"fail",
		title,
		withFooter(formatReviewResultLines(card.details), footer),
		"warning",
		"❌",
	);
}

function stopped(card: Extract<CardData, { kind: "stop" }>, language: Language): BuiltCard {
	const footer = card.elapsedMs === undefined
		? []
		: [elapsedLine(card.elapsedMs, card.totalElapsedMs, false, language)];
	if (card.reason === "advisor") {
		const title = qualityTitle(
			card.round,
			language === "en" ? "Review stopped by advisor" : "审查已由顾问终止",
			language,
		);
		const body = [advisorDecision("stop", card.advisorModel, language), "", card.advisor.advice];
		return spec(language, "stop", title, withFooter(body, footer), "warning", "❌");
	}
	const title = qualityTitle(card.round, language === "en" ? "Review failed" : "审查未通过", language);
	const body = formatReviewResultLines(card.details || stopReason(card.reason, language));
	return spec(language, "stop", title, withFooter(body, footer), "warning", "❌");
}

function cancelled(card: Extract<CardData, { kind: "cancel" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review cancelled" : "审查已取消";
	return spec(language, "cancel", title, [reasonText(card.reason, language)], "neutral", "⏸");
}

function timedOut(_card: Extract<CardData, { kind: "timeout" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review incomplete" : "审查未完成";
	const lines = [
		language === "en" ? "Blocker: review timed out" : "卡点：审查超时",
		language === "en" ? "Reason: overall time limit exceeded" : "原因：超过总体时限",
	];
	return spec(language, "timeout", title, lines, "warning", "🛑");
}

/** 终止原因的展示文案（reducer 只出枚举，这里本地化）。 */
function reasonText(reason: StopReason, language: Language) {
	if (reason === "user")
		return language === "en" ? "Stopped by user" : "已按你的操作停止";
	if (reason === "shutdown")
		return language === "en" ? "Stopped when the session closed" : "会话关闭时停止";
	return language === "en" ? "Stopped" : "已停止";
}

function stopReason(reason: StopReason, language: Language) {
	if (reason === "advisor")
		return language === "en" ? "Advisor recommends stopping" : "顾问建议停止";
	if (reason === "max_rounds")
		return language === "en" ? "Maximum review rounds reached" : "已达到最大审查轮数";
	return reasonText(reason, language);
}

function errored(card: Extract<CardData, { kind: "error" }>, language: Language): BuiltCard {
	const title = language === "en" ? "Review incomplete" : "审查未完成";
	const lines = [
		language === "en" ? "Blocker: review did not complete" : "卡点：审查未完成",
		language === "en" ? `Reason: ${card.message}` : `原因：${card.message}`,
		...(card.elapsedMs === undefined
			? []
			: ["", elapsedLine(card.elapsedMs, card.totalElapsedMs, false, language)]),
	];
	return spec(language, "error", title, lines, "warning", "🛑");
}

function advisorCard(card: Extract<CardData, { kind: "advisor" }>, language: Language): BuiltCard {
	const body = [advisorDecision(card.advisor.verdict, card.advisorModel, language), "", card.advisor.advice];
	const footer = card.elapsedMs === undefined ? [] : [elapsedLine(card.elapsedMs, undefined, false, language)];
	return spec(
		language,
		"advisor",
		language === "en" ? "Advisor advice" : "顾问建议",
		withFooter(body, footer),
		"neutral",
		"🧭",
	);
}

function advisorDecision(verdict: "continue" | "narrow" | "stop", model: string, language: Language) {
	const decision = language === "en"
		? { continue: "Continue fixing", narrow: "Narrow scope", stop: "Stop fixing" }[verdict]
		: { continue: "继续修复", narrow: "收窄范围", stop: "停止修复" }[verdict];
	const name = shortModel(model);
	return language === "en"
		? `Decision: ${decision} · Advisor model: ${name}`
		: `裁决：${decision} · 顾问模型：${name}`;
}

function qualityTitle(round: number, title: string, language: Language) {
	if (round <= 1) return title;
	return language === "en" ? `Round ${round} ${title}` : `第 ${round} 轮${title}`;
}

function withFooter(lines: string[], footer: string[]) {
	if (footer.length === 0) return lines;
	return [...lines, ...(lines.length > 0 ? ["", "---", ""] : []), ...footer];
}

function elapsedLine(
	ms: number,
	totalMs: number | undefined,
	showTotal: boolean,
	language: Language,
) {
	const elapsed = showTotal && totalMs !== undefined
		? `${elapsedLabel(ms)} / ${language === "en" ? "total" : "总"} ${elapsedLabel(totalMs)}`
		: elapsedLabel(ms);
	return language === "en" ? `⏱ Elapsed: ${elapsed}` : `⏱ 用时：${elapsed}`;
}

function formatReviewResultLines(review: string) {
	const lines = review.split(/\r?\n/u);
	const sections: { title: string; body: string[] }[] = [];
	const preface: string[] = [];
	let current: { title: string; body: string[] } | undefined;
	for (const line of lines) {
		if (/^(?:模型|Model)\s+\d+\s+·\s+/iu.test(line.trim())) {
			if (current) sections.push(current);
			current = { title: line.trim(), body: [] };
		} else if (current) current.body.push(line);
		else preface.push(line);
	}
	if (current) sections.push(current);
	if (sections.length === 0) return normalizedReviewLines(review);
	return [
		...normalizedReviewLines(preface.join("\n")),
		...(preface.join("").trim() ? [""] : []),
		...sections.flatMap((section, index) => [
			...(index > 0 ? ["", "---", ""] : []),
			`**${section.title}**`,
			"",
			...normalizedReviewLines(section.body.join("\n")),
		]),
	];
}

function normalizedReviewLines(review: string) {
	const lines = review
		.split(/\r?\n/u)
		.map((line) => line.trimEnd())
		.filter((line) => !REDUNDANT_REVIEW_LINES.has(line.trim()));
	const output: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (output.length === 0 || output.at(-1) === "")) continue;
		output.push(line.trim() === "" ? "" : line);
	}
	while (output.at(-1) === "") output.pop();
	return output;
}

const REDUNDANT_REVIEW_LINES = new Set([
	"PASS",
	"FAIL",
	"通过",
	"未通过",
	"审查通过",
	"审查未通过",
	"Review passed",
	"Review failed",
]);

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

function elapsedLabel(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder ? `${minutes}m${remainder}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m${remainder ? `${remainder}s` : ""}`;
}
