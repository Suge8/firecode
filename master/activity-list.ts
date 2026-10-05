/**
 * 输入框上方的子代理活动列表：需要处理的（失败、被中断、卡住）置顶，然后在跑与审查，再合计已完成与空闲。
 * 行布局在 activity.ts；这里只决定谁上榜、怎么排、哪些折叠、整表是否留角色，以及何时需要动画时钟；落定事实只在运行时，reload 后不展示历史。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { type ActivityRow as Row, renderActivityRow, roleFits } from "../activity.js";
import { flame, HEAT_COLORS, onFrame, paint, phaseOf, reviewMark } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { toolActionText } from "../tools/actions.js";
import type { ReviewProgress } from "../review/outcome.js";
import type { WorkerRef } from "./state.js";

/** 本次运行的落定事实：落定时刻、结局与行上的说明。失败与被中断留到 ack 或 kill，完成留到 kill。 */
export interface SettledFact {
	at: number;
	/** 被中断不是失败：会话与义务都在，等指挥官续派或收口。 */
	kind: "done" | "failed" | "interrupted";
	note?: string;
}

export interface ActivityFacts {
	workers: readonly Pick<WorkerRef, "name" | "role" | "status" | "sessionPath" | "cwd">[];
	currentTools: ReadonlyMap<string, ReadonlyMap<string, { tool: string; args: unknown }>>;
	reviewProgress: ReadonlyMap<string, ReviewProgress>;
	runStartedAt: ReadonlyMap<string, number>;
	/** 最近一次输出（工具事件或模型 token）的时刻；卡住按它与本次运行起点中较晚者计算。 */
	lastOutputAt: ReadonlyMap<string, number>;
	settled: ReadonlyMap<string, SettledFact>;
	/** 名字 → 启动序号（start 调用到达的先后）；池数组顺序受并发 start 的 await 影响，不能当启动序。重载恢复的没有记录，排最前并保持池内相对顺序。 */
	launchOrder: ReadonlyMap<string, number>;
}

type Toggle = "running" | "done" | "idle";
/** 一行输出：子代理行，或可点击的折叠行。 */
type Line = { row: Row } | { label: string; mark?: string; toggle: Toggle };

/** working 子代理这么久没有任何输出（模型 token 或工具事件）就追加“N 分钟无输出”。 */
const STUCK_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const STUCK_GLYPH = "◌";
const INTERRUPTED_GLYPH = "‖";
/** 可见行数下限；终端每 6 行再容纳一条在跑的行。 */
const MIN_ROWS = 4;
const ROWS_PER_ACTIVITY = 6;

const duration = (ms: number) => formatDuration(Math.max(0, ms));
const DONE_MARK = paint(HEAT_COLORS.green, "✓");
const IDLE_GLYPH = "·";
/** 名字列至多占行宽的这一份（窄屏不让长名字挤掉动作），且不少于 MIN_NAME_WIDTH。 */
const NAME_WIDTH_SHARE = 5;
const MIN_NAME_WIDTH = 9;
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

