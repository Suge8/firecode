/**
 * 子代理此刻的相位：所在分组、在做什么与时刻。纯事实、不带着色、无界面依赖——活动列表的行、全过程视图的上横线、
 * `subagents_list` 与 `/fire-master status`、名册（同进程扩展读的，见 roster.ts）与停摆唤醒（run.ts 的 watchStall）都只读这一处；
 * 状态词也只有一张表（messages.ts 的 `phase`）。输入由运行时从档案加运行时事实投影一次给出，落定事实只在运行时，reload 后不展示历史。
 */
import { clockText } from "../format.js";
import type { ReviewRoundProgress } from "../review/outcome.js";
import { toolActionText } from "../tools/actions.js";
import { msg as toolsMsg } from "../tools/messages.js";
import { msg } from "./messages.js";
import type { WorkerRef } from "./state.js";

/** 本次运行的落定事实：落定时刻、结局与行上的说明。失败与被中断留到 ack 或 kill，完成留到 kill。 */
export interface SettledFact {
	at: number;
	/** 被中断不是失败：会话与义务都在，等指挥官续派或收口。 */
	kind: "done" | "failed" | "interrupted";
	note?: string;
}

/** 一个子代理的相位输入：档案加这次运行的运行时事实。 */
export interface WorkerFacts {
	worker: WorkerRef;
	/** 最近开始、还没结束的工具调用。 */
	tool?: { tool: string; args: unknown };
	review?: ReviewRoundProgress;
	/** 本次运行（start/send/review，含自动续跑）的起点。 */
	startedAt?: number;
	/** 无输出计时的起点（本回合开始或最近一次输出）；卡住按它与本次运行起点中较晚者计算。 */
	quietSince?: number;
	/** 在跑子代理的进展行（见 progress.ts）：一句现在时的“在做什么”，有就替代在跑行的工具动作。 */
	progress?: string;
	settled?: SettledFact;
}

/** 按启动序的全部子代理，加卡住时限（Timing.stallMs：working 这么久没有任何输出就算卡住）。 */
export interface ActivityFacts {
	workers: readonly WorkerFacts[];
	stallMs: number;
}

/** 一个子代理的分组（活动列表里审查与暂停都与在跑同组展示）。 */
export type PhaseKind = "failed" | "interrupted" | "stuck" | "running" | "review" | "paused" | "done" | "idle";

export interface WorkerPhase {
	kind: PhaseKind;
	action: string;
	startedAt?: number;
	/** 落定时刻：只有 done、failed、interrupted 有。 */
	settledAt?: number;
	/** working 时这段无输出已持续多久。 */
	quietMs?: number;
	/** working 且没卡住时的进展行（已替进 action）；全过程视图头部另外单独显示它。 */
	summary?: string;
}

const MINUTE_MS = 60_000;

/** 卡住提醒里的整分钟数。 */
export const quietMinutes = (quietMs: number) => Math.floor(quietMs / MINUTE_MS);

export function workerPhase({ worker, tool, review, startedAt, quietSince, progress, settled }: WorkerFacts, stallMs: number, now: number): WorkerPhase {
	if (worker.status === "working") {
		const quietMs = now - Math.max(startedAt ?? now, quietSince ?? 0);
		const action = tool ? toolActionText(tool.tool, tool.args, worker.cwd ?? "") : toolsMsg.activity.thinking;
		// 进展行有就替代工具动作，所有展示同一条规则。卡住时照常显示工具（用户要知道卡在哪条命令上），只追加提醒；
		// 停摆事件只在卡住时发，读到的总是工具动作。前台长命令同样按无输出计时。
		const stuck = quietMs >= stallMs;
		const summary = stuck ? undefined : progress;
		return { kind: stuck ? "stuck" : "running", action: summary ?? action, startedAt, quietMs, ...(summary === undefined ? {} : { summary }) };
	}
	if (worker.status === "reviewing")
		return { kind: "review", startedAt, action: review ? msg.activity.reviewRound(review.round, review.settled, review.total) : msg.activity.reviewing };
	// 暂停读档案而不读运行时：reload 后照样显示，到时自动续跑，不需要指挥官处理。
	if (worker.resume) return { kind: "paused", startedAt, action: msg.activity.paused(clockText(worker.resume.at, now)) };
	if (!settled) return { kind: "idle", action: "" };
	const times = { startedAt, settledAt: settled.at };
	if (settled.kind === "done") return { kind: "done", action: settled.note ?? msg.activity.returned, ...times };
	if (settled.kind === "interrupted") return { kind: "interrupted", action: msg.activity.interrupted, ...times };
	return { kind: "failed", action: settled.note ?? msg.activity.failed, ...times };
}
