/**
 * /fire-review 的活动 UI：编辑器上方的固定活动条与 esc 取消接管。
 *
 * 只读 executor 传入的快照函数，自身不持状态；动画由组件内部计时器驱动，
 * dispose 时清理。审查看不见就等于坏了，这一层是可用性的主体。
 */
import { basename } from "node:path";
import {
	CustomEditor,
	DynamicBorder,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { clip, formatDuration } from "../format.js";
import type { Language } from "../config.js";
import {
	FLAME_FRAME_COUNT,
	flameFrameLines,
	flameFrameWidth,
} from "../flame-frames.js";
import type { ProgressTool, ReviewerProgress } from "./progress.js";
import type { Phase } from "./state.js";

const WIDGET_KEY = "fire-review";
const FRAME_MS = 100;
const CLOCK_MS = 1_000;
const HEIGHT_RATIO = 0.7;
const DEFAULT_HEIGHT = 16;
const SHORT_MODEL_WIDTH = 7;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REVIEW_COLOR: readonly [number, number, number] = [255, 153, 102];
/** 火焰排版阈值：窄屏（48–59 列）收紧边距也要有火焰，<48 才退化为居中文本。 */
const FLAME_MIN_WIDTH = 48;
const FLAME_WIDE_WIDTH = 60;
const FLAME_MARGIN_MIN = 6;
const FLAME_MARGIN_NARROW = 2;
const FLAME_GAP_MIN = 8;
const FLAME_GAP_NARROW = 4;
const FLAME_GAP_IDEAL = 16;
let reviewTitleActive = false;

/** 活动条渲染所需的一切；executor 每次状态变化后重新提供。 */
export interface ActivityView {
	phase: Phase;
	round: number;
	startedAt: number;
	reviewers: readonly ReviewerProgress[];
	/** 当前 progress 属于谁：修复相据此判断能否把残留摘要当顾问裁决展示。 */
	progressKind?: "reviewers" | "advisor";
	consecutiveFailures?: number;
	language: Language;
}

type ViewSource = () => ActivityView | undefined;

export function showActivity(ctx: ExtensionContext, view: ViewSource): void {
	if (ctx.hasUI === false) return;
	if (typeof ctx.ui.setWorkingVisible === "function") ctx.ui.setWorkingVisible(false);
	setReviewTitle(ctx, view());
	if (typeof ctx.ui.setWidget !== "function") return;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: TUI, theme: Theme) =>
			new ActivityBar(view, theme, tui, () => tui.requestRender()),
		{ placement: "aboveEditor" },
	);
}

export function hideActivity(ctx: ExtensionContext): void {
	if (ctx.hasUI === false) return;
	if (typeof ctx.ui.setWorkingVisible === "function") ctx.ui.setWorkingVisible(true);
	restoreReviewTitle(ctx);
	if (typeof ctx.ui.setWidget === "function")
		ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * 审查等模型结论时（排队/审查中/顾问仲裁）接管编辑器：禁止输入，esc/Ctrl+C 随时取消。
 *
 * 不能用全局输入钩子比对裸 \x1b：终端开启增强键盘协议后 esc 是带修饰的序列，
 * 字面量比较会漏。这里统一走 keybindings 匹配。
 * awaiting_fix 相不接管——那时是执行模型在改代码，用户应能正常输入与中断。
 */
export function lockEditor(
	ctx: ExtensionContext,
	_view: ViewSource,
	cancel: () => void,
): void {
	if (ctx.hasUI === false || typeof ctx.ui.setEditorComponent !== "function") return;
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = new ReviewEditor(tui, theme, keybindings, cancel);
		return editor;
	});
}

export function unlockEditor(ctx: ExtensionContext): void {
	if (ctx.hasUI === false) return;
	if (typeof ctx.ui.setEditorComponent === "function")
		ctx.ui.setEditorComponent(undefined);
}

/**
 * 审查期间的只读编辑器。
 *
 * 动效由上方活动条负责，这里静态提示即可。
 */
class ReviewEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly cancel: () => void,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		if (
			this.keys.matches(data, "app.interrupt") ||
			this.keys.matches(data, "app.clear")
		) {
			this.cancel();
			return;
		}
		// 审查期间不接受任何其他输入：插话会污染本轮审查的会话证据。
	}

	override render(_width: number): string[] {
		// pi-flow 交互：审查期间输入区完全隐藏，不额外插入一行提示。
		return [];
	}
}

// ---- 组件 ----

class ActivityBar implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly border = new DynamicBorder(reviewColor);

	constructor(
		private readonly view: ViewSource,
		private readonly theme: Theme,
		private readonly tui: TUI,
		requestRender: () => void,
	) {
		this.timer = setInterval(() => {
			this.frame++;
			requestRender();
		}, view()?.phase === "summarizing" ? CLOCK_MS : FRAME_MS);
		this.timer.unref();
	}

	invalidate(): void {}
	dispose(): void { clearInterval(this.timer); }
	private spinner(): string { return SPINNER[this.frame % SPINNER.length]; }

	render(width: number): string[] {
		const view = this.view();
		if (!view || width <= 0) return [];
		const terminalRows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
		const maxTotalLines = terminalRows ? Math.floor(terminalRows * HEIGHT_RATIO) : DEFAULT_HEIGHT;
		if (maxTotalLines <= 0) return [];
		const title = centerLine(boldText(this.theme.fg("muted", activityHeading(view))), width);
		if (view.phase === "summarizing" || maxTotalLines === 1) return [title];
		if (maxTotalLines <= view.reviewers.length + 2) {
			return [title, ...compactActivityRows(view, width, maxTotalLines - 1)
				.map((line) => centerLine(line, width))];
		}
		const border = this.border.render(width)[0] ?? "";
		const maxBodyLines = maxTotalLines - 2;
		const content = this.contentRows(view, maxBodyLines);
		const body = width >= FLAME_MIN_WIDTH
			? this.renderFlameBody(content, width, maxBodyLines)
			: content.map((line) => centerLine(line, width));
		return [border, ...body.slice(0, maxBodyLines), border];
	}

	private contentRows(view: ActivityView, maxBodyLines: number): string[] {
		const title = boldText(this.theme.fg("muted", activityHeading(view)));
		const hintText = activityHint(view);
		const hint = hintText ? this.theme.fg("dim", hintText) : "";
		const reviewers = view.reviewers;
		const n = reviewers.length;

		// 中等/多行展开模式：只要行数足够容纳审查者多行展开
		if (maxBodyLines >= n * 2 + 1) {
			// 预留标题/提示/呼吸空行的开销后再分每人行预算。
			const budgetPer = Math.max(2, Math.floor((maxBodyLines - (hint ? 6 : 4)) / Math.max(1, n)));
			const details = activityRows(view, this.spinner(), maxBodyLines, budgetPer);
			return breathe(title, details, hint, maxBodyLines);
		}

		// 紧凑单行模式：标题 + 单行审查者；有余量时同样补呼吸空行。
		const details = activityRows(view, this.spinner(), maxBodyLines - 1, 1);
		return breathe(title, details, hint, maxBodyLines);
	}

	private renderFlameBody(contentRows: string[], width: number, maxBodyLines: number) {
		const wide = width >= FLAME_WIDE_WIDTH;
		const margin = wide ? FLAME_MARGIN_MIN : FLAME_MARGIN_NARROW;
		const gapMin = wide ? FLAME_GAP_MIN : FLAME_GAP_NARROW;
		const flameHeight = Math.min(maxBodyLines, Math.max(1, contentRows.length));
		const rawFlame = flameFrameLines(flameHeight, this.frame % FLAME_FRAME_COUNT);
		const flameWidth = flameFrameWidth(flameHeight);
		const contentWidth = Math.min(
			Math.max(1, ...contentRows.map((row) => visibleWidth(row))),
			Math.max(1, width - margin * 2 - gapMin - flameWidth),
		);
		const gap = Math.max(
			gapMin,
			Math.min(
				FLAME_GAP_IDEAL,
				width - margin * 2 - contentWidth - flameWidth,
			),
		);
		const group = contentWidth + gap + flameWidth;
		const indent = " ".repeat(
			Math.max(margin, Math.floor((width - group) / 2)),
		);
		const paddedRows = [...contentRows];
		while (paddedRows.length < flameHeight) paddedRows.push("");
		return rawFlame.map((line, index) => {
			const row = truncateToWidth(paddedRows[index] ?? "", contentWidth, "…");
			const padding = " ".repeat(
				Math.max(0, contentWidth - visibleWidth(row) + gap),
			);
			const flame = `${truncateToWidth(line, flameWidth, "")}\x1b[0m`;
			return `${indent}${row}${padding}${flame}`;
		});
	}
}

