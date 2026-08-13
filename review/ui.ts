/**
 * /fire-review 的活动 UI：编辑器上方的固定活动条、alt+s 详情窗、esc 取消接管。
 *
 * 只读 executor 传入的快照函数，自身不持状态；动画由组件内部计时器驱动，
 * dispose 时清理。审查看不见就等于坏了，这一层是可用性的主体。
 */
import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import { clip, formatDuration } from "../format.js";
import type { Language } from "../config.js";
import type { ReviewerProgress } from "./progress.js";
import type { Phase } from "./state.js";

export const DETAILS_SHORTCUT = "alt+s";
const WIDGET_KEY = "fire-review";
const FRAME_MS = 120;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LABEL_WIDTH = 18;
/** 详情窗打开期间屏蔽全局 esc：否则一次 esc 会同时关窗并取消审查。 */
let detailsOpen = false;

/** 活动条渲染所需的一切；executor 每次状态变化后重新提供。 */
export interface ActivityView {
	phase: Phase;
	round: number;
	focus: string;
	roundStartedAt: number;
	reviewers: readonly ReviewerProgress[];
	advisorRunning: boolean;
	language: Language;
}

type ViewSource = () => ActivityView | undefined;

export function showActivity(ctx: ExtensionContext, view: ViewSource): void {
	if (typeof ctx.ui.setWidget !== "function") return;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: TUI, theme: Theme) =>
			new ActivityBar(view, theme, () => tui.requestRender()),
		{ placement: "aboveEditor" },
	);
}

export function hideActivity(ctx: ExtensionContext): void {
	if (typeof ctx.ui.setWidget === "function")
		ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * 审查等模型结论时（排队/审查中/顾问仲裁）接管编辑器：禁止输入，esc 取消审查。
 *
 * 不能用全局输入钩子比对裸 \x1b：终端开启增强键盘协议后 esc 是带修饰的序列，
 * 字面量比较会漏。这里统一走 keybindings 匹配。
 * awaiting_fix 相不接管——那时是执行模型在改代码，用户应能正常输入与中断。
 */
export function lockEditor(
	ctx: ExtensionContext,
	view: ViewSource,
	cancel: () => void,
): void {
	if (typeof ctx.ui.setEditorComponent !== "function") return;
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = new ReviewEditor(tui, theme, keybindings, view, cancel, () =>
			void openDetails(ctx, view),
		);
		return editor;
	});
}

export function unlockEditor(ctx: ExtensionContext): void {
	if (typeof ctx.ui.setEditorComponent === "function")
		ctx.ui.setEditorComponent(undefined);
}

/**
 * 审查期间的只读编辑器。
 *
 * 故意不做动画：宿主切换编辑器时只清容器、不调旧组件的 dispose（见
 * interactive-mode 的 setCustomEditorComponent），在这里启定时器就会每轮泄漏一个。
 * 动效由上方活动条负责，这里静态提示即可。
 */
class ReviewEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly view: ViewSource,
		private readonly cancel: () => void,
		private readonly details: () => void,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		if (detailsOpen) return;
		if (matchesKey(data, DETAILS_SHORTCUT)) {
			this.details();
			return;
		}
		if (this.keys.matches(data, "app.interrupt")) {
			this.cancel();
			return;
		}
		// 审查期间不接受任何其他输入：插话会污染本轮审查的会话证据。
	}

	override render(width: number): string[] {
		const language = this.view()?.language ?? "zh";
		return [clip(lockedText(language), Math.max(8, width))];
	}
}

export async function openDetails(
	ctx: ExtensionContext,
	view: ViewSource,
): Promise<void> {
	if (!view() || typeof ctx.ui.custom !== "function") return;
	detailsOpen = true;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) =>
				new DetailsOverlay(view, tui, theme, keybindings, done),
			{ overlay: true, overlayOptions: { width: "72%", maxHeight: "60%", anchor: "center" } },
		);
	} finally {
		detailsOpen = false;
	}
}

// ---- 组件 ----

abstract class Animated implements Component {
	protected frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(requestRender: () => void) {
		this.timer = setInterval(() => {
			this.frame += 1;
			requestRender();
		}, FRAME_MS);
		this.timer.unref?.();
	}

	abstract render(width: number): string[];

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	protected spinner() {
		return SPINNER[this.frame % SPINNER.length];
	}
}

class ActivityBar extends Animated {
	constructor(
		private readonly view: ViewSource,
		private readonly theme: Theme,
		requestRender: () => void,
	) {
		super(requestRender);
	}

	render(width: number): string[] {
		const view = this.view();
		if (!view) return [];
		const safeWidth = Math.max(8, width);
		const labelWidth = Math.min(
			MAX_LABEL_WIDTH,
			Math.max(...view.reviewers.map((reviewer) => reviewer.label.length), 6),
		);
		return [
			this.heading(view, safeWidth),
			...view.reviewers.map((reviewer) => this.row(reviewer, safeWidth, labelWidth)),
			...this.advisorRow(view, safeWidth, labelWidth),
		];
	}

	private heading(view: ActivityView, width: number) {
		const elapsed = view.roundStartedAt
			? ` · ${formatDuration(Date.now() - view.roundStartedAt)}`
			: "";
		const title = `${headingText(view, view.language)}${elapsed}`;
		const focus = view.focus ? ` · ${view.focus}` : "";
		return this.theme.fg("accent", clip(`${title}${focus}`, width));
	}

