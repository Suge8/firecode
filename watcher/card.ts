/**
 * 观察员建议卡：自定义 entry（不进入模型上下文），三档各自配色。
 * 渲染器永不抛异常；校验失败降级纯文本。
 */
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { clip, oneLine } from "../format.js";
import { SEVERITIES, type Severity } from "./observer.js";

export const WATCHER_CARD_TYPE = "firecode-watcher-advice";
export const WATCHER_MESSAGE_TYPE = "firecode-watcher-note";

/** 继承 OMP 的 weigh don't blindly obey：投递给模型的正文自带权衡包装。 */
const WEIGH_NOTICE = "这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。";

export function adviceMessage(card: WatcherCard): string {
	return `${adviceHeadline(card)}\n${card.note}\n${WEIGH_NOTICE}`;
}

export interface WatcherCard {
	severity: Severity;
	note: string;
	turnIndex: number;
}

const SEVERITY_STYLE: Record<Severity, { label: string; color: ThemeColor }> = {
	nit: { label: "顺手记", color: "muted" },
	concern: { label: "值得停一下", color: "warning" },
	blocker: { label: "再走就出事", color: "error" },
};

export function adviceHeadline(card: WatcherCard): string {
	return `👁 观察员 · ${SEVERITY_STYLE[card.severity].label}（${timeMark(card.turnIndex)}）`;
}

/** 建议自带时点标记：投递时主会话可能已经走远，读的人要知道它看的是哪一刻。 */
export function timeMark(turnIndex: number): string {
	return `基于第 ${turnIndex} 回合前的观察`;
}

export function registerWatcherCardRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<WatcherCard>(WATCHER_CARD_TYPE, (entry, _options, theme) => {
		const card = entry.data;
		return isValidCard(card) ? new AdviceLine(card, theme) : undefined;
	});
	pi.registerMessageRenderer<WatcherCard>(WATCHER_MESSAGE_TYPE, (message, _options, theme) =>
		isValidCard(message.details) ? new AdviceLine(message.details, theme) : new Text(String(message.content), 0, 0));
}

class AdviceLine implements Component {
	private readonly fallback: Component;

	constructor(private readonly card: WatcherCard, private readonly theme: Theme) {
		this.fallback = new Text(`${adviceHeadline(card)} ${card.note}`, 0, 0);
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		try {
			const style = SEVERITY_STYLE[this.card.severity];
			return [
				this.theme.fg(style.color, clip(oneLine(adviceHeadline(this.card)), columns)),
				this.theme.fg("dim", clip(oneLine(`  ${this.card.note}（供权衡，勿盲从）`), columns)),
			];
		} catch {
			return this.fallback.render(columns);
		}
	}

	invalidate(): void {
		this.fallback.invalidate?.();
	}
}

function isValidCard(value: unknown): value is WatcherCard {
	if (!value || typeof value !== "object") return false;
	const card = value as Record<string, unknown>;
	return SEVERITIES.includes(card.severity as Severity)
		&& typeof card.note === "string"
		&& typeof card.turnIndex === "number";
}
