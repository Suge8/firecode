/** 一轮的摘要行：只承担运行状态、耗时入口与异常提醒。运行中是火苗 + 当前动作 + 计时，正常结束是灰色 ✓ 耗时，异常才追加失败数与宿主提示原文。纯渲染，不碰宿主组件。 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { HEAT_COLORS, flame, mix, paint, settleMark } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { ARRIVAL_FLASH_MS } from "./turn-clock.js";

export interface SummaryView {
	failures: number;
	/** 折入段内的首条宿主提示原文（缓存、丢思考、压缩计费）。 */
	notice?: string;
	live: boolean;
	/** 运行中的当前动作词；落定后不显示。 */
	action?: string;
	/** 子代理结果刚到达：短暂替换当前动作。 */
	arrival?: { text: string; failed: boolean; age: number };
	elapsed?: number;
	sinceEnd?: number;
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
		const elapsed = view.elapsed === undefined ? [] : [theme.fg("muted", formatDuration(view.elapsed))];
		const failures = view.failures ? [theme.fg("error", `${view.failures} 次失败`)] : [];
		const join = (parts: string[]) => `${lead}${parts.map((part, index) => (index === 0 && !action ? " " : sep) + part).join("")}`;
		// 窄屏先裁提示原文，仍放不下再丢耗时；失败数是固定标记。
		for (const kept of [elapsed, []]) {
			const base = [...kept, ...failures];
			const room = width - visibleWidth(join(base)) - visibleWidth(sep) - 2;
			if (view.notice && room >= 4) return [join([...base, theme.fg("warning", `⚠ ${clip(view.notice, room)}`)])];
			if (!view.notice && visibleWidth(join(base)) <= width) return [join(base)];
		}
		return [clip(join([...failures]), Math.max(1, width))];
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
