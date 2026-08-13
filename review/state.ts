/**
 * /fire-review 的状态机：唯一事实源，纯 reducer，零 IO 零副作用。
 *
 * 循环状态只存在这一个 reducer 里：模块级不持有可变循环状态，
 * 持久化与 UI 都是本状态在 checkpoint / 结果卡上的投影。
 *
 * 相：idle → queued → reviewing → needs_fix → awaiting_fix → reviewing，终态 settled。
 * 不变量：同一时刻至多一个活动轮；round 单调递增；history 只追加不改写。
 */
export type Phase =
	| "idle"
	| "queued"
	| "reviewing"
	| "needs_fix"
	| "awaiting_fix"
	| "settled";

export type ReviewerStatus = "running" | "passed" | "failed" | "error";
export type RoundResult = "passed" | "failed" | "error" | "stopped" | "cancelled" | "timed_out";
export type AdvisorVerdict = "continue" | "stop" | "narrow";
export type StopReason = "advisor" | "max_rounds" | "user" | "shutdown" | "timeout";

/** 单个审查者的输出（output 契约解析结果，纯数据）。 */
export interface ReviewerResult {
	index: number;
	model: string;
	thinking: string;
	status: Exclude<ReviewerStatus, "running">;
	/** 短摘要：PASS 一行收敛摘要 / FAIL 发现一句话。 */
	summary: string;
	/** 全文：PASS 摘要+证据锚点 / FAIL 发现列表。归档用。 */
	details: string;
}

/** 审查中某个审查者的进行状态；settled 后携带完整结果。 */
export interface ActiveReviewer {
	index: number;
	model: string;
	thinking: string;
	status: ReviewerStatus;
	result: ReviewerResult | null;
}

/** 当前轮的审查者集合。 */
export interface ActiveCheck {
	round: number;
	reviewers: ActiveReviewer[];
	settledCount: number;
}

export interface AdvisorResult {
	verdict: AdvisorVerdict;
	advice: string;
}

/** 一轮已收口的记录；只追加不改写。 */
export interface ReviewRound {
	round: number;
	result: RoundResult;
	/** 全文归档：PASS 摘要 / FAIL 发现列表 / advisor 建议等。 */
	details: string;
	reviewers: ReviewerResult[];
	advisor?: AdvisorResult;
	/** 取消 / 超时 / 停止的终止原因（展示层解析文案）。 */
	reason?: StopReason;
	elapsedMs: number;
}

/** 已判 FAIL 但尚未收口的轮：等顾问仲裁或直接投递反馈。 */
export interface PendingRound {
	round: number;
	reviewers: ReviewerResult[];
	details: string;
}

export type RepairStatus = "pending" | "awaiting_start" | "running" | "completed";

/** FAIL 后的修复回合。必须持久化，reload 才不会跳过尚未启动的反馈。 */
export interface RepairState {
	details: string;
	advisor: AdvisorResult | null;
	status: RepairStatus;
}

export interface ReviewState {
	generation: string;
	phase: Phase;
	/** 当前轮号（1 起）；queued 时 0。 */
	round: number;
	focus: string;
	/** 已收口轮，只追加。 */
	history: ReviewRound[];
	/** reviewing 轮的活动检查；其余相为 null。 */
	active: ActiveCheck | null;
	/** FAIL 轮等待顾问收口（needs_fix）。 */
	pending: PendingRound | null;
	/** awaiting_fix 的反馈与修复回合生命周期。 */
	repair: RepairState | null;
	/** 连续未通过轮数（顾问仲裁阈值）。 */
	consecutiveFailures: number;
	startedAt: number;
	/** 当前轮起点（本轮用时）。 */
	roundStartedAt: number;
	updatedAt: number;
}

/** reducer 需要的最小配置（限制语义 + 审查者模型清单，纯数据）。 */
export interface ReviewLimits {
	maxRounds: number;
	advisorAfterFailures: number;
	/** 本轮审查者（model/thinking），beginRound 时填入 active。 */
	reviewers: { model: string; thinking: string }[];
}

export type ReviewEvent =
	| { type: "START"; focus: string; busy: boolean; generation: string }
	| { type: "RECOVER" }
	| { type: "REVIEWER_SETTLED"; index: number; result: ReviewerResult }
	| { type: "ADVISOR_SETTLED"; result: AdvisorResult }
	| { type: "ADVANCE" }
	| { type: "FEEDBACK_DISPATCHED" }
	| { type: "REPAIR_STARTED" }
	| { type: "REPAIR_COMPLETED" }
	| { type: "CANCEL"; reason: "user" | "shutdown" }
	| { type: "TIMEOUT" };

