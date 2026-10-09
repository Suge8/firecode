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
import { type BusyView, IDLE, OUTCOME_TEXT, roundTexts, watchBusy } from "../busy.js";
import { HEAT_COLORS, flame, onFrame, paint, phaseOf, reviewMark, settleMark, settling } from "../flame.js";
import { clip, firstSentence, formatDuration, formatModelName, formatTokens, oneLine } from "../format.js";
import { OCCUPANCY_CHANNEL, type OccupancyPayload, type ReviewProgress, type ReviewStage } from "../review/occupancy.js";
import { contextColor, thinkingColor } from "../theme.js";
import { type BranchEntry, latestTurnRecord, ROUND_RECORDED_CHANNEL, type TurnRecord } from "../tools/round.js";
import { msg } from "./messages.js";
import { type BottomParts, type TopParts, bottomBorder, topBorder } from "./render.js";
import { promptRename } from "./rename.js";

/** 展示标题的上限（列）：实际宽度由下边框布局按终端宽度逐级裁。 */
const TITLE_MAX_WIDTH = 60;
/** 去掉终端控制序列与控制字符，保留换行供首句规则识别 Markdown 结构。 */
const sanitize = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");

function userTitle(message: MessageStartEvent["message"]): string | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	const text = typeof content === "string" ? content : content
		.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	return clip(firstSentence(sanitize(text)), TITLE_MAX_WIDTH) || undefined;
}

function displayTitle(ctx: ExtensionContext, incoming?: MessageStartEvent["message"]): string {
	const name = ctx.sessionManager.getSessionName();
	if (name) return oneLine(sanitize(name));
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const title = userTitle(entry.message);
		if (title) return title;
	}
	return (incoming && userTitle(incoming)) || msg.newSession;
}

const FAST_STATUS = "pi-openai-native-fast";
/** session/presets.ts 发布的生效预设名（已着色）。 */
const PRESET_STATUS = "preset";
/** 落定后暖光渐隐的时长；落定结果本身一直留到下一轮开始。 */
const GLOW_FADE_MS = 1_000;

/** 外壳要展示的全部运行状态；事件写入，编辑器每次绘制只读。 */
class Shell {
	title = msg.newSession;
	/** busy.ts 的会话进行中快照：起点、指挥官是否在跑、在飞子代理数。 */
	busy: BusyView = IDLE;
	/**
	 * 最近一轮的落定事实（分支轮记录按与摘要行同一条规则合成）与落定时刻，留到下一轮开始。
	 * 只在轮记录写入、开会话、切分支时算一次，绘制只读它：读分支是整条回溯。at 为空是开会话时恢复的，不播落定过渡。
	 */
	settled: { record: TurnRecord; at?: number } | undefined;
	/** 审查占用期间的进度访问器（review 经占用频道发布）；undefined 表示没有审查。 */
	review: (() => ReviewProgress | undefined) | undefined;
	statuses: () => ReadonlyMap<string, string> = () => new Map();
	theme: Theme | undefined;
	requestRender = () => {};
	private stopClock: (() => void) | undefined;

	/** 时钟只在有动效要播时订阅：回合进行、落定过渡或审查进行。 */
	syncClock(): void {
		const need = this.review !== undefined || this.busy.busy || (this.settled?.at !== undefined && settling(Date.now() - this.settled.at));
		if (need && !this.stopClock) this.stopClock = onFrame(() => { this.syncClock(); this.requestRender(); });
		if (!need && this.stopClock) { this.stopClock(); this.stopClock = undefined; }
	}

	dispose(): void {
		this.stopClock?.();
		this.stopClock = undefined;
		this.requestRender = () => {};
		this.busy = IDLE;
		this.settled = undefined;
		this.review = undefined;
	}

	sync(view: BusyView): void {
		this.busy = view;
		if (view.busy) this.settled = undefined;
	}

	showRecord(branch: readonly BranchEntry[], at?: number): void {
		if (this.busy.busy) return;
		const record = latestTurnRecord(branch);
		this.settled = record && { record, at };
	}

	private readonly fg = (color: Parameters<Theme["fg"]>[0], text: string): string => this.theme?.fg(color, text) ?? text;

	top(): TopParts {
		const { busy, settled, review } = this;
		const status = (key: string) => this.statuses().get(key) ?? "";
		const parts: TopParts = {
			mark: "", word: "", elapsed: "", review: [], glow: 0,
			watcher: status("watcher"), master: status("master"),
		};
		if (busy.since !== undefined) {
			parts.mark = flame(3, phaseOf(0));
			const word = activityWord(busy);
			parts.word = word && this.fg("text", word);
			parts.elapsed = this.fg("muted", formatDuration(Date.now() - busy.since));
			parts.glow = 1;
		} else if (settled) {
			const { record } = settled;
			const since = settled.at === undefined ? Infinity : Date.now() - settled.at;
			const text = OUTCOME_TEXT[record.round.outcome];
			parts.mark = settleMark(text ? "failed" : "done", since);
			// 与摘要行同一写法：终态字样、耗时、均速之间都是“ · ”；终态字样不随窄屏退让。
			parts.elapsed = [
				...(text ? [this.fg("error", text)] : []),
				...roundTexts(record.round).map((part) => this.fg("muted", part)),
				...record.earlier.map((part) => this.fg("warning", part)),
			].join(this.fg("dim", " · "));
			parts.glow = Math.max(0, 1 - since / GLOW_FADE_MS);
		}
		if (review) parts.review = reviewTiers(review(), (text) => this.fg("error", text));
		return parts;
	}

