/**
 * /fire-review 的状态机：唯一事实源，纯 reducer，零 IO 零副作用。
 *
 * 循环状态只存在这一个 reducer 里：模块级不持有可变循环状态，
 * 持久化与 UI 都是本状态在 checkpoint / 结果卡上的投影。
 *
 * 相：idle → queued → reviewing → needs_fix → awaiting_fix → reviewing，终态 settled；
 * 质量裁决终态（通过 / 顾问叫停 / maxRounds 用尽）先经 summarizing：投递一个总结回合
 * 让执行模型用人话收尾（修了什么/为何过不了），回合结束才落 settled；
 * 事故终态（取消 / 超时 / 基础设施错误）直接 settled，不烧总结回合。
 * ReviewState 按 phase 判别：每个相只带自己的数据，不存在“reviewing 却没有审查者”之类的状态。
 * 不变量：同一时刻至多一个活动轮；round 单调递增；history 只追加不改写。
 */
import type { ChainedAtom, ModelAtom, ReviewConfig } from "../config.js";
import { fieldLine, msg, SUGGESTIONS_HEADING } from "./messages.js";

// 字段名两种语言都认，见 messages.ts 的 terms。
const ISSUE_LINE = fieldLine((terms) => terms.field.issue, { value: "(.+)$" });

// 取值表是类型与 checkpoint 校验（checkpoint.ts）、顾问解析（advisor.ts）共用的唯一来源。
export const PHASES = ["idle", "queued", "reviewing", "needs_fix", "awaiting_fix", "summarizing", "settled"] as const;
export const ROUND_RESULTS = ["passed", "failed", "error", "stopped", "cancelled", "timed_out"] as const;
export const ADVISOR_VERDICTS = ["continue", "stop", "narrow"] as const;
export const STOP_REASONS = ["user", "shutdown", "timeout"] as const;
/** 修复回合与总结回合共用的投递生命周期：pending 待投递 → running 已进入回合 → done 回合正常结束（总结回合结束直接落 settled，不经 done）。 */
export const TURN_STATUSES = ["pending", "running", "done"] as const;

export type Phase = (typeof PHASES)[number];
export type RoundResult = (typeof ROUND_RESULTS)[number];
export type AdvisorVerdict = (typeof ADVISOR_VERDICTS)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type TurnStatus = (typeof TURN_STATUSES)[number];
export type SummaryKind = "passed" | "max_rounds" | "advisor_stop";
/** 审查为什么结束：质量裁决三种（通过 / 顾问叫停 / 轮数用尽）与事故三种（基础设施错误 / 取消 / 总体超时）。 */
export const SETTLED_ENDS = ["passed", "stopped", "exhausted", "error", "cancelled", "timed_out"] as const;
export type SettledEnd = (typeof SETTLED_ENDS)[number];

/** 单个审查者的输出（output 契约解析结果，纯数据）。failed 含格式无效但以 FAIL 开头的票：原文进 details。 */
export interface ReviewerResult extends ModelAtom {
	index: number;
	status: "passed" | "failed" | "error";
	/** 短摘要：PASS 一行收敛摘要 / FAIL 发现一句话。 */
	summary: string;
	/** 全文：PASS 摘要+证据锚点 / FAIL 发现列表（或原文）/ error 的故障说明（fallback 链上每个模型一行）。 */
	details: string;
	/** 这一票由 fallback 给出时，被顶替的模型各自为何没给出结论（每个一行）。 */
	replaced?: string;
}

/** 审查中某个审查者的席位：本轮从哪个模型审起、其后还剩的 fallback；result 为 null 即还在审。 */
export interface ReviewerSlot extends ChainedAtom {
	result: ReviewerResult | null;
}

export interface AdvisorResult {
	verdict: AdvisorVerdict;
	advice: string;
}

/** 一轮已收口的记录；只追加不改写。全文只存在 reviewers[].details 一处，其余文本按 roundText 推出。 */
export interface ReviewRound {
	round: number;
	result: RoundResult;
	reviewers: ReviewerResult[];
	advisor?: AdvisorResult;
	/** 取消 / 超时的终止原因。 */
	reason?: StopReason;
	/** result 为 error 时的故障说明（基础设施错误原文，或缺席审查者的故障汇总）。 */
	error?: string;
	elapsedMs: number;
}