// ---- 文案与样式 ----

/**
 * 呼吸空行：预算内按优先级补回排版留白（标题后 > 提示前 > 顶部 > 底部），
 * 预算不够时逐个放弃、退回紧凑排列；超出部分由调用方的 slice 兑底。
 */
function breathe(title: string, details: string[], hint: string, maxBodyLines: number): string[] {
	const mandatory = 1 + details.length + (hint ? 1 : 0);
	let spare = maxBodyLines - mandatory;
	const afterTitle = spare > 0 && (spare -= 1) >= 0;
	const beforeHint = hint !== "" && spare > 0 && (spare -= 1) >= 0;
	const top = spare > 0 && (spare -= 1) >= 0;
	const bottom = spare > 0 && (spare -= 1) >= 0;
	return [
		...(top ? [""] : []),
		title,
		...(afterTitle ? [""] : []),
		...details,
		...(hint ? [...(beforeHint ? [""] : []), hint] : []),
		...(bottom ? [""] : []),
	].slice(0, maxBodyLines);
}

function activityHeading(view: ActivityView): string {
	const title = activityTitle(view);
	if (!view.startedAt) return title;
	const elapsed = formatDuration(Math.max(0, Date.now() - view.startedAt));
	return `${title} · ${view.language === "en" ? "total" : "总"} ${elapsed}`;
}

/** 矮屏先保阶段，再分配模型行；名称装不下时明确汇总状态，不静默丢人。 */
function compactActivityRows(view: ActivityView, width: number, budget: number): string[] {
	if (view.phase === "queued" || view.phase === "awaiting_fix" || !view.reviewers.length)
		return activityRows(view, "⠋", budget, 1).slice(0, budget);
	const perLine = Math.ceil(view.reviewers.length / budget);
	const lines: string[] = [];
	for (let index = 0; index < view.reviewers.length; index += perLine) {
		const group = view.reviewers.slice(index, index + perLine);
		if (perLine === 1) {
			const reviewer = group[0];
			const action = reviewer.details?.[0] || reviewer.summary || reviewer.action;
			lines.push(`${statusIcon(reviewer.status)} ${reviewer.label}: ${action.replace(/^[↳\s]+/u, "")}${elapsedSuffix(reviewer)}`);
			continue;
		}
		const names = group.map((reviewer) => shortModelName(reviewer.label)).join(" ");
		const statuses = group.map((reviewer) => `${statusIcon(reviewer.status)} ${shortModelName(reviewer.label)}`).join(" ");
		if (visibleWidth(statuses) <= width) lines.push(statuses);
		else if (visibleWidth(names) <= width) lines.push(names);
		else {
			const counts = new Map<ReviewerProgress["status"], number>();
			for (const reviewer of group) counts.set(reviewer.status, (counts.get(reviewer.status) ?? 0) + 1);
			lines.push([...counts].map(([status, count]) => `${statusIcon(status)}${count}`).join(" "));
		}
	}
	return lines;
}