	bottom(ctx: ExtensionContext, thinking: string): BottomParts {
		const { fg } = this;
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
		const percent = usage?.percent;
		return {
			title: fg("muted", this.title),
			preset: this.statuses().get(PRESET_STATUS) ?? "",
			model: fg("text", formatModelName(model?.id)),
			think: model?.reasoning ? fg(thinkingColor(thinking as never), `/${thinking}`) : "",
			fast: this.statuses().has(FAST_STATUS) ? fg("warning", "Fast") : "",
			percent: fg(contextColor(percent), percent == null ? "?" : `${percent.toFixed(1)}%`),
			capacity: fg("dim", `/${formatTokens(window)}`),
		};
	}
}

/** 进行中的那个词：主会话审查期间（等结论、修复、总结）一律由审查进度说明，不另写词；否则指挥官在跑是“处理中”，再否则是在等子代理。 */
function activityWord(busy: BusyView): string {
	if (busy.review) return "";
	return busy.agentRunning ? msg.working : msg.waitingWorkers(busy.inFlight);
}

/** 审查进度的退让档：`审查 第2轮 1/3 · 1 阻断` → 丢阻断数 → 丢票数或阶段，“审查 第N轮”留到最后；字形始终在。 */
function reviewTiers(progress: ReviewProgress | undefined, error: (text: string) => string): string[] {
	const gold = (text: string) => paint(HEAT_COLORS.gold, text);
	const mark = reviewMark(phaseOf(2));
	const head = `${mark} ${gold(msg.review)}`;
	if (!progress) return [head];
	const named = progress.round > 0 ? `${head}${gold(` ${msg.reviewRound(progress.round)}`)}` : head;
	const body = gold(progress.stage === "reviewing" ? `${progress.passed}/${progress.total}` : msg.reviewStage[progress.stage]);
	const blocked = progress.stage === "reviewing" && progress.blocked ? `${gold(" · ")}${error(msg.reviewBlocked(progress.blocked))}` : "";
	const tiers = [`${named} ${body}${blocked}`, `${named} ${body}`, named];
	return tiers.filter((tier, index) => tier !== tiers[index - 1]);
}

class ShellEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly shell: Shell,
		private readonly bottomParts: () => BottomParts,
		onRename: () => void,
	) {
		super(tui, theme, keybindings);
		shell.requestRender = () => tui.requestRender();
		this.onAction("app.session.rename", onRename);
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

export function registerStatusBar(pi: ExtensionAPI): void {
	const shell = new Shell();
	const updateTitle = (ctx: ExtensionContext, incoming?: MessageStartEvent["message"]) => {
		shell.title = displayTitle(ctx, incoming);
		shell.requestRender();
	};
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") updateTitle(ctx, event.message);
	});
	pi.on("session_info_changed", (_event, ctx) => updateTitle(ctx));
	watchBusy(pi, {
		onChange: (view) => {
			shell.sync(view);
			shell.syncClock();
			shell.requestRender();
		},
	});
	let branch: () => readonly BranchEntry[] = () => [];
	/**
	 * 落定态只在三个时点算一次并存下，绘制只读（读分支是整条回溯，不能放进每次按键重绘）：轮记录写入后的发布、
	 * session_start（重开会话直接显示上一轮，不播落定过渡）、session_tree。不取歇下边沿：那一刻记录未必已写进分支，订阅顺序不定。
	 */
	const showRecord = (at?: number) => {
		shell.showRecord(branch(), at);
		shell.syncClock();
		shell.requestRender();
	};
	pi.events.on(ROUND_RECORDED_CHANNEL, () => showRecord(Date.now()));
	pi.on("session_tree", (_event, ctx) => {
		updateTitle(ctx);
		showRecord();
	});
	pi.events.on(OCCUPANCY_CHANNEL, (data) => {
		const occupancy = data as OccupancyPayload;
		shell.review = occupancy.active ? occupancy.progress : undefined;
		shell.syncClock();
		shell.requestRender();
	});
	pi.on("session_start", (_event, ctx) => {
		updateTitle(ctx);
		branch = () => ctx.sessionManager.getBranch();
		showRecord();
		// 宿主内嵌的 Working 指示由外壳的火苗取代，可见性只在这里管理。
		ctx.ui.setWorkingVisible(false);
		// 独立底栏 0 行；借它拿到状态订阅与主题。
		ctx.ui.setFooter((_tui, theme, footerData) => {
			shell.theme = theme;
			shell.statuses = () => footerData.getExtensionStatuses();
			return { dispose() {}, invalidate() {}, render: () => [] };
		});
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ShellEditor(tui, theme, keybindings, shell, () => shell.bottom(ctx, pi.getThinkingLevel()),
				() => void promptRename(pi, ctx)));
	});
	pi.on("thinking_level_select", () => shell.requestRender());
	pi.on("model_select", () => shell.requestRender());
	pi.on("session_shutdown", (_event, ctx) => {
		shell.dispose();
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
	});
}