interface Base {
	runId: string;
	/** 当前轮号（1 起）；queued 时 0。 */
	round: number;
	focus: string;
	/** 已收口轮，只追加。 */
	history: ReviewRound[];
	/** 连续未通过轮数（顾问仲裁阈值）。 */
	consecutiveFailures: number;
	startedAt: number;
	/** 当前轮起点（本轮用时）。 */
	roundStartedAt: number;
	updatedAt: number;
}

export type ReviewState = Base &
	(
		| { phase: "idle" | "queued" }
		| { phase: "settled"; end: SettledEnd }
		| { phase: "reviewing"; slots: ReviewerSlot[] }
		/** FAIL 轮等顾问仲裁：本轮全部审查结果，收口前不进 history。 */
		| { phase: "needs_fix"; voters: ReviewerResult[] }
		| { phase: "awaiting_fix"; turn: TurnStatus }
		| { phase: "summarizing"; turn: TurnStatus }
	);

/** reducer 需要的配置子集：轮数与顾问阈值、审查者（beginRound 时填入 slots）、顾问模型。 */
export type ReviewLimits = Pick<ReviewConfig, "maxRounds" | "advisorAfterFailures" | "advisor" | "reviewers">;

export type ReviewEvent =
	| { type: "START"; focus: string }
	| { type: "RECOVER" }
	| { type: "REVIEWER_SETTLED"; index: number; result: ReviewerResult }
	| { type: "ADVISOR_SETTLED"; result: AdvisorResult }
	/** 跳过顾问继续修复；带 message 表示顾问不可用（发可见卡），不带表示用户按 esc 跳过。 */
	| { type: "ADVISOR_SKIPPED"; message?: string }
	| { type: "INFRASTRUCTURE_ERROR"; details: string }
	| { type: "ADVANCE" }
	| { type: "TURN_STARTED" }
	| { type: "TURN_ENDED"; aborted: boolean }
	| { type: "CANCEL"; reason: "user" | "shutdown" }
	| { type: "TIMEOUT" };

/** 结果卡：executor 渲染成消息；reducer 只决定发哪张、带什么数据。 */
export type CardData =
	| { kind: "start"; models: string[] }
	| { kind: "pass"; round: number; summary: string; elapsedMs: number; totalElapsedMs: number }
	| { kind: "fail"; round: number; details: string; elapsedMs: number }
	| { kind: "stop"; reason: "max_rounds"; round: number; details: string; elapsedMs?: number }
	| { kind: "stop"; reason: "advisor"; round: number; details: string; advisor: AdvisorResult; advisorModel: string; elapsedMs: number }
	| { kind: "timeout" }
	| { kind: "error"; message: string; elapsedMs?: number }
	// advisor 卡的 elapsedMs 是咨询时长（进入 needs_fix 到裁决落定），不是轮时长。
	| { kind: "advisor"; advisor: AdvisorResult; advisorModel: string; elapsedMs: number }
	| { kind: "skipped"; message: string };

export type ReviewEffect =
	| { kind: "advance" }
	| { kind: "send_card"; card: CardData }
	| { kind: "notify_cancelled" };

export interface ReduceResult {
	state: ReviewState;
	effects: ReviewEffect[];
}

export function initialState(runId: string): ReviewState {
	return {
		runId,
		phase: "idle",
		round: 0,
		focus: "",
		history: [],
		consecutiveFailures: 0,
		startedAt: 0,
		roundStartedAt: 0,
		updatedAt: 0,
	};
}

/** 相无关的公共字段。 */
function baseOf(state: ReviewState): Base {
	const { runId, round, focus, history, consecutiveFailures, startedAt, roundStartedAt } = state;
	return { runId, round, focus, history, consecutiveFailures, startedAt, roundStartedAt, updatedAt: state.updatedAt };
}

type PhaseData =
	| { phase: "idle" | "queued" }
	| { phase: "settled"; end: SettledEnd }
	| { phase: "reviewing"; slots: ReviewerSlot[] }
	| { phase: "needs_fix"; voters: ReviewerResult[] }
	| { phase: "awaiting_fix" | "summarizing"; turn: TurnStatus };