	private row(
		reviewer: ReviewerProgress,
		width: number,
		labelWidth: number,
	) {
		const mark =
			reviewer.status === "running"
				? this.theme.fg("accent", this.spinner())
				: this.theme.fg(statusColor(reviewer.status), statusMark(reviewer.status));
		const label = padLabel(reviewer.label, labelWidth);
		const calls =
			reviewer.status === "running" && reviewer.toolCalls > 0
				? ` · ${reviewer.toolCalls}`
				: "";
		const detail = clip(`${reviewer.action}${calls}`, Math.max(4, width - labelWidth - 6));
		return `  ${mark} ${this.theme.fg("muted", label)}  ${this.theme.fg("dim", detail)}`;
	}

	private advisorRow(view: ActivityView, width: number, labelWidth: number) {
		if (!view.advisorRunning) return [];
		const label = padLabel(advisorText(view.language), labelWidth);
		return [
			`  ${this.theme.fg("warning", this.spinner())} ${this.theme.fg("muted", clip(label, width - 4))}`,
		];
	}
}

class DetailsOverlay extends Animated {
	private closed = false;

	constructor(
		private readonly view: ViewSource,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {
		super(() => tui.requestRender());
	}

	render(width: number): string[] {
		const view = this.view();
		const safeWidth = Math.max(12, width);
		const inner = safeWidth - 4;
		const language = view?.language ?? "zh";
		const body: string[] = [];
		if (!view) body.push(this.theme.fg("dim", detailsEmptyText(language)));
		else {
			body.push(this.theme.fg("accent", clip(headingText(view, language), inner)));
			for (const reviewer of view.reviewers) {
				body.push("");
				body.push(
					`${this.theme.fg(statusColor(reviewer.status), statusMark(reviewer.status))} ${this.theme.fg(
						"muted",
						clip(reviewerSummary(reviewer, language), inner - 2),
					)}`,
				);
				const trail = reviewer.trail.slice(-8);
				if (trail.length === 0)
					body.push(this.theme.fg("dim", `  ${detailsEmptyText(language)}`));
				for (const item of trail)
					body.push(this.theme.fg("dim", clip(`  ${item}`, inner)));
			}
		}
		body.push("");
		body.push(this.theme.fg("dim", clip(detailsHintText(language), inner)));
		// 自带边框与背景填充：overlay 不提供底色，不填就会与底层聊天内容糊在一起。
		const line = (left: string, fill: string, right: string) =>
			this.theme.fg("borderMuted", `${left}${fill.repeat(Math.max(0, safeWidth - 2))}${right}`);
		return [
			line("╭", "─", "╮"),
			...body.map((row) => this.framed(row, safeWidth)),
			line("╰", "─", "╯"),
		];
	}

	private framed(row: string, width: number) {
		const edge = this.theme.fg("borderMuted", "│");
		const content = padVisible(row, width - 4);
		return `${edge} ${content} ${edge}`;
	}

	handleInput(data: string): void {
		// 悬浮窗内不接受文本输入：详情快捷键与中断键都用来关闭。
		if (data === DETAILS_ESCAPE || this.keybindings.matches(data, "app.interrupt"))
			this.close();
	}

	override invalidate(): void {
		this.tui.requestRender();
	}

	private close() {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}
}

const DETAILS_ESCAPE = "\x1b";

// ---- 文案与样式 ----

function headingText(view: ActivityView, language: Language) {
	if (view.phase === "queued")
		return language === "en" ? "Review queued" : "审查排队中";
	if (view.phase === "needs_fix")
		return language === "en"
			? `Advisor · round ${view.round}`
			: `顾问仲裁 · 第 ${view.round} 轮`;
	if (view.phase === "awaiting_fix")
		return language === "en"
			? `Awaiting fix · round ${view.round}`
			: `等待修复 · 第 ${view.round} 轮`;
	return language === "en"
		? `Review · round ${view.round}`
		: `审查 · 第 ${view.round} 轮`;
}

function lockedText(language: Language) {
	return language === "en"
		? `Input paused during review · esc cancel · ${DETAILS_SHORTCUT} details`
		: `审查期间暂停输入 · esc 取消 · ${DETAILS_SHORTCUT} 详情`;
}

function detailsHintText(language: Language) {
	return language === "en" ? "esc close" : "esc 关闭";
}

function detailsEmptyText(language: Language) {
	return language === "en" ? "no tool calls yet" : "尚无工具调用";
}

function advisorText(language: Language) {
	return language === "en" ? "advisor" : "顾问";
}

function reviewerSummary(reviewer: ReviewerProgress, language: Language) {
	const calls = language === "en"
		? `${reviewer.toolCalls} calls`
		: `${reviewer.toolCalls} 次调用`;
	return `${reviewer.label} · ${reviewer.action} · ${calls}`;
}

function statusMark(status: ReviewerProgress["status"]) {
	if (status === "passed") return "✓";
	if (status === "failed") return "✗";
	if (status === "error") return "⚠";
	return "·";
}

function statusColor(status: ReviewerProgress["status"]) {
	if (status === "passed") return "success" as const;
	if (status === "failed") return "error" as const;
	if (status === "error") return "warning" as const;
	return "muted" as const;
}

function padLabel(text: string, width: number) {
	return text.length > width
		? `${text.slice(0, Math.max(1, width - 1))}…`
		: text.padEnd(width);
}

/** 按可见宽度补齐（忽略 ANSI 转义），保证边框右侧对齐。 */
function padVisible(text: string, width: number) {
	const visible = text.replace(/\x1b\[[0-9;]*m/gu, "").length;
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}