/** 结果卡：executor 渲染成消息；reducer 只决定发哪张、带什么数据。 */
export type CardData =
	| { kind: "queued"; focus: string }
	| { kind: "start"; round: number; focus: string; models: string[] }
	| { kind: "pass"; round: number; summary: string; details: string; elapsedMs: number }
	| {
			kind: "fail";
			round: number;
			details: string;
			advisor: AdvisorResult | null;
			/** 本轮还要经顾问仲裁，反馈尚未投递。 */
			awaitingAdvisor?: boolean;
	  }
	| { kind: "stop"; reason: StopReason; round: number; details: string; advisor?: AdvisorResult }
	| { kind: "cancel"; round: number; reason: StopReason }
	| { kind: "timeout"; round: number; reason: StopReason }
	| { kind: "error"; message: string };

export type ReviewEffect =
	| { kind: "advance" }
	| { kind: "send_card"; card: CardData };

export interface ReduceResult {
	state: ReviewState;
	effects: ReviewEffect[];
}

export function initialState(generation: string): ReviewState {
	return {
		generation,
		phase: "idle",
		round: 0,
		focus: "",
		history: [],
		active: null,
		pending: null,
		repair: null,
		consecutiveFailures: 0,
		startedAt: 0,
		roundStartedAt: 0,
		updatedAt: 0,
	};
}

export function reduce(
	state: ReviewState,
	event: ReviewEvent,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	switch (event.type) {
		case "START":
			return onStart(state, event, limits, now);
		case "RECOVER":
			return onRecover(state);
		case "REVIEWER_SETTLED":
			return onReviewerSettled(state, event, limits, now);
		case "ADVISOR_SETTLED":
			return onAdvisorSettled(state, event, now);
		case "ADVANCE":
			return onAdvance(state, limits, now);
		case "FEEDBACK_DISPATCHED":
			return updateRepairStatus(state, "pending", "awaiting_start", now);
		case "REPAIR_STARTED":
			return updateRepairStatus(state, "awaiting_start", "running", now);
		case "REPAIR_COMPLETED":
			return updateRepairStatus(state, "running", "completed", now);
		case "CANCEL":
			return onCancel(state, event.reason, now);
		case "TIMEOUT":
			return onTimeout(state, now);
	}
}

function onStart(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "START" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase === "reviewing" || state.phase === "needs_fix" || state.phase === "awaiting_fix")
		return { state, effects: [] };
	const focus = event.focus.trim();
	if (event.busy)
		return {
			state: {
				...initialState(event.generation),
				phase: "queued",
				focus,
				startedAt: now,
				updatedAt: now,
			},
			effects: [
				{ kind: "send_card", card: { kind: "queued", focus } },
				{ kind: "advance" },
			],
		};
	return {
		state: beginRound(initialState(event.generation), focus, 1, limits, now),
		effects: [
			{
				kind: "send_card",
				card: {
					kind: "start",
					round: 1,
					focus,
					models: limits.reviewers.map((item) => item.model),
				},
			},
			{ kind: "advance" },
		],
	};
}

function onRecover(state: ReviewState): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	// reload 会中断尚未确认完成的修复回合；重新投递同一份持久化反馈，不能跳到下一轮。
	const repair =
		state.phase === "awaiting_fix" && state.repair && state.repair.status !== "completed"
			? { ...state.repair, status: "pending" as const }
			: state.repair;
	return { state: { ...state, repair }, effects: [{ kind: "advance" }] };
}

function updateRepairStatus(
	state: ReviewState,
	expected: RepairStatus,
	status: RepairStatus,
	now: number,
): ReduceResult {
	if (state.phase !== "awaiting_fix" || state.repair?.status !== expected)
		return { state, effects: [] };
	return {
		state: { ...state, repair: { ...state.repair, status }, updatedAt: now },
		effects: [],
	};
}

function onAdvance(
	state: ReviewState,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase === "queued")
		return {
			state: beginRound(state, state.focus, 1, limits, now),
			effects: [
				{
					kind: "send_card",
					card: {
						kind: "start",
						round: 1,
						focus: state.focus,
						models: limits.reviewers.map((item) => item.model),
					},
				},
				{ kind: "advance" },
			],
		};
	if (state.phase !== "awaiting_fix" || state.repair?.status !== "completed")
		return { state, effects: [] };
	if (state.round >= limits.maxRounds)
		return {
			state: { ...state, phase: "settled", repair: null, updatedAt: now },
			effects: [
				{
					kind: "send_card",
					card: { kind: "stop", reason: "max_rounds", round: state.round, details: "" },
				},
			],
		};
	return {
		state: beginRound(state, state.focus, state.round + 1, limits, now),
		effects: [
			{
				kind: "send_card",
				card: {
					kind: "start",
					round: state.round + 1,
					focus: state.focus,
					models: limits.reviewers.map((item) => item.model),
				},
			},
			{ kind: "advance" },
		],
	};
}