/** 换相：公共字段沿用并盖上 patch，相数据整体替换，旧相的数据不会残留。 */
function go(state: ReviewState, now: number, next: PhaseData, patch: Partial<Base> = {}): ReviewState {
	return { ...baseOf(state), ...patch, updatedAt: now, ...next } as ReviewState;
}

const NOTHING = (state: ReviewState): ReduceResult => ({ state, effects: [] });

export function reduce(state: ReviewState, event: ReviewEvent, limits: ReviewLimits, now: number): ReduceResult {
	switch (event.type) {
		case "START":
			// 一律先排队：开审统一经执行器的 idle 门（ADVANCE），排队相不发卡——输入框边框已有排队提示。
			return {
				state: go(initialState(state.runId), now, { phase: "queued" }, { focus: event.focus.trim(), startedAt: now }),
				effects: [{ kind: "advance" }],
			};
		case "RECOVER":
			return onRecover(state);
		case "REVIEWER_SETTLED":
			return onReviewerSettled(state, event, limits, now);
		case "ADVISOR_SETTLED":
			return onAdvisorSettled(state, event.result, limits, now);
		case "ADVISOR_SKIPPED":
			return onAdvisorSkipped(state, event.message, now);
		case "INFRASTRUCTURE_ERROR":
			return onInfrastructureError(state, event.details, now);
		case "ADVANCE":
			return onAdvance(state, limits, now);
		case "TURN_STARTED":
			return state.phase === "awaiting_fix" || state.phase === "summarizing"
				? state.turn === "pending" ? { state: go(state, now, { phase: state.phase, turn: "running" }), effects: [] } : NOTHING(state)
				: NOTHING(state);
		case "TURN_ENDED":
			return onTurnEnded(state, event.aborted, now);
		case "CANCEL":
			return interrupt(state, now, "cancelled", event.reason, event.reason === "user" ? [{ kind: "notify_cancelled" }] : []);
		case "TIMEOUT":
			return interrupt(state, now, "timed_out", "timeout", [{ kind: "send_card", card: { kind: "timeout" } }]);
	}
}

function onRecover(state: ReviewState): ReduceResult {
	// reload 会中断尚未确认完成的修复/总结回合；重新投递同一份持久化内容，不能跳过。
	// session_start 只恢复持久状态；宿主在所有 session_start handler 完成后另发 resources_discover，执行器到那个正式边界才请求推进。
	if ((state.phase === "awaiting_fix" || state.phase === "summarizing") && state.turn === "running")
		return { state: go(state, state.updatedAt, { phase: state.phase, turn: "pending" }), effects: [] };
	return NOTHING(state);
}

function onAdvance(state: ReviewState, limits: ReviewLimits, now: number): ReduceResult {
	if (state.phase === "queued")
		return {
			state: beginRound(state, 1, limits, now),
			effects: [
				{ kind: "send_card", card: { kind: "start", models: limits.reviewers.map((item) => item.model) } },
				{ kind: "advance" },
			],
		};
	if (state.phase !== "awaiting_fix" || state.turn !== "done") return NOTHING(state);
	// 开始卡只发第 1 轮：后续轮的边界由结果卡的轮号承担，重复开始卡只制造噪声。
	return { state: beginRound(state, state.round + 1, limits, now), effects: [{ kind: "advance" }] };
}

/**
 * 每个席位从上一轮给出结论的那个模型审起（同一场审查内记住换上的 fallback，不再每轮先等主模型失败），
 * 上一轮缺席或新开的审查从主模型审起；上一轮就是本场 history 的末轮。
 */
function beginRound(state: ReviewState, round: number, limits: ReviewLimits, now: number): ReviewState {
	const last = state.history.at(-1)?.reviewers;
	const slots: ReviewerSlot[] = limits.reviewers.map(({ fallback, ...primary }, index) => {
		const chain = [primary, ...fallback];
		const voter = last?.find((item) => item.index === index && item.status !== "error");
		const start = Math.max(0, chain.findIndex((atom) => atom.model === voter?.model && atom.thinking === voter.thinking));
		return { ...chain[start], fallback: chain.slice(start + 1), result: null };
	});
	return go(state, now, { phase: "reviewing", slots }, { round, roundStartedAt: now });
}

