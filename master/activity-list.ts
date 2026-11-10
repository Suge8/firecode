/**
 * 输入框上方的子代理活动列表：需要处理的（失败、被中断、卡住）置顶，然后在跑、审查与暂停（到时自动续跑），再合计已完成与空闲。
 * 分组与行上的文字读 phase.ts 的相位，行布局在 activity.ts；这里只决定谁上榜、怎么排、哪些折叠、整表是否留角色，以及何时需要动画时钟。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type ActivityRow as Row, nameWidthFor, renderActivityRow, roleFits } from "./activity.js";
import { flame, HEAT_COLORS, onFrame, paint, phaseOf, reviewMark } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { msg } from "./messages.js";
import { quietMinutes, workerPhase, type ActivityFacts, type PhaseKind } from "./phase.js";

type Toggle = "running" | "done" | "idle";
/** 一行输出：子代理行，或可点击的折叠行（计数可点，收起时附被折叠的名字）。 */
type Line = { row: Row } | { label: string; mark: string; toggle: Toggle; names: readonly string[] };
/** 点击命中：折叠行翻转展开，子代理行打开它的全过程视图。 */
type Target = { toggle: Toggle } | { open: string };

const STUCK_GLYPH = "◌";
const INTERRUPTED_GLYPH = "‖";
const PAUSED_GLYPH = "‥";
/** 可见行数下限；终端每 6 行再容纳一条在跑的行。 */
const MIN_ROWS = 4;
const ROWS_PER_ACTIVITY = 6;

const duration = (ms: number) => formatDuration(Math.max(0, ms));
const DONE_MARK = paint(HEAT_COLORS.green, "✓");
const IDLE_GLYPH = "·";

/** 卡住提醒的全写法与窄屏短写法。 */
function silentNote(minutes: number): { full: string; short: string } {
	return { full: msg.activity.silentFull(minutes), short: msg.activity.silentShort(minutes) };
}
const FAILED_MARK = paint(HEAT_COLORS.fail, "✗");

/**
 * 可见的在跑行数：随终端高度放宽；宿主拿不到高度时用下限。ctrl+o 是聊天区的全局展开，不展开活动列表——
 * 它常驻在输入框上方，再展开只会挤掉正文视口；要看全部点折叠行。
 */
export function visibleRows(terminalRows: number | undefined): number {
	return Math.max(MIN_ROWS, Math.floor((terminalRows ?? 0) / ROWS_PER_ACTIVITY));
}

interface Groups {
	failed: Row[];
	interrupted: Row[];
	stuck: Row[];
	running: Row[];
	done: Row[];
	/** 空闲且本进程内没有落定结局的（resume 恢复的、ack 过的）。 */
	idle: Row[];
	/** 有行在动：在跑、审查、卡住（耗时仍在走），需要动画时钟；落定行静止。 */
	animating: boolean;
}

/** 有行在动（耗时仍在走）的分组：需要动画时钟。 */
export const ANIMATING_KINDS: ReadonlySet<PhaseKind> = new Set(["stuck", "running", "review"]);

/** 一个子代理的行状态：所在分组与这一行（标记、动作、耗时）。index 是它在 facts.workers 里的位置（决定火苗相位）。 */
export function rowState(facts: ActivityFacts, index: number, now: number, theme: Theme): { kind: PhaseKind; row: Row; summary?: string } {
	const { worker } = facts.workers[index];
	const flamePhase = phaseOf(index);
	const { kind, action, startedAt, settledAt, quietMs, summary } = workerPhase(facts.workers[index], facts.stallMs, now);
	const base = { name: worker.name, role: worker.role, action, elapsed: startedAt === undefined ? "" : duration(now - startedAt) };
	switch (kind) {
		// 右侧不放总耗时：要看的是“多久没输出”，两个时长并排（“5m 无输出 5m13s”）只会看混。
		case "stuck": return { kind, row: { ...base, elapsed: "", mark: theme.fg("warning", STUCK_GLYPH), note: silentNote(quietMinutes(quietMs!)) } };
		case "running": return { kind, summary, row: { ...base, mark: flame(1, flamePhase) } };
		case "review": return { kind, row: { ...base, mark: reviewMark(flamePhase), tone: "review" } };
		// 静止的一行：没有在跑的耗时，等的是续跑时刻。
		case "paused": return { kind, row: { ...base, elapsed: "", mark: theme.fg("dim", PAUSED_GLYPH), settled: true } };
		// 组名已经说了“空闲”，展开行只列谁。
		case "idle": return { kind, row: { ...base, elapsed: "", mark: theme.fg("dim", IDLE_GLYPH), settled: true } };
		default: {
			const settled = { ...base, elapsed: startedAt === undefined ? "" : duration(settledAt! - startedAt), settled: true };
			if (kind === "done") return { kind, row: { ...settled, mark: DONE_MARK } };
			if (kind === "interrupted") return { kind, row: { ...settled, mark: theme.fg("warning", INTERRUPTED_GLYPH), tone: "warning" } };
			return { kind, row: { ...settled, mark: FAILED_MARK, tone: "failed" } };
		}
	}
}

function group(facts: ActivityFacts, now: number, theme: Theme): Groups {
	const groups: Groups = { failed: [], interrupted: [], stuck: [], running: [], done: [], idle: [], animating: false };
	for (let index = 0; index < facts.workers.length; index++) {
		const { kind, row } = rowState(facts, index, now, theme);
		groups.animating ||= ANIMATING_KINDS.has(kind);
		groups[kind === "review" || kind === "paused" ? "running" : kind].push(row);
	}
	return groups;
}

interface Folding {
	limit: number;
	showAllRunning: boolean;
	showDone: boolean;
	showIdle: boolean;
}

