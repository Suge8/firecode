/**
 * Master 事件卡：默认紧凑（每事件一行标题行），ctrl+o 展开完整内容。
 * 数据只来自消息正文里的信封（deliver.ts 是格式的唯一事实源）；渲染器抛错时宿主退回默认消息渲染。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown } from "@earendil-works/pi-tui";
import { clip, firstSentence, oneLine, textOf } from "../format.js";
import { parseEnvelopes } from "../deliver.js";
import { machineEntries } from "../tools/machine.js";
import { MASTER_EVENT_TYPE } from "./event-format.js";

export function registerMasterEventRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(MASTER_EVENT_TYPE, (message, options, theme) => {
		const text = textOf(message.content);
		return options.expanded ? fullCard(text, theme) : compactCard(text, theme);
	});
}

/** 每个事件一行：标题 + 正文首句；不是信封的消息退化为完整内容。 */
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