function onReviewerSettled(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "REVIEWER_SETTLED" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase !== "reviewing" || !state.active) return { state, effects: [] };
	const active = state.active;
	const settled: ReviewerResult[] = [];
	const reviewers = active.reviewers.map((item) => {
		if (item.index !== event.index) return item;
		settled.push(event.result);
		return { ...item, status: event.result.status, result: event.result };
	});
	const settledCount = active.settledCount + 1;
	const nextActive: ActiveCheck = { ...active, reviewers, settledCount };
	if (settledCount < reviewers.length)
		return {
			state: { ...state, active: nextActive, updatedAt: now },
			effects: [],
		};
	const allSettled = nextActive.reviewers.flatMap((item) =>
		item.result ? [item.result] : [],
	);
	return settleRound(state, nextActive, allSettled, limits, now);
}

function settleRound(
	state: ReviewState,
	active: ActiveCheck,
	settled: ReviewerResult[],
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	const { result, details } = aggregate(settled);
	const base = { ...state, active: null, updatedAt: now };
	if (result === "passed" || result === "error") {
		const round = roundRecord(active.round, result, details, settled, undefined, state.roundStartedAt, now);
		return {
			state: { ...base, phase: "settled", history: [...state.history, round] },
			effects: [
				{
					kind: "send_card",
					card:
						result === "passed"
							? {
									kind: "pass",
									round: active.round,
									summary: details,
									details,
									elapsedMs: round.elapsedMs,
								}
							: { kind: "error", message: details },
				},
			],
		};
	}
	const consecutiveFailures = state.consecutiveFailures + 1;
	if (active.round >= limits.maxRounds) {
		const round = roundRecord(active.round, "failed", details, settled, undefined, state.roundStartedAt, now);
		return {
			state: {
				...base,
				phase: "settled",
				consecutiveFailures,
				history: [...state.history, round],
			},
			effects: [
				{
					kind: "send_card",
					card: { kind: "stop", reason: "max_rounds", round: active.round, details },
				},
			],
		};
	}
	// 每轮未通过都发一张可见的失败卡：用户要能看到本轮结论，
	// 而不是只收到一条投给执行模型的隐藏反馈。
	const failCard: ReviewEffect = {
		kind: "send_card",
		card: { kind: "fail", round: active.round, details, advisor: null },
	};
	const pending: PendingRound = { round: active.round, reviewers: settled, details };
	if (consecutiveFailures >= limits.advisorAfterFailures)
		return {
			state: { ...base, phase: "needs_fix", pending, consecutiveFailures },
			// 顾问可能裁定 stop，反馈永远不会投递：此时不能提前宣布「已交回修复」。
			effects: [
				{
					kind: "send_card",
					card: {
						kind: "fail",
						round: active.round,
						details,
						advisor: null,
						awaitingAdvisor: true,
					},
				},
				{ kind: "advance" },
			],
		};
	return {
		state: {
			...base,
			phase: "awaiting_fix",
			pending: null,
			repair: { details, advisor: null, status: "pending" },
			consecutiveFailures,
			history: [
				...state.history,
				roundRecord(active.round, "failed", details, settled, undefined, state.roundStartedAt, now),
			],
		},
		effects: [failCard, { kind: "advance" }],
	};
}

function onAdvisorSettled(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "ADVISOR_SETTLED" }>,
	now: number,
): ReduceResult {
	if (state.phase !== "needs_fix" || !state.pending) return { state, effects: [] };
	const pending = state.pending;
	const advisor = event.result;
	if (advisor.verdict === "stop") {
		const round = roundRecord(pending.round, "stopped", advisor.advice, pending.reviewers, advisor, state.roundStartedAt, now);
		return {
			state: { ...state, phase: "settled", pending: null, history: [...state.history, round], updatedAt: now },
			effects: [
				{
					kind: "send_card",
					card: { kind: "stop", reason: "advisor", round: pending.round, details: advisor.advice, advisor },
				},
			],
		};
	}
	const round = roundRecord(pending.round, "failed", pending.details, pending.reviewers, advisor, state.roundStartedAt, now);
	return {
		state: {
			...state,
			phase: "awaiting_fix",
			pending: null,
			repair: { details: pending.details, advisor, status: "pending" },
			history: [...state.history, round],
			updatedAt: now,
		},
		// 仲裁完成后补卡并经统一 barrier 投反馈。
		effects: [
			{
				kind: "send_card",
				card: { kind: "fail", round: pending.round, details: pending.details, advisor },
			},
			{ kind: "advance" },
		],
	};
}