function group(facts: ActivityFacts, now: number, theme: Theme): Groups {
	const launch = (index: number) => facts.launchOrder.get(facts.workers[index].name) ?? -1;
	const indexes = facts.workers.map((_, index) => index).sort((a, b) => launch(a) - launch(b) || a - b);
	const groups: Groups = { failed: [], interrupted: [], stuck: [], running: [], done: [], idle: [], animating: false };
	for (const index of indexes) {
		const worker = facts.workers[index];
		const path = worker.sessionPath;
		const phase = phaseOf(index);
		const start = facts.runStartedAt.get(path);
		const base = { name: worker.name, role: worker.role, elapsed: start === undefined ? "" : duration(now - start) };
		if (worker.status === "working") {
			groups.animating = true;
			const silent = now - Math.max(start ?? now, facts.lastOutputAt.get(path) ?? 0);
			const tool = [...(facts.currentTools.get(path)?.values() ?? [])].at(-1);
			const action = tool ? toolActionText(tool.tool, tool.args, worker.cwd ?? "") : "思考中";
			// 卡住时动作照常显示（用户要知道卡在哪条命令上），只追加提醒；前台长命令同样按无输出计时。
			if (silent >= STUCK_MS)
				groups.stuck.push({ ...base, mark: theme.fg("warning", STUCK_GLYPH), action, note: ` · ${Math.floor(silent / MINUTE_MS)} 分钟无输出` });
			else groups.running.push({ ...base, mark: flame(1, phase), action });
			continue;
		}
		if (worker.status === "reviewing") {
			groups.animating = true;
			const progress = facts.reviewProgress.get(path);
			const action = progress ? `审查第 ${progress.round} 轮 · ${progress.settled}/${progress.total} 通过` : "审查中";
			groups.running.push({ ...base, mark: reviewMark(phase), action, tone: "review" });
			continue;
		}
		const fact = facts.settled.get(path);
		if (!fact) {
			groups.idle.push({ ...base, elapsed: "", mark: theme.fg("dim", IDLE_GLYPH), action: "空闲", settled: true });
			continue;
		}
		const settledRow = { ...base, elapsed: start === undefined ? "" : duration(fact.at - start), settled: true };
		if (fact.kind === "done") {
			groups.done.push({ ...settledRow, mark: DONE_MARK, action: fact.note ?? "已返回" });
			continue;
		}
		if (fact.kind === "interrupted") {
			groups.interrupted.push({ ...settledRow, mark: theme.fg("warning", INTERRUPTED_GLYPH), action: "被中断", tone: "warning" });
			continue;
		}
		groups.failed.push({ ...settledRow, mark: FAILED_MARK, action: fact.note ?? "失败", tone: "failed" });
	}
	return groups;
}

interface Folding {
	limit: number;
	showAllRunning: boolean;
	showDone: boolean;
	showIdle: boolean;
}

/** 需要处理的永远可见、不计入上限；上限只约束在跑的行，超出折成可点击的“… +N 个在跑”。 */
function layout({ failed, interrupted, stuck, running, done, idle }: Groups, folding: Folding): Line[] {
	const lines: Line[] = [...failed, ...interrupted, ...stuck].map((row) => ({ row }));
	const overflow = running.length > folding.limit;
	if (!overflow || folding.showAllRunning) {
		lines.push(...running.map((row) => ({ row })));
		if (overflow) lines.push({ label: "… 收起", toggle: "running" });
	} else {
		const shown = running.slice(0, folding.limit - 1);
		lines.push(...shown.map((row) => ({ row })), { label: `… +${running.length - shown.length} 个在跑`, toggle: "running" });
	}
	if (done.length) {
		lines.push({ label: `${done.length} 个已完成`, mark: DONE_MARK, toggle: "done" });
		if (folding.showDone) lines.push(...done.map((row) => ({ row })));
	}
	if (idle.length) {
		lines.push({ label: `${idle.length} 个空闲`, toggle: "idle" });
		if (folding.showIdle) lines.push(...idle.map((row) => ({ row })));
	}
	return lines;
}

function renderLines(lines: Line[], width: number, theme: Theme): string[] {
	const rows = lines.flatMap((line) => ("row" in line ? [line.row] : []));
	const longest = Math.max(0, ...rows.map((row) => visibleWidth(row.name)));
	const nameWidth = Math.min(longest, Math.max(MIN_NAME_WIDTH, Math.floor(width / NAME_WIDTH_SHARE)));
	// 退让整表一致：任何一行放不下“角色 · 动作”就全表丢角色，列才对得齐。
	const showRole = rows.every((row) => roleFits(row, width, nameWidth));
	return lines.map((line) => {
		if ("row" in line) return renderActivityRow(line.row, width, nameWidth, theme, showRole);
		const text = line.mark ? `  ${line.mark} ${theme.fg("muted", line.label)}` : `    ${theme.fg("muted", line.label)}`;
		return clip(text, width, "end", "");
	});
}

/** widget 组件：动画时钟只在有行在动时订阅，静止即取消；折叠行可点击展开/收起。 */
export class ActivityList {
	private unsubscribe: (() => void) | undefined;
	private showAllRunning = false;
	private showDone = false;
	private showIdle = false;
	private moving = true;
	/** 上一次渲染每行对应的折叠开关，供点击命中。 */
	private toggles: (Toggle | undefined)[] = [];

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly facts: () => ActivityFacts,
		private readonly limit: () => number,
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
		});
		this.toggles = lines.map((line) => ("toggle" in line ? line.toggle : undefined));
		return renderLines(lines, width, this.theme);
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const toggle = this.toggles[event.y];
		if (!toggle) return undefined;
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
