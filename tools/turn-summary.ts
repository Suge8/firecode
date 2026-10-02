/** 一轮的摘要行：运行中是活的（火苗 + 当前动作 + 计时），落定后定格为 ✓ 时长 · 计数。纯渲染，不碰宿主组件。 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { HEAT_COLORS, flame, mix, paint, settleMark } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { ARRIVAL_FLASH_MS } from "./turn-clock.js";

export interface SummaryView {
	/** 已排好序的计数片段，如“读 3”“运行 1”。 */
	tally: readonly string[];
	failures: number;
	/** 折入段内的宿主提示条数（缓存、丢思考、压缩计费） */
	notices: number;
	live: boolean;
	/** 运行中的当前动作词；落定后不显示。 */
	action?: string;
	/** 子代理结果刚到达：短暂替换当前动作。 */
	arrival?: { text: string; failed: boolean; age: number };
	elapsed?: number;
	sinceEnd?: number;
	open: boolean;
	/** 单轮展开/收起；全局展开时为空，点击无效。 */
	toggle?: () => void;
}

export class TurnSummary implements Component {
	constructor(private readonly view: SummaryView, private readonly theme: Theme) {}
	invalidate(): void {}

	render(width: number): string[] {
		const { theme, view } = this;
		const sep = theme.fg("dim", " · ");
		const action = view.live ? this.actionText() : "";
		const glyph = view.live
			? flame(1, 0.05)
			: settleMark(view.failures ? "failed" : "done", view.sinceEnd ?? Infinity);
		const lead = action ? `${glyph} ${action}` : glyph;
		const arrow = theme.fg("dim", view.open ? "▾" : "▸");
		// 失败与提示是固定标记，永不丢；计时与计数从尾部逐个让位。
		const fixed = [
			...(view.failures ? [theme.fg("error", `${view.failures} 次失败`)] : []),
			...(view.notices ? [theme.fg("warning", `⚠ ${view.notices}`)] : []),
		];
		const optional = [
			...(view.elapsed === undefined ? [] : [theme.fg("muted", formatDuration(view.elapsed))]),
			...view.tally.map((part) => theme.fg("muted", part)),
		];
		const build = (count: number) => {
			const parts = [...fixed, ...optional.slice(0, count)];
			return `${lead}${parts.map((part, index) => (index === 0 && !action ? " " : sep) + part).join("")} ${arrow}`;
		};
		for (let count = optional.length; count >= 0; count--) {
			const line = build(count);
			if (visibleWidth(line) <= width) return [line];
		}
		return [clip(build(0), Math.max(1, width))];
	}

	private actionText(): string {
		const { theme, view } = this;
		const { arrival } = view;
		if (arrival && arrival.age < ARRIVAL_FLASH_MS) {
			const fade = Math.min(1, arrival.age / ARRIVAL_FLASH_MS);
			const settled = arrival.failed ? HEAT_COLORS.fail : HEAT_COLORS.gold;
			return paint(mix(HEAT_COLORS.white, settled, fade), theme.bold(arrival.text));
		}
		return theme.fg("text", view.action ?? "处理中");
	}

	handleMouse(event: TuiMouseEvent) {
		if (!this.view.toggle || event.type !== "click" || event.button !== "left") return undefined;
		this.view.toggle();
		return { handled: true };
	}
}

/** 单行文本，截断不加背景相关的 reset。 */
export class Line implements Component {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [clip(this.text, Math.max(1, width))];
	}
}
