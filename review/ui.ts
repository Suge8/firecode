/**
 * /fire-review 的活动 UI：编辑器上方的单行审查活动与 esc 取消接管。
 *
 * 只读 executor 传入的快照函数，自身不持状态；动效经 flame.ts 的全局时钟，
 * dispose 时退订。Working 指示的可见性归输入框外壳（statusbar）统一管理，这里不碰。
 */
import { basename } from "node:path";
import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type EditorComponent, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type ActivityRow, renderActivityRow } from "../activity.js";
import type { Language } from "../config.js";
import { onFrame, phaseOf, reviewMark } from "../flame.js";
import { formatDuration } from "../format.js";
import type { ReviewActivity } from "./activity-channel.js";
import type { ReviewerProgress } from "./progress.js";
import type { Phase } from "./state.js";

const WIDGET_KEY = "fire-review";
let reviewTitleActive = false;

/** 活动行渲染所需的一切；executor 每次状态变化后重新提供。 */
export interface ActivityView {
	phase: Phase;
	round: number;
	startedAt: number;
	reviewers: readonly ReviewerProgress[];
	/** 当前 progress 属于谁：顾问与修复相的 progress 不是审查者票数。 */
	progressKind?: "reviewers" | "advisor";
	consecutiveFailures?: number;
	language: Language;
}

type ViewSource = () => ActivityView | undefined;

const WORDS = {
	zh: {
		name: "本轮改动", role: "审查", round: (n: number) => `第 ${n} 轮`, queued: "完成后自动审查",
		passed: (k: number, n: number) => `${k}/${n} 位审查者通过`, blocked: (m: number) => `，${m} 位阻断`,
		advisor: (fails: number) => (fails > 0 ? `顾问介入中 · 连续 ${fails} 轮未过` : "顾问介入中"),
		fixing: "修复中", summarizing: "总结中",
	},
	en: {
		name: "This change", role: "Review", round: (n: number) => `Round ${n}`, queued: "Runs after the turn",
		passed: (k: number, n: number) => `${k}/${n} reviewers passed`, blocked: (m: number) => `, ${m} blocking`,
		advisor: (fails: number) => (fails > 0 ? `Advisor consulting · ${fails} straight fails` : "Advisor consulting"),
		fixing: "Repairing", summarizing: "Summarizing",
	},
} as const;

const countStatus = (view: ActivityView, status: ReviewerProgress["status"]) =>
	view.reviewers.filter((reviewer) => reviewer.status === status).length;

/** 输入框外壳要显示的审查进度：只有审查相的票数可数。 */
export function reviewActivity(view: ActivityView): ReviewActivity {
	const counts = view.phase === "reviewing" ? `${countStatus(view, "passed")}/${view.reviewers.length}` : "";
	return { counts };
}

function activityRow(view: ActivityView): ActivityRow {
	const words = WORDS[view.language];
	const blocked = view.phase === "reviewing" ? countStatus(view, "failed") : 0;
	const round = words.round(view.round);
	const action = {
		queued: words.queued,
		reviewing: `${round} · ${words.passed(countStatus(view, "passed"), view.reviewers.length)}${blocked ? words.blocked(blocked) : ""}`,
		needs_fix: `${round} · ${words.advisor(view.consecutiveFailures ?? 0)}`,
		awaiting_fix: `${round} · ${words.fixing}`,
		summarizing: words.summarizing,
	}[view.phase as "queued"] ?? round;
	return {
		mark: reviewMark(phaseOf(0)),
		name: words.name,
		role: words.role,
		action,
		tone: blocked ? "failed" : "review",
		elapsed: view.startedAt ? formatDuration(Math.max(0, Date.now() - view.startedAt)) : "",
	};
}

class ActivityLine implements Component {
	private readonly stop: () => void;

	constructor(
		private readonly view: ViewSource,
		private readonly theme: Theme,
		requestRender: () => void,
	) {
		this.stop = onFrame(requestRender);
	}

