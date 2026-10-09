/**
 * 一轮的摘要行：只承担运行状态、事后记录与异常提醒。运行中是火苗 + 当前动作（实时计时只在边框），落定后是 ✓ 整段耗时 · 均速，
 * 中断/请求失败是 ✗ 加终态字样；这一轮有子代理失败追加“N 个子代理失败”，宿主的 ⚠ 提示原文也追加。
 * 工具失败是模型的工作过程，不计数、不影响标记。纯渲染，不碰宿主组件。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { HEAT_COLORS, flame, mix, paint, settleMark } from "../flame.js";
import { clip } from "../format.js";
import { CHAT_GUTTER } from "./line.js";
import { msg } from "./messages.js";
import { OUTCOME_TEXT, type Round, roundTexts } from "../round.js";

/** 子代理结果到达后摘要行高亮多久。 */
export const ARRIVAL_FLASH_MS = 2500;

export interface SummaryView {
	/** 折入段内的首条宿主提示原文（缓存、丢思考、压缩计费）。 */
	notice?: string;
	live: boolean;
	/** 运行中的当前动作（动作词 + 简短目标）；落定后或指挥官只在等子代理时没有，只画火苗。 */
	action?: { word: string; target?: string };
	/** 子代理结果刚到达：短暂替换当前动作。 */
	arrival?: { text: string; failed: boolean; age: number };
	/** 这一轮里失败的子代理数（按名字去重）。 */
	failures?: number;
	/** 落定后的轮记录：这一轮各段合成的耗时与终态（见 round.ts 的 combineRounds）。 */
	round?: Round;
	/** 这一轮更早几段的非完成终态短标记，如“中断过 1 次”。 */
	earlier?: string[];
	sinceEnd?: number;
	/** 单轮展开/收起；全局展开时为空，点击无效。 */
	toggle?: () => void;
}

/** 提示原文被目标挤压时至少保留的列数。 */
const NOTICE_MIN = 12;
/** 目标少于这个宽度就不显示，只留动作词。 */
const MIN_TARGET = 4;

export class TurnSummary implements Component {
	constructor(private readonly view: SummaryView, private readonly theme: Theme) {}
	invalidate(): void {}

	render(full: number): string[] {
		const width = full - CHAT_GUTTER;
		const { theme, view } = this;
		const sep = theme.fg("dim", " · ");
		const outcome = this.outcomeText();
		const word = view.live ? this.actionText() : outcome;
		const target = view.live && view.action?.target && !this.flashing() ? view.action.target : undefined;
		const glyph = view.live
			? flame(1, 0.05)
			: settleMark(outcome ? "failed" : "done", view.sinceEnd ?? Infinity);
		const head = word ? `${glyph} ${word}` : glyph;
		const record = view.round === undefined ? [] : roundTexts(view.round).map((text) => theme.fg("muted", text));
		// 失败数与更早的中断都是不能丢的固定标记，窄屏时与它们一起保留。
		const failures = [
			...(view.earlier ?? []).map((text) => theme.fg("warning", text)),
			...(view.failures ? [theme.fg("error", msg.failedWorkers(view.failures))] : []),
		];
		const join = (lead: string, parts: string[]) => `${lead}${parts.map((part, index) => (index === 0 && !word ? " " : sep) + part).join("")}`;
		const noticeNeed = view.notice ? visibleWidth(sep) + 2 + Math.min(visibleWidth(view.notice), NOTICE_MIN) : 0;
		// 窄屏先裁目标（给提示原文留出最小空间），再裁提示原文，仍放不下再丢记录，最后丢提示原文；动作词与失败数是固定标记。
		for (const base of [[...record, ...failures], failures]) {
			const targetRoom = width - visibleWidth(join(head, base)) - noticeNeed - 1;
			const lead = target && targetRoom >= MIN_TARGET ? `${head} ${theme.fg("muted", clip(target, targetRoom))}` : head;
			const used = visibleWidth(join(lead, base));
			if (!view.notice && used <= width) return [join(lead, base)];
			const noticeRoom = width - used - visibleWidth(sep) - 2;
			if (view.notice && noticeRoom >= 4) return [join(lead, [...base, theme.fg("warning", `⚠ ${clip(view.notice, noticeRoom)}`)])];
		}
		const marked = join(head, failures);
		return [visibleWidth(marked) <= width ? marked : clip(head, Math.max(1, width))];
	}

	private flashing(): boolean {
		return !!this.view.arrival && this.view.arrival.age < ARRIVAL_FLASH_MS;
	}

	private outcomeText(): string {
		const text = OUTCOME_TEXT[this.view.round?.outcome ?? "complete"];
		return text && this.theme.fg("error", text);
	}

	private actionText(): string {
		const { theme, view } = this;
		const { arrival } = view;
		if (arrival && arrival.age < ARRIVAL_FLASH_MS) {
			const fade = Math.min(1, arrival.age / ARRIVAL_FLASH_MS);
			const settled = arrival.failed ? HEAT_COLORS.fail : HEAT_COLORS.gold;
			return paint(mix(HEAT_COLORS.white, settled, fade), theme.bold(arrival.text));
		}
		return view.action ? theme.fg("text", view.action.word) : "";
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
		return [clip(this.text, Math.max(1, width - CHAT_GUTTER))];
	}
}