function activityTitle(view: ActivityView) {
	const { language } = view;
	if (view.phase === "summarizing") return language === "en" ? "🔥 Summarizing" : "🔥 总结中";
	if (view.phase === "queued")
		return language === "en" ? "🔥 Running" : "🔥 执行中";
	if (view.phase === "needs_fix") {
		// 连败轮数并进标题：正文首行留给顾问模型行，与审查相的布局对齐。
		const failures = view.consecutiveFailures ?? 0;
		const base = language === "en" ? "🔥 Advisor consulting" : "🔥 顾问介入中";
		if (failures <= 0) return base;
		return language === "en"
			? `${base} · ${failures} straight fails`
			: `${base} · 连续 ${failures} 轮未过`;
	}
	const phase = view.phase === "awaiting_fix"
		? language === "en" ? "Repair in progress" : "修复中"
		: language === "en" ? "Review in progress" : "审查中";
	return `🔥 ${roundTitle(view.round, phase, language)}`;
}

function activityRows(view: ActivityView, spinner: string, budget = 16, budgetPer = 2): string[] {
	if (view.phase === "queued")
		return [view.language === "en" ? "Runs a review automatically when done" : "完成后自动审查"];
	if (view.phase === "awaiting_fix") {
		// 顾问落定与进入修复相在同一微任务链内，needs_fix 相没有渲染机会：
		// 裁决摘要在迁入相展示，才有可见时机。
		const advisorLine = view.progressKind === "advisor"
			? view.reviewers.find((reviewer) => reviewer.summary)?.summary
			: undefined;
		return [
			view.language === "en"
				? `Repairing Round ${view.round} review feedback`
				: `正在修复第 ${view.round} 轮审查反馈`,
			...(advisorLine ? [`💡 ${clip(advisorLine, 64)}`] : []),
		];
	}
	// 连败轮数已并入标题；正文首行即顾问模型行，与审查者行同格式。
	if (view.phase === "needs_fix")
		return view.reviewers.flatMap((reviewer) =>
			reviewerActivityRows(reviewer, spinner, view.language, 1, true, budgetPer),
		);
	const blocks = view.reviewers.map((reviewer) =>
		reviewerActivityRows(reviewer, spinner, view.language, view.reviewers.length, false, budgetPer),
	);
	// 模型之间空一行：只在预算容得下内容+分隔+标题提示时才加，紧屏不挤掉正文。
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	const spaced = blocks.length > 1 && budget >= total + blocks.length - 1 + 2;
	return blocks.flatMap((block, index) => (spaced && index > 0 ? ["", ...block] : block));
}

function reviewerActivityRows(
	reviewer: ReviewerProgress,
	spinner: string,
	language: Language,
	totalReviewers: number,
	isAdvisor = false,
	budgetPer = 2,
): string[] {
	const settled = reviewer.status !== "running";
	const multiline = totalReviewers <= 3 && budgetPer >= 2;
	const label = isAdvisor
		? `${language === "en" ? "Advisor" : "顾问"} ${reviewer.label}`
		: reviewer.label;

	const elapsed = elapsedSuffix(reviewer);
	if (settled) {
		const icon = statusIcon(reviewer.status);
		const details = reviewer.details && reviewer.details.length > 0
			? reviewer.details
			: [reviewer.summary || (reviewer.status === "passed" ? "审查通过" : "发现问题")];

		if (!multiline) {
			const text = details[0]?.replace(/^[↳\s]+/u, "") || "";
			return [`${icon} ${label} · ${clip(text, 48)}${elapsed}`];
		}

		const statusText = reviewer.status === "passed"
			? (language === "en" ? "Passed" : "通过")
			: reviewer.status === "failed"
				? (language === "en" ? "Failed" : "未通过")
				: (language === "en" ? "Error" : "异常");
		const firstDetail = details[0] ? ` · ${details[0]}` : ` · ${statusText}`;
		const lines = [`${icon} ${label}${firstDetail}${elapsed}`];
		for (const d of details.slice(1, budgetPer)) {
			const clean = d.replace(/^[↳\s]+/u, "").trim();
			if (clean) lines.push(`  ↳ ${clip(clean, 54)}`);
		}
		return lines;
	}

	if (reviewer.toolCalls === 0) {
		return [`${spinner} ${label} · ${language === "en" ? "Thinking" : "思考中"}${elapsed}`];
	}

	if (!multiline) {
		return [`${spinner} ${label} · ${reviewer.action} · ${callsText(reviewer.toolCalls, language)}${elapsed}`];
	}

	// 动作按时间顺序滚动（旧在上新在下），不标「当前/历史」。
	const lines = [`${spinner} ${label} · ${callsText(reviewer.toolCalls, language)}${elapsed}`];
	const prev = reviewer.recentTools?.at(-1);
	if (prev) lines.push(`  ↳ ${clip(formatTool(prev, language), 50)}`);
	lines.push(`  ↳ ${clip(reviewer.action, 50)}`);
	return lines;
}

