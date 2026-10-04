/**
 * 输入框外壳：状态画进编辑器的上下边框，不再有独立底栏。
 * 上边框：回合火苗与计时、主会话审查进度 | 观察员、指挥官；下边框：会话标题 | 模型、上下文。
 */
import { stripVTControlCharacters } from "node:util";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type MessageStartEvent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { HEAT_COLORS, flame, onFrame, paint, phaseOf, reviewMark, settleMark, settling } from "../flame.js";
import { formatDuration, formatModelName, formatTokens, oneLine } from "../format.js";
import { contextColor, thinkingColor } from "../theme.js";
import { type BottomParts, type TopParts, bottomBorder, topBorder } from "./render.js";

const TITLE_CHARACTERS = 6;
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cleanTitle = (text: string) => oneLine(stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " "));

function userTitle(message: MessageStartEvent["message"]): string | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	const text = cleanTitle(typeof content === "string" ? content : content
		.filter((block) => block.type === "text").map((block) => block.text).join(" "));
	if (!text) return undefined;
	let title = "";
	let count = 0;
	for (const { segment } of characters.segment(text)) {
		if (count++ === TITLE_CHARACTERS) return `${title}…`;
		title += segment;
	}
	return title;
}

function displayTitle(ctx: ExtensionContext, incoming?: MessageStartEvent["message"]): string {
	const name = ctx.sessionManager.getSessionName();
	if (name) return cleanTitle(name);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const title = userTitle(entry.message);
		if (title) return title;
	}
	return (incoming && userTitle(incoming)) || "新会话";
}

/** review 发布的占用频道：外壳借它显示审查进度，不另开频道。 */
const REVIEW_OCCUPANCY_CHANNEL = "herdr:blocked";
const FAST_STATUS = "pi-openai-native-fast";
/** 回合结束后落定标记与暖光的保留时长。 */
const SETTLE_SHOW_MS = 1_000;

type Turn = { startedAt: number } | { endedAt: number; elapsed: number; failed: boolean };

/** 外壳要展示的全部运行状态；事件写入，编辑器每次绘制只读。 */
class Shell {
	title = "新会话";
	turn: Turn | undefined;
	/** 审查占用期间的进度访问器（review 经占用频道发布）；undefined 表示没有审查。 */
	review: (() => string) | undefined;
	statuses: () => ReadonlyMap<string, string> = () => new Map();
	theme: Theme | undefined;
	requestRender = () => {};
	private stopClock: (() => void) | undefined;

	/** 时钟只在有动效要播时订阅：回合进行、落定过渡或审查进行。 */
	syncClock(): void {
		if (this.settledExpired()) this.turn = undefined;
		const need = this.review !== undefined || this.turn !== undefined;
		if (need && !this.stopClock) this.stopClock = onFrame(() => { this.syncClock(); this.requestRender(); });
		if (!need && this.stopClock) { this.stopClock(); this.stopClock = undefined; }
	}

	dispose(): void {
		this.stopClock?.();
		this.stopClock = undefined;
		this.requestRender = () => {};
	}

	private settledExpired(): boolean {
		return this.turn !== undefined && "endedAt" in this.turn && Date.now() - this.turn.endedAt >= SETTLE_SHOW_MS;
	}

	top(): TopParts {
		const turn = this.turn;
		const review = this.review;
		const status = (key: string) => this.statuses().get(key) ?? "";
		const parts: TopParts = {
			mark: "", word: "", elapsed: "", review: "", reviewShort: "", glow: 0,
			watcher: status("watcher"), master: status("master"),
		};
		if (turn && "startedAt" in turn) {
			parts.mark = flame(3, phaseOf(0));
			parts.word = this.theme?.fg("text", "处理中") ?? "";
			parts.elapsed = this.theme?.fg("muted", formatDuration(Date.now() - turn.startedAt)) ?? "";
			parts.glow = 1;
		} else if (turn) {
			const since = Date.now() - turn.endedAt;
			parts.mark = settling(since) ? settleMark(turn.failed ? "failed" : "done", since) : "";
			parts.elapsed = this.theme?.fg("muted", formatDuration(turn.elapsed)) ?? "";
			parts.glow = Math.max(0, 1 - since / SETTLE_SHOW_MS);
		}
		if (review) {
			const counts = review();
			parts.review = `${reviewMark(phaseOf(2))} ${paint(HEAT_COLORS.gold, `审查${counts ? ` ${counts}` : ""}`)}`;
			parts.reviewShort = `${reviewMark(phaseOf(2))}${counts ? ` ${paint(HEAT_COLORS.gold, counts)}` : ""}`;
		}
		return parts;
	}

