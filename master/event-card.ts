/**
 * Master 事件卡：默认紧凑（每事件一行标题行），ctrl+o 展开完整内容。
 * content 给模型（完整事实），details 给渲染——两者刻意不对齐（先例：review/card.ts）。
 * 旧会话无 details 的消息与校验失败一律降级完整内容；渲染器永不抛异常。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";

export const MASTER_EVENT_TYPE = "firecode-master-event";
const VERSION = 1;

export interface MasterEventDetails {
	version: typeof VERSION;
	titles: string[];
}

/** 正文分节标记行：其后第一行即正文首句，作紧凑行预览。 */
const BODY_MARKER = /^(?:回复|错误|问题|最终回复|中断前最后输出)：$/u;

/** 每个事件一行：首行标题句 + 正文首句预览（渲染时按宽度截断）。 */
export function masterEventDetails(contents: string[]): MasterEventDetails {
	return { version: VERSION, titles: contents.map(compactLine) };
}

function compactLine(content: string): string {
	const lines = content.split("\n");
	const title = lines[0] ?? "";
	const marker = lines.findIndex((line) => BODY_MARKER.test(line.trim()));
	if (marker < 0) return title;
	const preview = lines.slice(marker + 1).find((line) => line.trim());
	return preview ? `${title} — ${preview.trim()}` : title;
}

function isValidDetails(value: unknown): value is MasterEventDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || record.version !== VERSION) return false;
	return Array.isArray(record.titles) &&
		record.titles.length > 0 &&
		record.titles.every((title) => typeof title === "string");
}

export function registerMasterEventRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<MasterEventDetails>(
		MASTER_EVENT_TYPE,
		(message, options, theme) =>
			new MasterEventCard(message.details, message.content, options.expanded, theme),
	);
}

class MasterEventCard implements Component {
	private readonly card: Component;
	private readonly fallback: Component;

	constructor(
		details: MasterEventDetails | undefined,
		content: string | (string | unknown)[],
		expanded: boolean,
		theme: Theme,
	) {
		const text = plainContent(content);
		this.fallback = new Text(text, 0, 0);
		let card: Component | undefined;
		try {
			card = !expanded && isValidDetails(details) ? compactCard(details, theme) : fullCard(text, theme);
		} catch {
			card = undefined;
		}
		this.card = card ?? this.fallback;
	}

	render(width: number): string[] {
		try {
			return this.card.render(Math.max(1, width));
		} catch {
			try {
				return this.fallback.render(Math.max(1, width));
			} catch {
				return [];
			}
		}
	}

	invalidate(): void {
		this.card.invalidate?.();
		this.fallback.invalidate?.();
	}
}

function compactCard(details: MasterEventDetails, theme: Theme): Component {
	return card(theme, details.titles.map((title) => new TruncatedText(`◆ ${title}`, 0, 0)));
}

function fullCard(text: string, theme: Theme): Component {
	return card(theme, [new Markdown(text, 0, 0, getMarkdownTheme())]);
}

function card(theme: Theme, children: Component[]): Component {
	const container = new Container();
	// 与全家卡统一：无垂直内边距（paddingY 0），只留消息间距。
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	for (const child of children) box.addChild(child);
	container.addChild(new Spacer(1));
	container.addChild(box);
	return container;
}

function plainContent(content: string | (string | unknown)[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && "text" in part
				? String((part as { text: unknown }).text)
				: "")
		.filter(Boolean)
		.join("\n");
}