/** 修复回合结束：总结回合无论何种结局都落 settled（总结是尽力而非必须）；修复回合被中断按用户取消收尾。 */
function onTurnEnded(state: ReviewState, aborted: boolean, now: number): ReduceResult {
	if (state.phase === "summarizing") return { state: go(state, now, { phase: "settled", end: summaryEnd(state) }), effects: [] };
	if (state.phase !== "awaiting_fix" || state.turn !== "running") return NOTHING(state);
	if (aborted) return interrupt(state, now, "cancelled", "user", [{ kind: "notify_cancelled" }]);
	return { state: go(state, now, { phase: "awaiting_fix", turn: "done" }), effects: [] };
}

function onReviewerSettled(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "REVIEWER_SETTLED" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase !== "reviewing" || state.slots[event.index]?.result) return NOTHING(state);
	const slots = state.slots.map((slot, index) => (index === event.index ? { ...slot, result: event.result } : slot));
	const results = resultsOf(slots);
	if (results.length < slots.length) return { state: go(state, now, { phase: "reviewing", slots }), effects: [] };
	return settleRound(state, results, limits, now);
}

function settleRound(state: ReviewState, results: ReviewerResult[], limits: ReviewLimits, now: number): ReduceResult {
	const { round } = state;
	const absent = results.filter((item) => item.status === "error");
	const failed = results.some((item) => item.status === "failed");
	const all = sections(results);
	// 通过要每个审查者都给出 PASS：缺席者（fallback 链用尽仍无结论）不能让别人的 PASS 代表整轮。
	// 有 FAIL 时照常进修复（发现是真的，缺席者在失败卡里点名）；否则缺席即事故终态，执行模型修不了它，不烧修复与总结回合。
	if (!failed && absent.length > 0) {
		const error = `${msg.summary.noVerdict}\n\n${sections(absent)}`;
		const closed = closeRound(state, now, { round, result: "error", reviewers: results, error });
		return {
			state: go(state, now, { phase: "settled", end: "error" }, { history: [...state.history, closed] }),
			effects: [{ kind: "send_card", card: { kind: "error", message: error, elapsedMs: closed.elapsedMs } }],
		};
	}
	if (!failed) {
		// 通过是质量裁决终态 → 总结回合。
		const closed = closeRound(state, now, { round, result: "passed", reviewers: results });
		const summary = appendClosedFindings(passSummary(results), state.history, round);
		return {
			state: go(state, now, { phase: "summarizing", turn: "pending" }, { history: [...state.history, closed] }),
			effects: [
				{ kind: "send_card", card: { kind: "pass", round, summary, elapsedMs: closed.elapsedMs, totalElapsedMs: Math.max(0, now - state.startedAt) } },
				{ kind: "advance" },
			],
		};
	}
	const consecutiveFailures = state.consecutiveFailures + 1;
	const elapsedMs = elapsedSince(state, now);
	if (round >= limits.maxRounds) {
		const closed = closeRound(state, now, { round, result: "failed", reviewers: results });
		return {
			state: go(state, now, { phase: "summarizing", turn: "pending" }, { history: [...state.history, closed], consecutiveFailures }),
			effects: [
				{ kind: "send_card", card: { kind: "stop", reason: "max_rounds", round, details: all, elapsedMs } },
				{ kind: "advance" },
			],
		};
	}
	// 每轮未通过都发一张可见的失败卡：用户要能看到本轮结论，而不是只收到一条投给执行模型的隐藏反馈。
	const failCard: ReviewEffect = { kind: "send_card", card: { kind: "fail", round, details: all, elapsedMs } };
	if (consecutiveFailures >= limits.advisorAfterFailures)
		// 顾问可能裁定 stop，反馈永远不会投递：此时不能提前宣布「已交回修复」；
		// 卡里也不写「顾问介入中」——持久记录会过时，实况由输入框边框承担。
		return { state: go(state, now, { phase: "needs_fix", voters: results }, { consecutiveFailures }), effects: [failCard, { kind: "advance" }] };
	return toRepair(state, results, undefined, now, { consecutiveFailures }, [failCard, { kind: "advance" }]);
}

