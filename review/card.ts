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
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { HEAT_COLORS, paint } from "../flame.js";
import { formatDuration } from "../format.js";
import { msg, REDUNDANT_VERDICT_LINES, termPattern } from "./messages.js";
import { shortModel, type CardData } from "./state.js";

export const CARD_TYPE = "firecode-review-card";
const VERSION = 1;

/**
 * 卡标题前的单色字形与它的语义色，按卡种类一处定义：构建时写进 details.icon，渲染时按种类上色。
 * 字形与全局体系一致（✓ ✗ ◌ ‖ 与审查的盲文点阵），颜色只表达结论：通过绿、失败与未完成红、取消灰，
 * 审查过程中的中性卡（开始、顾问指引）用审查的金色——品牌火焰不用于中性状态。
 */
const MARKS = {
	start: { glyph: "⠿", color: "review" },
	advisor: { glyph: "⠿", color: "review" },
	pass: { glyph: "✓", color: "success" },
	fail: { glyph: "✗", color: "error" },
	stop: { glyph: "✗", color: "error" },
	timeout: { glyph: "◌", color: "error" },
	error: { glyph: "◌", color: "error" },
} as const satisfies Record<CardData["kind"], { glyph: string; color: "review" | "success" | "error" }>;

const CARD_KINDS: ReadonlySet<string> = new Set(Object.keys(MARKS));
const TONES = ["success", "warning", "neutral"] as const;

function paintMark(details: CardDetails, theme: Theme): string {
	const { color } = MARKS[details.kind];
	return color === "review" ? paint(HEAT_COLORS.gold, details.icon) : theme.fg(color, details.icon);
}

type CardDetails = {
	version: typeof VERSION;
	kind: CardData["kind"];
	title: string;
	lines: string[];
	tone: (typeof TONES)[number];
	icon: string;
};

/** 一次性整体校验结果卡 payload；结构不符返回 false（渲染器降级 content 纯文本）。 */
function isValidCardDetails(value: unknown): value is CardDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 6) return false;
	if (record.version !== VERSION) return false;
	if (typeof record.kind !== "string" || !CARD_KINDS.has(record.kind)) return false;
	if (typeof record.title !== "string") return false;
	if (!Array.isArray(record.lines) || !record.lines.every((line) => typeof line === "string"))
		return false;
	if (!TONES.includes(record.tone as CardDetails["tone"])) return false;
	return typeof record.icon === "string";
}

