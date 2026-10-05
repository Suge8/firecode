/**
 * Master 事件卡：默认紧凑（每事件一行标题行），ctrl+o 展开完整内容。
 * 数据只来自消息正文里的信封（deliver.ts 是格式的唯一事实源）；渲染器永不抛异常。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Text } from "@earendil-works/pi-tui";
import { clip, firstSentence, oneLine } from "../format.js";
import { parseEnvelopes } from "../deliver.js";
import { machineEntries } from "../tools/machine.js";
import { MASTER_EVENT_TYPE } from "./event-format.js";

export function registerMasterEventRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		MASTER_EVENT_TYPE,
		(message, options, theme) => new MasterEventCard(message.content, options.expanded, theme),
	);
}

class MasterEventCard implements Component {
	private readonly card: Component;
	private readonly fallback: Component;

	constructor(content: string | (string | unknown)[], expanded: boolean, theme: Theme) {
		const text = plainContent(content);
		this.fallback = new Text(text, 0, 0);
		let card: Component | undefined;
		try {
			card = !expanded ? compactCard(text, theme) : fullCard(text, theme);
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

/** 每个事件一行：标题 + 正文首句；不是信封的旧消息退化为完整内容。 */
function compactCard(text: string, theme: Theme): Component {
	const entries = machineEntries(text);
	if (!entries) return fullCard(text, theme);
	return card(theme, entries.map((entry) =>
		new CompactTitle(`◆ ${entry.title}${entry.preview ? ` — ${firstSentence(entry.preview)}` : ""}`)));
}

/**
 * 单行截断：不用 pi-tui 的 TruncatedText——它的省略号带 `\x1b[0m` 全量重置，
 * 会在截断点把外层 Box 的背景色掠断（行尾露底色、右缘参差）；
 * clip 是纯文本截断，Box 补位后背景整行连续。
 */
class CompactTitle implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		return [clip(oneLine(this.text), Math.max(1, width))];
	}
}

function fullCard(text: string, theme: Theme): Component {
	const bodies = parseEnvelopes(text)?.map((envelope) => envelope.body).join("\n\n") ?? text;
	return card(theme, [new Markdown(bodies, 0, 0, getMarkdownTheme())]);
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