function onAdvisorSettled(state: ReviewState, advisor: AdvisorResult, limits: ReviewLimits, now: number): ReduceResult {
	if (state.phase !== "needs_fix") return NOTHING(state);
	// 咨询时长：needs_fix 相内只有顾问事件会迁移，updatedAt 即进入咨询的时刻。
	const elapsedMs = Math.max(0, now - state.updatedAt);
	const advisorModel = limits.advisor.model;
	if (advisor.verdict === "stop") {
		const closed = closeRound(state, now, { round: state.round, result: "stopped", reviewers: state.voters, advisor });
		return {
			state: go(state, now, { phase: "summarizing", turn: "pending" }, { history: [...state.history, closed] }),
			effects: [
				// findings 已在咨询前的失败卡显示；终止卡只承载顾问裁决，避免重复整张报告。
				{ kind: "send_card", card: { kind: "stop", reason: "advisor", round: state.round, details: advisor.advice, advisor, advisorModel, elapsedMs } },
				{ kind: "advance" },
			],
		};
	}
	// 失败卡已在咨询前发出；咨询完成只补中性的顾问建议卡。
	return toRepair(state, state.voters, advisor, now, {}, [
		{ kind: "send_card", card: { kind: "advisor", advisor, advisorModel, elapsedMs } },
		{ kind: "advance" },
	]);
}

function onAdvisorSkipped(state: ReviewState, message: string | undefined, now: number): ReduceResult {
	if (state.phase !== "needs_fix") return NOTHING(state);
	return toRepair(state, state.voters, undefined, now, {}, [
		...(message === undefined ? [] : [{ kind: "send_card", card: { kind: "skipped", message } } as const]),
		{ kind: "advance" },
	]);
}

/** 顾问没有叫停（继续/收窄/被跳过）或没到顾问阈值：把本轮收口为 failed，带着反馈进入修复。 */
function toRepair(
	state: ReviewState,
	voters: ReviewerResult[],
	advisor: AdvisorResult | undefined,
	now: number,
	patch: Partial<Base>,
	effects: ReviewEffect[],
): ReduceResult {
	const closed = closeRound(state, now, { round: state.round, result: "failed", reviewers: voters, ...(advisor ? { advisor } : {}) });
	return {
		state: go(state, now, { phase: "awaiting_fix", turn: "pending" }, { ...patch, history: [...state.history, closed] }),
		effects,
	};
}

function onInfrastructureError(state: ReviewState, details: string, now: number): ReduceResult {
	const reviewers = state.phase === "reviewing" ? resultsOf(state.slots) : state.phase === "needs_fix" ? state.voters : undefined;
	const round = reviewers && closeRound(state, now, { round: state.round, result: "error", reviewers, error: details });
	return abort(state, now, "error", round, [{ kind: "send_card", card: { kind: "error", message: details } }]);
}

/** 取消与超时：收口在途轮（审查中或等顾问），由 effects 区分用户可见的反馈。 */
function interrupt(
	state: ReviewState,
	now: number,
	result: "cancelled" | "timed_out",
	reason: StopReason,
	effects: ReviewEffect[],
): ReduceResult {
	const reviewers = state.phase === "reviewing" ? resultsOf(state.slots) : state.phase === "needs_fix" ? state.voters : undefined;
	const round = reviewers && closeRound(state, now, { round: state.round, result, reviewers, reason });
	return abort(state, now, result, round, effects);
}

/** 事故终态的统一出口：总结相已有质量裁决，静默收尾；其余相追加在途轮记录后直接 settled。 */
function abort(state: ReviewState, now: number, end: "error" | "cancelled" | "timed_out", round: ReviewRound | undefined, effects: ReviewEffect[]): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled") return NOTHING(state);
	if (state.phase === "summarizing") return { state: go(state, now, { phase: "settled", end: summaryEnd(state) }), effects: [] };
	return { state: go(state, now, { phase: "settled", end }, round ? { history: [...state.history, round] } : {}), effects };
}

function elapsedSince(state: ReviewState, now: number): number {
	return state.roundStartedAt ? Math.max(0, now - state.roundStartedAt) : 0;
}

function closeRound(state: ReviewState, now: number, record: Omit<ReviewRound, "elapsedMs">): ReviewRound {
	return { ...record, elapsedMs: elapsedSince(state, now) };
}

export function resultsOf(slots: ReviewerSlot[]): ReviewerResult[] {
	return slots.flatMap((slot) => (slot.result ? [slot.result] : []));
}

// ---- 文本：全文只在 reviewers[].details 一处，其余都从它推出 ----

