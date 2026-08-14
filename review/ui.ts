/**
 * /fire-review 的活动 UI：编辑器上方的固定活动条、alt+s 详情窗、esc 取消接管。
 *
 * 只读 executor 传入的快照函数，自身不持状态；动画由组件内部计时器驱动，
 * dispose 时清理。审查看不见就等于坏了，这一层是可用性的主体。
 */
import { basename } from "node:path";
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
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { clip } from "../format.js";
import type { Language } from "../config.js";
import {
	FLAME_FRAME_COUNT,
	flameFrameLines,
	flameFrameWidth,
} from "./flame-frames.js";
import type { ProgressTool, ReviewerProgress } from "./progress.js";
import type { Phase } from "./state.js";

export const DETAILS_SHORTCUT = "alt+s";
const WIDGET_KEY = "fire-review";
const FRAME_MS = 100;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REVIEW_COLOR: readonly [number, number, number] = [255, 153, 102];
const FLAME_MARGIN_MIN = 6;
const FLAME_GAP_MIN = 8;
const FLAME_GAP_IDEAL = 16;
const MONITOR_SHORTCUT_ESCAPES = new Set(["\u001bs", "\u001bS"]);
const MONITOR_SHORTCUT_COMPOSED = new Set(["ß", "Í"]);
/** 详情窗打开期间屏蔽全局 esc：否则一次 esc 会同时关窗并取消审查。 */
let detailsOpen = false;
let reviewTitleActive = false;

/** 活动条渲染所需的一切；executor 每次状态变化后重新提供。 */
export interface ActivityView {
	phase: Phase;
	round: number;
	focus: string;
	roundStartedAt: number;
	progressStartedAt?: number;
	reviewers: readonly ReviewerProgress[];
	advisorRunning: boolean;
	consecutiveFailures?: number;
	cwd?: string;
	language: Language;
}

type ViewSource = () => ActivityView | undefined;

export function showActivity(ctx: ExtensionContext, view: ViewSource): void {
	if (typeof ctx.ui.setWorkingVisible === "function") ctx.ui.setWorkingVisible(false);
	setReviewTitle(ctx, view());
	if (typeof ctx.ui.setWidget !== "function") return;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: TUI, theme: Theme) =>
			new ActivityBar(view, theme, () => tui.requestRender()),
		{ placement: "aboveEditor" },
	);
}

