/**
 * Master 事件卡：默认紧凑（每事件一行标题行），ctrl+o 展开完整内容。
 * content 给模型（完整事实），details 给渲染——两者刻意不对齐（先例：review/card.ts）。
 * 提取与校验的格式契约在 event-format.ts；旧会话无 details 的消息与校验失败一律降级
 * 完整内容；渲染器永不抛异常。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Text, TruncatedText } from "@earendil-works/pi-tui";
import {
	MASTER_EVENT_TYPE,
	isValidMasterEventDetails,
	type MasterEventDetails,
} from "./event-format.js";

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
			card = !expanded && isValidMasterEventDetails(details)
				? compactCard(details, theme)
				: fullCard(text, theme);
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
	// 宿主 CustomMessageComponent 已自带一行消息间距，这里不再叠加；垂直内边距也为 0。
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	for (const child of children) box.addChild(child);
	return box;
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
