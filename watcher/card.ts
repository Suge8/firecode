/**
 * 观察员建议的展示：单通道单一样式，从消息正文里的信封渲染（deliver.ts 拥有信封格式）。
 * 渲染器永不抛异常；不是信封的消息降级纯文本。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { parseEnvelopes, wrapEnvelope } from "../deliver.js";
import { clip, oneLine, textOf } from "../format.js";
import { RAIL, paintBgLine } from "../tools/line.js";

export const WATCHER_MESSAGE_TYPE = "firecode-watcher-note";

/** 继承 OMP 的 weigh don't blindly obey：投递给模型的正文自带权衡包装。 */
const WEIGH_NOTICE = "这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。";
const LABEL = "👓 观察员";

export function adviceMessage(card: WatcherCard): string {
	return wrapEnvelope("firecode_watcher", `${adviceHeadline(card)}\n${card.note}\n${WEIGH_NOTICE}`);
}

export interface WatcherCard {
	note: string;
	turnIndex: number;
}

function adviceHeadline(card: WatcherCard): string {
	return `${LABEL}（${timeMark(card.turnIndex)}）`;
}

/** 建议自带时点标记：投递时主会话可能已经走远，读的人要知道它看的是哪一刻。 */
function timeMark(turnIndex: number): string {
	return `基于第 ${turnIndex} 回合前的观察`;
}

export function registerWatcherCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(WATCHER_MESSAGE_TYPE, (message, options, theme) => {
		const advice = parseAdvice(message.content);
		return advice ? new AdviceLine(advice, options.expanded, theme) : new Text(textOf(message.content), 0, 0);
	});
}

interface Advice {
	headline: string;
	note: string;
}

/** 信封正文 = 标题行 + 建议 + 权衡声明（末行），与 adviceMessage 同构。 */
function parseAdvice(content: unknown): Advice | undefined {
	const body = parseEnvelopes(textOf(content))?.[0]?.body;
	if (body === undefined) return undefined;
	const lines = body.split("\n");
	return { headline: lines[0] ?? "", note: lines.slice(1, -1).join("\n") };
}

class AdviceLine implements Component {
	private readonly fallback: Component;

	constructor(
		private readonly card: Advice,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {
		this.fallback = new Text(`${card.headline} ${card.note}`, 0, 0);
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		try {
			const bgFn = (text: string) => this.theme.bg("toolPendingBg", text);
			if (this.expanded) {
				const headline = this.theme.fg("warning", clip(oneLine(this.card.headline), columns));
				const body = new Text(this.theme.fg("dim", `  ${this.card.note}\n  （供权衡，勿盲从）`), 0, 0);
				return [paintBgLine(headline, columns, bgFn), ...body.render(columns)];
			}
			// 收起与工具行同构：单行 + 背景条；时点标记只在展开态显示。
			const firstLine = oneLine(this.card.note.split(/\r?\n/u, 1)[0] ?? "");
			const line = clip(
				`${this.theme.fg("dim", RAIL)}${this.theme.fg("warning", LABEL)}${this.theme.fg("dim", ` — ${firstLine}`)}`,
				columns,
			);
			return [paintBgLine(line, columns, bgFn)];
		} catch {
			return this.fallback.render(columns);
		}
	}

	invalidate(): void {
		this.fallback.invalidate?.();
	}
}