export function hideActivity(ctx: ExtensionContext): void {
	if (typeof ctx.ui.setWorkingVisible === "function") ctx.ui.setWorkingVisible(true);
	restoreReviewTitle(ctx);
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
		if (matchesDetailsShortcut(data)) {
			this.details();
			return;
		}
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
		// pi-flow 交互：质检期间输入区完全隐藏，不额外插入一行提示。
		return [];
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
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } },
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
		const safeWidth = Math.max(1, width);
		const border = reviewColor("─".repeat(safeWidth));
		const content = this.contentRows(view);
		const body = safeWidth >= 60
			? this.renderFlameBody(content, safeWidth)
			: content.map((line) => centerLine(line, safeWidth));
		return [border, ...body, border];
	}

	private contentRows(view: ActivityView): string[] {
		const rows = ["", boldText(this.theme.fg("muted", activityTitle(view)))];
		const details = activityRows(view, this.spinner());
		if (details.length > 0) rows.push("", ...details.map((row) => this.theme.fg("muted", row)));
		const hint = activityHint(view);
		if (hint) rows.push("", this.theme.fg("dim", hint));
		rows.push("");
		return rows;
	}

	private renderFlameBody(contentRows: string[], width: number) {
		const flameHeight = Math.max(4, contentRows.length);
		const rawFlame = flameFrameLines(flameHeight, this.frame % FLAME_FRAME_COUNT);
		const flameWidth = flameFrameWidth(flameHeight);
		const contentWidth = Math.min(
			Math.max(1, ...contentRows.map((row) => visibleWidth(row))),
			Math.max(1, width - FLAME_MARGIN_MIN * 2 - FLAME_GAP_MIN - flameWidth),
		);
		const gap = Math.max(
			FLAME_GAP_MIN,
			Math.min(
				FLAME_GAP_IDEAL,
				width - FLAME_MARGIN_MIN * 2 - contentWidth - flameWidth,
			),
		);
		const group = contentWidth + gap + flameWidth;
		const indent = " ".repeat(
			Math.max(FLAME_MARGIN_MIN, Math.floor((width - group) / 2)),
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

class DetailsOverlay extends Animated {
	private closed = false;
	private readonly scopePhase: Phase | undefined;

	constructor(
		private readonly view: ViewSource,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {
		super(() => tui.requestRender());
		this.scopePhase = view()?.phase;
	}

	render(width: number): string[] {
		const view = this.view();
		if (view && view.phase !== this.scopePhase) {
			queueMicrotask(() => this.close());
			return [];
		}
		const safeWidth = Math.max(4, width);
		const inner = safeWidth - 2;
		const language = view?.language ?? "zh";
		const lines = [this.border("╭", "╮", inner)];
		if (!view) {
			queueMicrotask(() => this.close());
			return [];
		} else {
			lines.push(
				this.row(
					alignRight(
						this.theme.fg("toolTitle", monitorTitle(view)),
						this.theme.fg("dim", `⏱ ${monitorElapsed((view.progressStartedAt ?? view.roundStartedAt) ? Date.now() - (view.progressStartedAt ?? view.roundStartedAt) : 0)}`),
						inner,
					),
					inner,
				),
				this.border("├", "┤", inner),
			);
			const terminal = (this.tui as TUI & { terminal?: { columns?: number; rows?: number } }).terminal;
			const compact = (terminal?.columns ?? safeWidth) < 70;
			let packed = false;
			let agentRows = view.reviewers.map((reviewer) =>
				monitorAgentRows(
					reviewer,
					this.spinner(),
					inner,
					language,
					compact,
					this.theme,
					view.cwd ?? "",
					view.phase === "needs_fix" ? "A" : "M",
				),
			);
			const limit = terminal?.rows ? Math.max(1, Math.floor(terminal.rows * 0.7) - 4) : Infinity;
			const rowCount = () =>
				agentRows.reduce((sum, rows) => sum + rows.length, 0) +
				(compact ? 0 : Math.max(0, agentRows.length - 1));
			while (rowCount() > limit) {
				const rows = agentRows.find((candidate) => candidate.length > 2);
				if (!rows) break;
				rows.pop();
			}
			if (rowCount() > limit) {
				const compactLines = view.reviewers.map((reviewer) =>
					monitorAgentRows(
						reviewer,
						this.spinner(),
						inner,
						language,
						true,
						this.theme,
						view.cwd ?? "",
						view.phase === "needs_fix" ? "A" : "M",
					)[0] ?? "",
				);
				agentRows = compactLines.length > limit
					? packMonitorLines(compactLines, limit, inner)
					: compactLines.map((line) => [line]);
				packed = true;
			}
			for (const [index, rows] of agentRows.entries()) {
				if (index > 0 && !compact && !packed) lines.push(this.row("", inner));
				for (const line of rows) lines.push(this.row(line, inner));
			}
		}
		lines.push(
			this.row(centerLine(this.theme.fg("dim", detailsHintText(language)), inner), inner),
			this.border("╰", "╯", inner),
		);
		return lines;
	}

	private border(left: string, right: string, inner: number) {
		return this.theme.fg("border", `${left}${"─".repeat(inner)}${right}`);
	}

	private row(content: string, inner: number) {
		const clipped = truncateToWidth(content, inner, "…");
		return `${this.theme.fg("border", "│")}${padVisible(clipped, inner)}${this.theme.fg("border", "│")}`;
	}

	handleInput(data: string): void {
		// 与 pi-flow monitor 一致：Alt+S 或 Esc 关闭。
		if (matchesDetailsShortcut(data) || this.keybindings.matches(data, "app.interrupt"))
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

// ---- 文案与样式 ----

function monitorTitle(view: ActivityView) {
	if (view.phase === "needs_fix")
		return view.language === "en" ? "Advisor consultation" : "顾问咨询";
	return roundTitle(view.round, view.language === "en" ? "Quality check" : "质检", view.language);
}

function monitorElapsed(milliseconds: number) {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function monitorAgentRows(
	reviewer: ReviewerProgress,
	spinner: string,
	width: number,
	language: Language,
	compact: boolean,
	theme: Theme,
	cwd: string,
	keyPrefix: "M" | "A",
) {
	const current = reviewer.activeTools.at(-1);
	const status = theme.fg(statusColor(reviewer.status), monitorGlyph(reviewer, spinner));
	const key = theme.fg("accent", `${keyPrefix}${reviewer.index + 1}`);
	const identity = `${status} ${key} ${theme.fg("text", reviewer.label)}`;
	const baseMetrics = `${reviewer.toolCalls} calls · ${(reviewer.tokens / 1000).toFixed(1)}k tok`;
	if (compact) {
		const value = current
			? `${toolLabel(current.tool, language)} ${displayToolArgs(current, cwd)}`.trim()
			: reviewer.status === "running"
				? (language === "en" ? "Thinking" : "思考中")
				: reviewer.label;
		const duration = current ? toolDuration(Date.now() - current.startedAt) : "";
		const metrics = `${baseMetrics}${duration ? ` · ${duration}` : ""}`;
		return [alignMonitorMetrics(`${status} ${key} ${value}`, metrics, width)];
	}
	const rows = [alignMonitorMetrics(identity, baseMetrics, width)];
	if (current) rows.push(monitorToolLine(current, language, true, width, cwd));
	else if (reviewer.status === "running")
		rows.push(`▏ ${spinner} ${language === "en" ? "Thinking" : "思考中"}`);
	for (const tool of [...reviewer.recentTools].reverse())
		rows.push(monitorToolLine(tool, language, false, width, cwd));
	return rows;
}

function packMonitorLines(lines: string[], limit: number, width: number): string[][] {
	const columns = Math.ceil(lines.length / limit);
	const separator = " │ ";
	const columnWidth = Math.max(1, Math.floor((width - (columns - 1) * visibleWidth(separator)) / columns));
	const rows: string[][] = [];
	for (let offset = 0; offset < lines.length; offset += columns) {
		const cells = lines.slice(offset, offset + columns).map((line) => {
			const clipped = truncateToWidth(line, columnWidth, "…");
			return padVisible(clipped, columnWidth);
		});
		rows.push([cells.join(separator)]);
	}
	return rows;
}

function alignMonitorMetrics(left: string, metrics: string, width: number) {
	const metricsWidth = visibleWidth(metrics);
	if (metricsWidth >= width) return truncateToWidth(metrics, width, "…");
	const clipped = truncateToWidth(left, width - metricsWidth - 1, "…");
	return `${clipped}${" ".repeat(Math.max(1, width - visibleWidth(clipped) - metricsWidth))}${metrics}`;
}

function monitorToolLine(
	tool: ProgressTool,
	language: Language,
	current: boolean,
	width: number,
	cwd: string,
) {
	const duration = toolDuration((tool.endedAt ?? Date.now()) - tool.startedAt);
	const marker = tool.isError ? "✗" : current ? "●" : " ";
	const left = `▏ ${marker} ${toolLabel(tool.tool, language)} ${displayToolArgs(tool, cwd)}`.trimEnd();
	return duration ? alignMonitorMetrics(left, duration, width) : left;
}

function displayToolArgs(tool: ProgressTool, cwd: string) {
	const home = process.env.HOME ?? "";
	if (tool.tool === "bash") {
		const command = home ? tool.args.replaceAll(home, "~") : tool.args;
		return `$ ${command || "…"}`;
	}
	if (!["read", "edit", "write"].includes(tool.tool)) return tool.args || "…";
	if (cwd && tool.args.startsWith(`${cwd}/`)) return `./${tool.args.slice(cwd.length + 1)}`;
	return home && tool.args.startsWith(`${home}/`) ? `~/${tool.args.slice(home.length + 1)}` : tool.args;
}

function toolLabel(tool: string, language: Language) {
	if (language === "en") return tool;
	if (tool === "read") return "读取";
	if (tool === "bash") return "操作";
	if (tool === "edit") return "修改";
	if (tool === "write") return "写入";
	return tool;
}

function toolDuration(milliseconds: number) {
	if (milliseconds < 1000) return "";
	if (milliseconds < 10_000)
		return `${(Math.floor(milliseconds / 100) / 10).toFixed(1)}s`;
	const seconds = Math.floor(milliseconds / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function activityTitle(view: ActivityView) {
	const { language } = view;
	if (view.phase === "queued")
		return language === "en" ? "💯 Running" : "💯 执行中";
	if (view.phase === "needs_fix")
		return language === "en" ? "🧭 Advisor consulting" : "🧭 顾问介入中";
	const phase = view.phase === "awaiting_fix"
		? language === "en" ? "Quality fix in progress" : "优化中"
		: language === "en" ? "Quality check in progress" : "质检中";
	return `💯 ${roundTitle(view.round, phase, language)}`;
}

function activityRows(view: ActivityView, spinner: string): string[] {
	if (view.phase === "queued")
		return [view.language === "en" ? "Runs quality checks automatically when done" : "完成后自动质检"];
	if (view.phase === "awaiting_fix")
		return [
			view.language === "en"
				? `Repairing Round ${view.round} quality feedback`
				: `正在修复第 ${view.round} 轮质检反馈`,
		];
	if (view.phase === "needs_fix")
		return [
			view.language === "en"
				? `Quality checks failed ${view.consecutiveFailures ?? 0} rounds in a row`
				: `质检已连续 ${view.consecutiveFailures ?? 0} 轮未通过`,
		];
	return view.reviewers.map((reviewer) => reviewerActivityLine(reviewer, spinner, view.language));
}

function reviewerActivityLine(
	reviewer: ReviewerProgress,
	spinner: string,
	language: Language,
) {
	if (reviewer.status === "passed") return `✅ ${reviewer.label}`;
	if (reviewer.status === "failed") return `❌ ${reviewer.label}`;
	if (reviewer.status === "error") return `⚠️ ${reviewer.label}`;
	if (reviewer.toolCalls === 0) return reviewer.label;
	return `${spinner} ${reviewer.label} · ${reviewer.action} · ${callsText(reviewer.toolCalls, language)}`;
}

function activityHint(view: ActivityView) {
	if (view.phase === "awaiting_fix") return undefined;
	if (view.phase === "queued")
		return view.language === "en"
			? "Esc/Ctrl+C cancel automatic quality check"
			: "Esc/Ctrl+C 取消自动质检";
	if (view.phase === "needs_fix")
		return view.language === "en"
			? "Esc/Ctrl+C skip consult · Alt+S details"
			: "Esc/Ctrl+C 跳过咨询 · Alt+S 详情";
	return view.language === "en"
		? "Esc/Ctrl+C cancel · Alt+S details"
		: "Esc/Ctrl+C 取消 · Alt+S 详情";
}

function roundTitle(round: number, title: string, language: Language) {
	if (round <= 1) return title;
	return language === "en" ? `Round ${round} ${title}` : `第 ${round} 轮${title}`;
}

function detailsHintText(language: Language) {
	return language === "en" ? "Alt+S close · Esc also works" : "Alt+S 关闭 · Esc 也可";
}

function callsText(calls: number, language: Language) {
	return language === "en" ? `${calls} calls` : `${calls} 次调用`;
}

function monitorGlyph(reviewer: ReviewerProgress, spinner: string) {
	if (reviewer.status === "passed") return "✓";
	if (reviewer.status === "failed" || reviewer.status === "error") return "✗";
	return reviewer.toolCalls > 0 ? "●" : spinner;
}

function statusColor(status: ReviewerProgress["status"]) {
	if (status === "passed") return "success" as const;
	if (status === "failed" || status === "error") return "error" as const;
	return "accent" as const;
}

function matchesDetailsShortcut(data: string) {
	return (
		matchesKey(data, DETAILS_SHORTCUT) ||
		MONITOR_SHORTCUT_ESCAPES.has(data) ||
		MONITOR_SHORTCUT_COMPOSED.has(data)
	);
}

function centerLine(line: string, width: number) {
	if (width <= 0) return "";
	const text = truncateToWidth(line, width, "…");
	const padding = Math.max(0, width - visibleWidth(text));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
}

function alignRight(left: string, right: string, width: number) {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
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
	const label = view.language === "en" ? "Reviewing" : "质检中";
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

/** 按终端可见宽度补齐，CJK、emoji 与 ANSI 都由 TUI 的事实源处理。 */
function padVisible(text: string, width: number) {
	const visible = visibleWidth(text);
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}
