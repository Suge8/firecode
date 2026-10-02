/**
 * 输入框上方的子代理活动列表：运行、审查、待发落的 Worker 各占一行。
 * 行布局与火苗来自 activity.ts / flame.ts；这里只决定谁上榜、保留谁、以及何时需要动画时钟。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ACTIVITY_ROWS, renderActivityRow, renderMoreRow, type ActivityRow } from "../activity.js";
import { flame, onFrame, phaseOf, reviewMark, settleMark, settling, type Settle } from "../flame.js";
import { formatDuration } from "../format.js";
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
	workers: readonly Pick<WorkerRef, "name" | "role" | "status" | "sessionPath" | "disposition">[];
	currentTools: ReadonlyMap<string, ReadonlyMap<string, { tool: string }>>;
	reviewProgress: ReadonlyMap<string, ReviewProgress>;
	runStartedAt: ReadonlyMap<string, number>;
	settled: ReadonlyMap<string, SettledFact>;
}

interface Entry {
	/** 保留优先级：待发落 0 → 审查 1 → 运行 2。 */
	rank: number;
	row: ActivityRow;
}

const duration = (ms: number) => formatDuration(Math.max(0, ms));

function entryOf(facts: ActivityFacts, index: number, now: number): (Entry & { moving: boolean }) | undefined {
	const worker = facts.workers[index];
	const path = worker.sessionPath;
	const phase = phaseOf(index);
	const start = facts.runStartedAt.get(path);
	const base = { name: worker.name, role: worker.role };
	if (worker.status === "working") {
		const tool = [...(facts.currentTools.get(path)?.values() ?? [])].at(-1)?.tool;
		const elapsed = start === undefined ? "" : duration(now - start);
		return { rank: 2, moving: true, row: { ...base, mark: flame(1, phase), action: tool ?? "思考中", elapsed } };
	}
	if (worker.status === "reviewing") {
		const progress = facts.reviewProgress.get(path);
		const action = progress ? `审查第 ${progress.round} 轮 · ${progress.settled}/${progress.total} 通过` : "审查中";
		const elapsed = start === undefined ? "" : duration(now - start);
		return { rank: 1, moving: true, row: { ...base, mark: reviewMark(phase), action, tone: "review", elapsed } };
	}
	// 待发落 = 有落定事实（本进程刚落定，投递前就要在列）或持久化的 disposition（reload 后事实已丢，按已冷却的完成态展示，不编造耗时）。
	const fact = facts.settled.get(path);
	if (!fact && !worker.disposition) return undefined;
	const kind = fact?.kind ?? "done";
	const since = fact ? now - fact.at : Infinity;
	const failed = kind === "failed";
	return {
		rank: 0,
		moving: settling(since),
		row: {
			...base,
			mark: settleMark(kind, since, phase),
			action: failed ? fact?.note ?? "失败" : "已返回，待发落",
			...(failed ? { tone: "failed" as const } : {}),
			elapsed: fact && start !== undefined ? duration(fact.at - start) : "",
			settled: true,
		},
	};
}

function collect(facts: ActivityFacts, now: number) {
	const entries = facts.workers.flatMap((_, index) => entryOf(facts, index, now) ?? []);
	return { entries, animating: entries.some((entry) => entry.moving) };
}

/** 按保留规则裁到 ACTIVITY_ROWS：待发落最先，其次审查，最后运行；保留行仍按启动顺序。 */
function visibleEntries(entries: Entry[]): { shown: Entry[]; hidden: number } {
	if (entries.length <= ACTIVITY_ROWS) return { shown: entries, hidden: 0 };
	const keep = new Set(
		entries.map((entry, order) => ({ entry, order }))
			.sort((a, b) => a.entry.rank - b.entry.rank || a.order - b.order)
			.slice(0, ACTIVITY_ROWS - 1)
			.map(({ entry }) => entry),
	);
	const shown = entries.filter((entry) => keep.has(entry));
	return { shown, hidden: entries.length - shown.length };
}

/** animating：有行在动（运行、审查、落定过渡未播完），调用方据此决定是否订阅时钟。 */
export function activityLines(facts: ActivityFacts, now: number, width: number, theme: Theme) {
	const { entries, animating } = collect(facts, now);
	const { shown, hidden } = visibleEntries(entries);
	const nameWidth = Math.max(0, ...entries.map((entry) => visibleWidth(entry.row.name)));
	const lines = shown.map((entry) => renderActivityRow(entry.row, width, nameWidth, theme));
	if (hidden) lines.push(renderMoreRow(hidden, width, theme));
	return { lines, animating };
}

/** widget 组件：动画时钟只在有行在动时订阅，静止即取消。 */
export class ActivityList {
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly facts: () => ActivityFacts,
	) {}

	/** 事实变化后调用：对齐订阅状态并重绘一次。 */
	sync(): void {
		const animating = collect(this.facts(), Date.now()).animating;
		if (animating && !this.unsubscribe) this.unsubscribe = onFrame(() => this.onFrame());
		if (!animating) this.release();
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
		return activityLines(this.facts(), Date.now(), width, this.theme).lines;
	}

	dispose(): void {
		this.release();
	}
}