	invalidate(): void {}
	dispose(): void { this.stop(); }

	render(width: number): string[] {
		const view = this.view();
		if (!view || width <= 0) return [];
		const row = activityRow(view);
		return [renderActivityRow(row, width, visibleWidth(row.name), this.theme)];
	}
}

export function showActivity(ctx: ExtensionContext, view: ViewSource): void {
	if (ctx.hasUI === false) return;
	setReviewTitle(ctx, view());
	if (typeof ctx.ui.setWidget !== "function") return;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: TUI, theme: Theme) => new ActivityLine(view, theme, () => tui.requestRender()),
		{ placement: "aboveEditor" },
	);
}

export function hideActivity(ctx: ExtensionContext): void {
	if (ctx.hasUI === false) return;
	restoreReviewTitle(ctx);
	if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * 审查等模型结论时（排队/审查中/顾问仲裁）接管编辑器：禁止输入，esc/Ctrl+C 随时取消。
 * 返回解锁函数，还原成锁定前的编辑器工厂（可能是别的扩展设置的自定义编辑器）。
 *
 * 不能用全局输入钩子比对裸 \x1b：终端开启增强键盘协议后 esc 是带修饰的序列，
 * 字面量比较会漏。这里统一走 keybindings 匹配。
 * awaiting_fix 相不接管——那时是执行模型在改代码，用户应能正常输入与中断。
 */
export function lockEditor(ctx: ExtensionContext, cancel: () => void): () => void {
	if (ctx.hasUI === false || typeof ctx.ui.setEditorComponent !== "function") return () => {};
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const frame = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		return new ReviewEditor(tui, theme, keybindings, cancel, frame);
	});
	return () => ctx.ui.setEditorComponent(previous);
}

/**
 * 审查期间的只读编辑器：输入区收起，只画 frame（锁定前的编辑器）的上下边框，
 * 外壳状态（审查进度、会话标题、模型）因此保持可见。
 */
class ReviewEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly cancel: () => void,
		private readonly frame: EditorComponent,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		if (this.keys.matches(data, "app.interrupt") || this.keys.matches(data, "app.clear")) this.cancel();
		// 审查期间不接受任何其他输入：插话会污染本轮审查的会话证据。
	}

	override render(width: number): string[] {
		const lines = this.frame.render(width);
		return lines.length > 1 ? [lines[0], lines[lines.length - 1]] : lines;
	}
}

function setReviewTitle(ctx: ExtensionContext, view: ActivityView | undefined) {
	if (!view || !ctx.hasUI || typeof ctx.ui.setTitle !== "function") return;
	const manager = ctx.sessionManager as { getSessionName?: () => unknown; getCwd?: () => unknown };
	const rawName = manager.getSessionName?.();
	const rawCwd = manager.getCwd?.();
	const who = typeof rawName === "string" && rawName
		? rawName
		: typeof rawCwd === "string" ? basename(rawCwd) : "";
	const label = view.language === "en" ? "Reviewing" : "审查中";
	reviewTitleActive = true;
	ctx.ui.setTitle(`${label}${view.round > 0 ? ` R${view.round}` : ""}${who ? ` · ${who}` : ""}`);
}

function restoreReviewTitle(ctx: ExtensionContext) {
	if (!reviewTitleActive || !ctx.hasUI || typeof ctx.ui.setTitle !== "function") return;
	reviewTitleActive = false;
	const manager = ctx.sessionManager as { getSessionName?: () => unknown; getCwd?: () => unknown };
	const rawName = manager.getSessionName?.();
	const rawCwd = manager.getCwd?.();
	const name = typeof rawName === "string" && rawName ? rawName : undefined;
	const dir = typeof rawCwd === "string" ? basename(rawCwd) : "";
	ctx.ui.setTitle(name ? `π - ${name} - ${dir}` : `π - ${dir}`);
}