function formatTool(tool: ProgressTool, language: Language): string {
	const verb = language === "en" ? tool.tool : tool.tool === "read" ? "读" : tool.tool === "bash" ? "跑" : tool.tool === "edit" ? "改" : tool.tool === "write" ? "写" : tool.tool;
	const target = tool.args.split("/").pop() || tool.args;
	return `${verb} ${target}`;
}

/** 每模型耗时后缀的唯一出口：运行中走表、落定冻结；所有携带每模型内容的行都拼它。 */
function elapsedSuffix(reviewer: ReviewerProgress): string {
	if (!reviewer.startedAt) return "";
	const elapsedMs = Math.max(0, (reviewer.settledAt ?? Date.now()) - reviewer.startedAt);
	return elapsedMs > 0 ? ` · ${formatDuration(elapsedMs)}` : "";
}

/** 审查者状态图标的唯一映射；运行中的动态 spinner 由调用方另行处理。 */
function statusIcon(status: ReviewerProgress["status"]): string {
	if (status === "passed") return "✅";
	if (status === "failed") return "❌";
	if (status === "error") return "⚠️";
	return "⠋";
}

function shortModelName(label: string): string {
	const name = label.replace(/^(?:claude-|(?:gpt|gemini)-\d+(?:\.\d+)*-)/u, "");
	return clip(name, SHORT_MODEL_WIDTH);
}

function activityHint(view: ActivityView) {
	if (view.phase === "awaiting_fix") return undefined;
	if (view.phase === "queued")
		return view.language === "en"
			? "Esc/Ctrl+C cancel automatic review"
			: "Esc/Ctrl+C 取消自动审查";
	if (view.phase === "needs_fix")
		return view.language === "en"
			? "Esc/Ctrl+C skip consult"
			: "Esc/Ctrl+C 跳过咨询";
	return view.language === "en"
		? "Esc/Ctrl+C cancel"
		: "Esc/Ctrl+C 取消";
}

function roundTitle(round: number, title: string, language: Language) {
	if (round <= 1) return title;
	return language === "en" ? `Round ${round} ${title}` : `第 ${round} 轮${title}`;
}

function callsText(calls: number, language: Language) {
	return language === "en" ? `${calls} calls` : `${calls} 次调用`;
}

function centerLine(line: string, width: number) {
	if (width <= 0) return "";
	const text = truncateToWidth(line, width, "…");
	const padding = Math.max(0, width - visibleWidth(text));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
}

function boldText(text: string) {
	return `\x1b[1m${text}\x1b[22m`;
}

function reviewColor(text: string) {
	const [red, green, blue] = REVIEW_COLOR;
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function setReviewTitle(ctx: ExtensionContext, view: ActivityView | undefined) {
	if (!view || !ctx.hasUI || typeof ctx.ui.setTitle !== "function") return;
	const manager = ctx.sessionManager as {
		getSessionName?: () => unknown;
		getCwd?: () => unknown;
	};
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
	const manager = ctx.sessionManager as {
		getSessionName?: () => unknown;
		getCwd?: () => unknown;
	};
	const rawName = manager.getSessionName?.();
	const rawCwd = manager.getCwd?.();
	const name = typeof rawName === "string" && rawName ? rawName : undefined;
	const dir = typeof rawCwd === "string" ? basename(rawCwd) : "";
	ctx.ui.setTitle(name ? `π - ${name} - ${dir}` : `π - ${dir}`);
}