/** 需要处理的永远可见、不计入上限；上限只约束在跑的行，超出折成可点击的“+N 个在跑”。 */
function layout({ failed, interrupted, stuck, running, done, idle }: Groups, folding: Folding, theme: Theme): Line[] {
	const lines: Line[] = [...failed, ...interrupted, ...stuck].map((row) => ({ row }));
	const idleMark = theme.fg("dim", IDLE_GLYPH);
	const names = (rows: readonly Row[], open: boolean) => (open ? [] : rows.map((row) => row.name));
	const overflow = running.length > folding.limit;
	if (!overflow || folding.showAllRunning) {
		lines.push(...running.map((row) => ({ row })));
		if (overflow) lines.push({ label: msg.activity.collapse, mark: idleMark, toggle: "running", names: [] });
	} else {
		const shown = running.slice(0, folding.limit - 1);
		const hidden = running.slice(shown.length);
		lines.push(...shown.map((row) => ({ row })), { label: msg.activity.moreRunning(hidden.length), mark: idleMark, toggle: "running", names: names(hidden, false) });
	}
	if (done.length) {
		lines.push({ label: msg.activity.done(done.length), mark: DONE_MARK, toggle: "done", names: names(done, folding.showDone) });
		if (folding.showDone) lines.push(...done.map((row) => ({ row })));
	}
	if (idle.length) {
		lines.push({ label: msg.activity.idle(idle.length), mark: idleMark, toggle: "idle", names: names(idle, folding.showIdle) });
		if (folding.showIdle) lines.push(...idle.map((row) => ({ row })));
	}
	return lines;
}

function renderLines(lines: Line[], width: number, theme: Theme): string[] {
	const rows = lines.flatMap((line) => ("row" in line ? [line.row] : []));
	const nameWidth = nameWidthFor(rows, width);
	// 退让整表一致：任何一行放不下“角色 · 动作”就全表丢角色，列才对得齐。
	const showRole = rows.every((row) => roleFits(row, width, nameWidth));
	// 折叠行的名字预览列对齐：按最宽的计数补齐。
	const labelWidth = Math.max(0, ...lines.map((line) => ("label" in line ? visibleWidth(line.label) : 0)));
	return lines.map((line) => {
		if ("row" in line) return renderActivityRow(line.row, width, nameWidth, theme, showRole);
		const head = `  ${line.mark} ${chip(line.label, theme)}`;
		const pad = labelWidth - visibleWidth(line.label) + 1;
		const preview = fitNames(line.names, width - visibleWidth(head) - pad);
		const text = preview ? `${head}${" ".repeat(pad)}${theme.fg("dim", preview)}` : head;
		return clip(text, width, "end", "");
	});
}

/**
 * 折叠行计数的可点提示：两侧各一格空白、铺工具行同族的中性暗底。theme.bg 以背景关闭（49）收尾、不带全量重置，
 * clip 在胶囊中间截断也保留这个关闭序列，底色不会被掐断或漏到后面。不用下划线：终端按字形画，数字粗、中文细。
 */
const chip = (label: string, theme: Theme) => theme.bg("toolPendingBg", theme.fg("muted", ` ${label} `));

/** 能放下几个名字列几个，只列整名，不在名字中间截断。 */
function fitNames(names: readonly string[], room: number): string {
	let text = "";
	for (const name of names) {
		const next = text ? `${text} · ${name}` : name;
		if (visibleWidth(next) > room) break;
		text = next;
	}
	return text;
}

/** widget 组件：动画时钟只在有行在动时订阅，静止即取消；折叠行可点击展开/收起。 */
export class ActivityList {
	private unsubscribe: (() => void) | undefined;
	private showAllRunning = false;
	private showDone = false;
	private showIdle = false;
	private moving = true;
	/** 上一次渲染每行对应的点击目标。 */
	private targets: (Target | undefined)[] = [];

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly facts: () => ActivityFacts,
		private readonly limit: () => number,
		private readonly open: (name: string) => void,
	) {}

	/** 事实变化后调用：对齐时钟订阅并重绘一次。 */
	sync(): void {
		const animating = group(this.facts(), Date.now(), this.theme).animating;
		if (animating && !this.unsubscribe) this.unsubscribe = onFrame(() => this.onFrame());
		if (!animating) this.release();
		this.tui.requestRender();
	}

	/** 每帧只重绘；是否还在动由上一次 render 的分组顺带给出，不再单独分组一遍。 */
	private onFrame(): void {
		if (!this.moving) this.release();
		this.tui.requestRender();
	}

	private release(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const limit = this.limit();
		const groups = group(this.facts(), Date.now(), this.theme);
		this.moving = groups.animating;
		const lines = layout(groups, {
			limit,
			showAllRunning: this.showAllRunning,
			showDone: this.showDone,
			showIdle: this.showIdle,
		}, this.theme);
		this.targets = lines.map((line) => ("toggle" in line ? { toggle: line.toggle } : { open: line.row.name }));
		return renderLines(lines, width, this.theme);
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const target = this.targets[event.y];
		if (!target) return undefined;
		if ("open" in target) {
			this.open(target.open);
			return { handled: true };
		}
		const { toggle } = target;
		if (toggle === "running") this.showAllRunning = !this.showAllRunning;
		else if (toggle === "done") this.showDone = !this.showDone;
		else this.showIdle = !this.showIdle;
		this.tui.requestRender();
		return { handled: true };
	}

	/** 展开不常驻：下一轮人类输入时收起，免得一直占着输入框上方。 */
	collapse(): void {
		if (!this.showAllRunning && !this.showDone && !this.showIdle) return;
		this.showAllRunning = this.showDone = this.showIdle = false;
		this.tui.requestRender();
	}

	dispose(): void {
		this.release();
	}
}