function onCancel(
	state: ReviewState,
	reason: "user" | "shutdown",
	now: number,
): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	if (state.phase === "queued")
		return {
			state: { ...state, phase: "settled", updatedAt: now },
			effects: [{ kind: "send_card", card: { kind: "cancel", round: 0, reason } }],
		};
	const round = resolveRoundRecord(state, "cancelled", reason, now);
	return {
		state: {
			...state,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			history: round ? [...state.history, round] : state.history,
			updatedAt: now,
		},
		effects: [{ kind: "send_card", card: { kind: "cancel", round: state.round, reason } }],
	};
}

function onTimeout(state: ReviewState, now: number): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	if (state.phase === "queued")
		return {
			state: { ...state, phase: "settled", updatedAt: now },
			effects: [{ kind: "send_card", card: { kind: "timeout", round: 0, reason: "timeout" } }],
		};
	const round = resolveRoundRecord(state, "timed_out", "timeout", now);
	return {
		state: {
			...state,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			history: round ? [...state.history, round] : state.history,
			updatedAt: now,
		},
		effects: [
			{ kind: "send_card", card: { kind: "timeout", round: state.round, reason: "timeout" } },
		],
	};
}

function beginRound(
	state: ReviewState,
	focus: string,
	round: number,
	limits: ReviewLimits,
	now: number,
): ReviewState {
	const reviewers: ActiveReviewer[] = limits.reviewers.map((item, index) => ({
		index,
		model: item.model,
		thinking: item.thinking,
		status: "running",
		result: null,
	}));
	return {
		...state,
		phase: "reviewing",
		round,
		focus,
		active: { round, reviewers, settledCount: 0 },
		pending: null,
		repair: null,
		roundStartedAt: now,
		updatedAt: now,
	};
}

/** 聚合多审查者结论：任一 FAIL 即整轮未通过；全 error 为基础设施错误；其余按 pass 收口。
 * 逐项按自身状态打标签（pass 轮里 error 的项标 ERROR，不标 PASS）。 */
function aggregate(reviewers: ReviewerResult[]): { result: "passed" | "failed" | "error"; details: string } {
	const failed = reviewers.filter((item) => item.status === "failed");
	const errors = reviewers.filter((item) => item.status === "error");
	// 多数审查者缺席时无论剩下那票是 PASS 还是 FAIL 都不算数：
	// 拿单票宣告通过是假成功，拿单票驱动自动修复同样缺乏对抗交叉。
	const completed = reviewers.length - errors.length;
	if (completed * 2 <= reviewers.length)
		return { result: "error", details: aggregateDetails(reviewers) };
	if (failed.length > 0) return { result: "failed", details: aggregateDetails(reviewers) };
	return { result: "passed", details: aggregateDetails(reviewers) };
}

function aggregateDetails(reviewers: ReviewerResult[]): string {
	return reviewers
		.map((item) => {
			const label = item.status === "failed" ? "FAIL" : item.status === "error" ? "ERROR" : "PASS";
			return `${label} · ${item.model}\n${item.details.trim()}`;
		})
		.join("\n\n");
}

function resolveRoundRecord(
	state: ReviewState,
	result: RoundResult,
	reason: StopReason,
	now: number,
): ReviewRound | undefined {
	if (state.phase === "reviewing" && state.active) {
		const settled = state.active.reviewers.flatMap((item) =>
			item.result ? [item.result] : [],
		);
		return roundRecord(state.active.round, result, "", settled, undefined, state.roundStartedAt, now, reason);
	}
	if (state.phase === "needs_fix" && state.pending)
		return roundRecord(
			state.pending.round,
			result,
			"",
			state.pending.reviewers,
			undefined,
			state.roundStartedAt,
			now,
			reason,
		);
	return undefined;
}

function roundRecord(
	round: number,
	result: RoundResult,
	details: string,
	reviewers: ReviewerResult[],
	advisor: AdvisorResult | undefined,
	roundStartedAt: number,
	now: number,
	reason?: StopReason,
): ReviewRound {
	return {
		round,
		result,
		details,
		reviewers,
		...(advisor ? { advisor } : {}),
		...(reason ? { reason } : {}),
		elapsedMs: roundStartedAt ? Math.max(0, now - roundStartedAt) : 0,
	};
}