interface BuiltCard {
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
	// 全家卡统一：无垂直内边距；消息间距由宿主 CustomMessageComponent 提供，不再叠加。
	const box = new Box(1, 0, (text) => theme.bg(backgroundFor(details.tone), text));
	box.addChild(new Text(`${paintMark(details, theme)} ${details.title}`, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(details.lines.join("\n"), 0, 0, getMarkdownTheme()));
	return box;
}

function backgroundFor(tone: CardDetails["tone"]) {
	if (tone === "success") return "toolSuccessBg" as const;
	return tone === "warning" ? "toolErrorBg" as const : "customMessageBg" as const;
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

export function buildCard(card: CardData): BuiltCard {
	switch (card.kind) {
		case "start":
			return started(card);
		case "pass":
			return passed(card);
		case "fail":
			return failed(card);
		case "stop":
			return stopped(card);
		case "timeout":
			return timedOut();
		case "error":
			return errored(card);
		case "advisor":
			return advisorCard(card);
	}
}

function started(card: Extract<CardData, { kind: "start" }>): BuiltCard {
	return spec("start", msg.card.started, [msg.card.startedModels(card.models.map(shortModel))], "neutral");
}

function passed(card: Extract<CardData, { kind: "pass" }>): BuiltCard {
	const title = qualityTitle(card.round, msg.card.passed);
	const lines = withFooter(formatReviewResultLines(card.summary), [
		elapsedLine(card.elapsedMs, card.round > 1 ? card.totalElapsedMs : undefined),
	]);
	return spec("pass", title, lines, "success");
}

function failed(card: Extract<CardData, { kind: "fail" }>): BuiltCard {
	const title = qualityTitle(card.round, msg.card.failed);
	return spec("fail", title, withFooter(formatReviewResultLines(card.details), [elapsedLine(card.elapsedMs)]), "warning");
}

function stopped(card: Extract<CardData, { kind: "stop" }>): BuiltCard {
	const footer = card.elapsedMs === undefined ? [] : [elapsedLine(card.elapsedMs)];
	if (card.reason === "advisor") {
		const title = qualityTitle(card.round, msg.card.stoppedByAdvisor);
		const body = [advisorModelLine(card.advisorModel), "", ...adviceLines(card.advisor.advice)];
		return spec("stop", title, withFooter(body, footer), "warning");
	}
	const title = qualityTitle(card.round, msg.card.failed);
	const body = formatReviewResultLines(card.details);
	return spec("stop", title, withFooter(body, footer), "warning");
}

function timedOut(): BuiltCard {
	return spec("timeout", msg.card.incomplete, [msg.card.timeoutBlocker, msg.card.timeoutReason], "warning");
}

function errored(card: Extract<CardData, { kind: "error" }>): BuiltCard {
	const lines = [
		msg.card.errorBlocker,
		msg.card.errorReason(card.message),
		...(card.elapsedMs === undefined ? [] : ["", elapsedLine(card.elapsedMs)]),
	];
	return spec("error", msg.card.incomplete, lines, "warning");
}

/** 顾问卡与审查结果卡同构：裁决进标题，正文用粗体模型分节行开头。 */
function advisorCard(card: Extract<CardData, { kind: "advisor" }>): BuiltCard {
	const title = msg.card.advisorGuidance(msg.card.decision[card.advisor.verdict]);
	const body = [advisorModelLine(card.advisorModel), "", ...adviceLines(card.advisor.advice)];
	return spec("advisor", title, withFooter(body, [elapsedLine(card.elapsedMs)]), "neutral");
}

/** 与审查结果卡的「**模型 N · xxx**」分节行同款式。 */
function advisorModelLine(model: string) {
	return msg.card.modelLine(shortModel(model));
}

/** 顾问建议排版：粗体段标题前补空行——Markdown 把单换行折进同段，不补行三段会糊成一块。 */
function adviceLines(advice: string) {
	const output: string[] = [];
	for (const line of advice.split(/\r?\n/u)) {
		if (/^\*\*[^*]+\*\*\s*[:：]/u.test(line.trim()) && output.length > 0 && output.at(-1) !== "")
			output.push("");
		output.push(line);
	}
	return output;
}

function qualityTitle(round: number, title: string) {
	return round <= 1 ? title : msg.card.round(round, title);
}

function withFooter(lines: string[], footer: string[]) {
	if (footer.length === 0) return lines;
	return [...lines, ...(lines.length > 0 ? ["", "---", ""] : []), ...footer];
}

function elapsedLine(ms: number, totalMs?: number) {
	return msg.card.elapsed(formatDuration(ms), totalMs === undefined ? undefined : formatDuration(totalMs));
}

/** 模型分节行（“模型 1 · xxx”）与证据行的识别：字段名两种语言都认。 */
const MODEL_SECTION = new RegExp(String.raw`^${termPattern((terms) => terms.model)}\s+\d+\s+·\s+`, "iu");
const EVIDENCE_LABEL = new RegExp(String.raw`^[-*+]?\s*(?:\*\*)?${termPattern((terms) => terms.field.evidence)}(?:\*\*)?\s*[:：]`, "u");

function formatReviewResultLines(review: string) {
	const lines = review.split(/\r?\n/u);
	const sections: { title: string; body: string[] }[] = [];
	const preface: string[] = [];
	let current: { title: string; body: string[] } | undefined;
	for (const line of lines) {
		if (MODEL_SECTION.test(line.trim())) {
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
		.filter((line) => !REDUNDANT_VERDICT_LINES.has(line.trim()));
	const output: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (output.length === 0 || output.at(-1) === "")) continue;
		// 证据/验证命令是取证区：与上面的结论区空一行分隔，密集长行不再糊成一片。
		if (
			EVIDENCE_LABEL.test(line.trim()) &&
			output.length > 0 &&
			output.at(-1) !== ""
		) output.push("");
		output.push(line.trim() === "" ? "" : line);
	}
	while (output.at(-1) === "") output.pop();
	return output;
}

function spec(
	kind: CardData["kind"],
	title: string,
	lines: string[],
	tone: CardDetails["tone"],
): BuiltCard {
	return {
		content: `${title}\n${lines.join("\n")}`,
		details: { version: VERSION, kind, title, lines, tone, icon: MARKS[kind].glyph },
	};
}
