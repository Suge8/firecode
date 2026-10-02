/**
 * 输入框上方的子代理活动列表：运行、审查、待发落的 Worker 各占一行。
 * 行布局与火苗来自 activity.ts / flame.ts；这里只决定谁上榜、保留谁、以及何时需要动画时钟。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ACTIVITY_ROWS, renderActivityRow, renderMoreRow, type ActivityRow } from "../activity.js";
import { flame, onFrame, phaseOf, reviewMark, settleMark, settling, type Settle } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { toolActionText } from "../tools/actions.js";
import type { WorkerRef } from "./state.js";

export interface ReviewProgress {
	kind: "review";
	round: number;
	settled: number;
	total: number;
}

/** 本次运行的落定事实：落定时刻、成败与失败时的说明。 */
export interface SettledFact {
	at: number;
	kind: Settle;
	note?: string;
}

export interface ActivityFacts {
	workers: readonly Pick<WorkerRef, "name" | "role" | "status" | "sessionPath" | "cwd">[];
	currentTools: ReadonlyMap<string, ReadonlyMap<string, { tool: string; args: unknown }>>;
	reviewProgress: ReadonlyMap<string, ReviewProgress>;
	runStartedAt: ReadonlyMap<string, number>;
	settled: ReadonlyMap<string, SettledFact>;
}

interface Entry {
	row: ActivityRow;
	/** 正在动：运行、审查或落定过渡未播完，需要动画时钟。 */
	moving: boolean;
	/** 落定行的移除时刻。 */
	expiresAt?: number;
}

/** 落定行停留时长：完成短、失败长，给用户留出看清的时间。 */
const DONE_LINGER_MS = 10_000;
const FAILED_LINGER_MS = 30_000;
/** 动作文本上限：长命令先截到这里，窄屏再由行布局按剩余宽度截短。 */
const ACTION_MAX = 40;

const duration = (ms: number) => formatDuration(Math.max(0, ms));

function entryOf(facts: ActivityFacts, index: number, now: number): Entry | undefined {
	const worker = facts.workers[index];
	const path = worker.sessionPath;
	const phase = phaseOf(index);
	const start = facts.runStartedAt.get(path);
	const base = { name: worker.name, role: worker.role };
	if (worker.status === "working") {
		const tool = [...(facts.currentTools.get(path)?.values() ?? [])].at(-1);
		const elapsed = start === undefined ? "" : duration(now - start);
		return { moving: true, row: { ...base, mark: flame(1, phase), action: tool ? clip(toolActionText(tool.tool, tool.args, worker.cwd ?? ""), ACTION_MAX, "end", "…") : "思考中", elapsed } };
	}
	if (worker.status === "reviewing") {
		const progress = facts.reviewProgress.get(path);
		const action = progress ? `审查第 ${progress.round} 轮 · ${progress.settled}/${progress.total} 通过` : "审查中";
		const elapsed = start === undefined ? "" : duration(now - start);
		return { moving: true, row: { ...base, mark: reviewMark(phase), action, tone: "review", elapsed } };
	}
	// 只列本进程内刚落定的：reload 后事实丢失，不展示历史。
	const fact = facts.settled.get(path);
	if (!fact) return undefined;
	const expiresAt = fact.at + (fact.kind === "failed" ? FAILED_LINGER_MS : DONE_LINGER_MS);
	if (now >= expiresAt) return undefined;
	const since = now - fact.at;
	const failed = fact.kind === "failed";
	return {
		moving: settling(since),
		expiresAt,
		row: {
			...base,
			mark: settleMark(fact.kind, since, phase),
			action: failed ? fact.note ?? "失败" : "已返回",
			...(failed ? { tone: "failed" as const } : {}),
			elapsed: start !== undefined ? duration(fact.at - start) : "",
			settled: true,
		},
	};
}

function collect(facts: ActivityFacts, now: number) {
	const entries = facts.workers.flatMap((_, index) => entryOf(facts, index, now) ?? []);
	const expiries = entries.flatMap((entry) => entry.expiresAt ?? []);
	return {
		entries,
		animating: entries.some((entry) => entry.moving),
		/** 最近一个落定行还有多久移除；没有落定行时为 undefined。 */
		nextExpiryMs: expiries.length ? Math.min(...expiries) - now : undefined,
	};
}

/** 终端每 6 行容纳一条活动。 */
const ROWS_PER_ACTIVITY = 6;

/** 可见行数：随终端高度放宽，全局展开显示全部；宿主拿不到高度时用下限。 */
export function visibleRows(terminalRows: number | undefined, expanded: boolean): number {
	if (expanded) return Infinity;
	return Math.max(ACTIVITY_ROWS, Math.floor((terminalRows ?? 0) / ROWS_PER_ACTIVITY));
}
/** 行按启动顺序；超出上限时留前 limit-1 行，末行汇总其余。 */
export function activityLines(facts: ActivityFacts, now: number, width: number, theme: Theme, limit = ACTIVITY_ROWS) {
	const { entries, animating } = collect(facts, now);
	const shown = entries.length > limit ? entries.slice(0, limit - 1) : entries;
	const nameWidth = Math.max(0, ...entries.map((entry) => visibleWidth(entry.row.name)));
	const lines = shown.map((entry) => renderActivityRow(entry.row, width, nameWidth, theme));
	if (shown.length < entries.length) lines.push(renderMoreRow(entries.length - shown.length, width, theme));
	return { lines, animating };
}

/** widget 组件：动画时钟只在有行在动时订阅，静止即取消。 */
export class ActivityList {
	private unsubscribe: (() => void) | undefined;
	private expiry: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly facts: () => ActivityFacts,
		private readonly limit: () => number,
	) {}

	/** 事实变化后调用：对齐时钟订阅与落定行到期唤醒，并重绘一次。 */
	sync(): void {
		const { animating, nextExpiryMs } = collect(this.facts(), Date.now());
		if (animating && !this.unsubscribe) this.unsubscribe = onFrame(() => this.onFrame());
		if (!animating) this.release();
		clearTimeout(this.expiry);
		this.expiry = nextExpiryMs === undefined ? undefined : setTimeout(() => this.sync(), nextExpiryMs + 1);
		this.expiry?.unref?.();
		this.tui.requestRender();
	}

	private onFrame(): void {
		if (!collect(this.facts(), Date.now()).animating) this.release();
		this.tui.requestRender();
	}

	private release(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return activityLines(this.facts(), Date.now(), width, this.theme, this.limit()).lines;
	}

	dispose(): void {
		clearTimeout(this.expiry);
		this.release();
	}
}