/** 每个审查者一节，展示与归档保留模型分节。 */
export function sections(reviewers: ReviewerResult[]): string {
	return reviewers.map((item) => [modelLabel(item), item.replaced, item.details.trim()].filter(Boolean).join("\n")).join("\n\n");
}

/**
 * 一轮的文本：失败轮只含 FAIL 票（既是修复反馈也是往轮发现清单），顾问叫停是顾问意见，
 * 故障轮是故障说明，取消与超时没有文本，通过轮含各审查者全文（建议区在其中）。
 */
export function roundText(round: ReviewRound): string {
	switch (round.result) {
		case "failed":
			return findingsOf(round.reviewers);
		case "stopped":
			return round.advisor?.advice ?? "";
		case "error":
			return round.error ?? "";
		case "passed":
			return sections(round.reviewers);
		default:
			return "";
	}
}

/** 修复反馈（与往轮发现清单）只含 FAIL 票。 */
export function findingsOf(reviewers: ReviewerResult[]): string {
	return sections(reviewers.filter((item) => item.status === "failed"));
}

/** 审查生命周期内：总结回合也算——占用标签持有到总结完成，Master 才不会在结果卡与总结之间的窗口提前结算、漏掉总结回复。 */
export function isActive(state: ReviewState): boolean {
	return state.phase !== "idle" && state.phase !== "settled";
}

/** 总结回合收尾时的结局：由质量裁决那一轮决定。 */
function summaryEnd(state: ReviewState): SettledEnd {
	const kind = summaryKindOf(state.history.at(-1));
	return kind === "passed" ? "passed" : kind === "advisor_stop" ? "stopped" : "exhausted";
}

/** 总结回合的类型由终态那一轮决定。 */
export function summaryKindOf(round: ReviewRound | undefined): SummaryKind {
	return round?.result === "passed" ? "passed" : round?.result === "stopped" ? "advisor_stop" : "max_rounds";
}

function passSummary(passed: ReviewerResult[]) {
	const fallback = msg.summary.passedFallback;
	const lines = passed.length === 1
		? [passBody(passed[0]?.summary ?? "") || fallback]
		: passed.map((item) => msg.summary.modelBullet(shortModel(item.model), passBody(item.summary) || fallback));
	lines.push(...passed.flatMap((item) => (item.replaced ? [item.replaced] : [])));
	const suggestions = [...new Set(passed.flatMap((item) => splitSuggestions(item.details)))];
	if (suggestions.length === 0) return lines.join("\n");
	return [...lines, "", `## ${msg.terms.suggestions}`, ...suggestions.map((item) => `- ${item}`)].join("\n");
}

/** 建议区（“## 建议（非阻塞）”之后）的条目。 */
function splitSuggestions(details: string): string[] {
	const lines = details.split(/\r?\n/u);
	const index = lines.findIndex((line) => SUGGESTIONS_HEADING.test(line.trim()));
	if (index < 0) return [];
	return lines.slice(index + 1).map((line) => line.replace(/^[-*]\s*/u, "").trim()).filter(Boolean);
}

function passBody(summary: string) {
	return summary.replace(/^(?:PASS\s*)/iu, "").trim();
}

export function shortModel(model: string) {
	return model.split("/").at(-1) || model;
}

function appendClosedFindings(summary: string, history: ReviewRound[], beforeRound: number) {
	const seen = new Set<string>();
	const findings: { round: number; issue: string }[] = [];
	for (const round of history) {
		if (round.round >= beforeRound || round.result !== "failed") continue;
		for (const line of roundText(round).split(/\r?\n/u)) {
			const match = ISSUE_LINE.exec(line.trim());
			const issue = match?.[1]?.replace(/`([^`]+)`/gu, "$1").trim();
			if (!issue) continue;
			const key = issue.replace(/\s+/gu, "");
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ round: round.round, issue });
		}
	}
	if (findings.length === 0) return summary;
	const shown = findings.slice(0, 6);
	const recap = [msg.summary.closedHeading, ...shown.map((finding) => msg.summary.closedItem(finding.issue, finding.round))];
	if (findings.length > shown.length) recap.push(msg.summary.closedMore(findings.length - shown.length));
	return `${summary}\n\n${recap.join("\n")}`;
}

function modelLabel(item: ReviewerResult) {
	return msg.summary.modelSection(item.index + 1, shortModel(item.model));
}