	bottom(ctx: ExtensionContext, thinking: string): BottomParts {
		const theme = this.theme;
		const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme?.fg(color, text) ?? text;
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
		const percent = usage?.percent;
		return {
			title: fg("muted", this.title),
			model: fg("text", formatModelName(model?.id)),
			think: model?.reasoning ? fg(thinkingColor(thinking as never), `/${thinking}`) : "",
			fast: this.statuses().has(FAST_STATUS) ? fg("warning", "Fast") : "",
			percent: fg(contextColor(percent), percent == null ? "?" : `${percent.toFixed(1)}%`),
			capacity: fg("dim", `/${formatTokens(window)}`),
		};
	}
}

class ShellEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly shell: Shell,
		private readonly bottomParts: () => BottomParts,
	) {
		super(tui, theme, keybindings);
		shell.requestRender = () => tui.requestRender();
	}

	// 输入过长滚动时让位给宿主的“↑ n more”提示。
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return hiddenLineCount > 0
			? super.renderTopBorder(width, hiddenLineCount)
			: topBorder(width, this.shell.top(), this.borderColor);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		return hiddenLineCount > 0
			? super.renderBottomBorder(width, hiddenLineCount)
			: bottomBorder(width, this.bottomParts(), this.borderColor);
	}
}

function lastFailed(messages: readonly { role: string; stopReason?: string }[]): boolean {
	return messages.findLast((message) => message.role === "assistant")?.stopReason === "error";
}

export function registerStatusBar(pi: ExtensionAPI, subsession = false): void {
	if (subsession) return;
	const shell = new Shell();
	const updateTitle = (ctx: ExtensionContext, incoming?: MessageStartEvent["message"]) => {
		shell.title = displayTitle(ctx, incoming);
		shell.requestRender();
	};
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") updateTitle(ctx, event.message);
	});
	pi.on("session_info_changed", (_event, ctx) => updateTitle(ctx));
	pi.on("session_tree", (_event, ctx) => updateTitle(ctx));
	pi.on("agent_start", () => {
		shell.turn = { startedAt: Date.now() };
		shell.syncClock();
		shell.requestRender();
	});
	pi.on("agent_end", (event) => {
		if (!shell.turn || !("startedAt" in shell.turn)) return;
		const endedAt = Date.now();
		shell.turn = { endedAt, elapsed: endedAt - shell.turn.startedAt, failed: lastFailed(event.messages) };
		shell.syncClock();
		shell.requestRender();
	});
	pi.events.on(REVIEW_OCCUPANCY_CHANNEL, (data) => {
		const occupancy = data as { active?: boolean; progress?: () => string } | undefined;
		shell.review = occupancy?.active ? (occupancy.progress ?? (() => "")) : undefined;
		shell.syncClock();
		shell.requestRender();
	});
	pi.on("session_start", (_event, ctx) => {
		updateTitle(ctx);
		// 宿主内嵌的 Working 指示由外壳的火苗取代，可见性只在这里管理。
		ctx.ui.setWorkingVisible(false);
		// 独立底栏 0 行；借它拿到状态订阅与主题。
		ctx.ui.setFooter((_tui, theme, footerData) => {
			shell.theme = theme;
			shell.statuses = () => footerData.getExtensionStatuses();
			return { dispose() {}, invalidate() {}, render: () => [] };
		});
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ShellEditor(tui, theme, keybindings, shell, () => shell.bottom(ctx, pi.getThinkingLevel())));
	});
	pi.on("thinking_level_select", () => shell.requestRender());
	pi.on("model_select", () => shell.requestRender());
	pi.on("session_shutdown", (_event, ctx) => {
		shell.dispose();
		shell.turn = undefined;
		shell.review = undefined;
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
	});
}
