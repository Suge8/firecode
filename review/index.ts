/**
 * /fire-review：对抗性审查插件的执行器与入口。
 *
 * 职责分界：
 * - 领域状态只活在纯 reducer（state.ts）里，所有迁移经 reduce() 计算；
 *   本文件是唯一执行器，只做副作用（起审查会话、投递反馈、发卡、持久化、占用信号、界面接管），
 *   会话结果一律回灌成事件交给 reducer。
 * - 运行时状态按会话隔离：pi 在同一进程内对同一 cwd 复用扩展模块实例，主会话与每个
 *   Worker 子会话共用本文件；`registerReview(pi)` 各自持有一份 ReviewRuntime，模块级不留
 *   任何会话状态，一个会话被 dispose 不会拖累另一个。
 * - 渲染器在此顶层无条件注册（不懒加载），live 与 reload 外观一致。
 */
import { randomUUID } from "node:crypto";
import { wrapEnvelope } from "../deliver.js";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ModelAtom, type ReviewConfig } from "../config.js";
import { readPrompt } from "../i18n.js";
import { InProcessSessionPool } from "../master/spawn.js";
import { buildCard, CARD_TYPE, registerCardRenderer } from "./card.js";
import {
	beginCheckpoint,
	CheckpointConflictError,
	type CheckpointStamp,
	readCheckpoint,
	readStamp,
	recordRefusal,
	writeCheckpoint,
} from "./checkpoint.js";
import { buildEvidence } from "./evidence.js";
import { ReviewUi } from "./ui.js";
import { OCCUPANCY_CHANNEL, type OccupancyPayload, type ReviewProgress, type ReviewStage } from "../busy.js";
import { msg } from "./messages.js";
import { buildAdvisorPrompt, buildFixFeedback, buildReviewPrompt, buildSummaryPrompt } from "./prompt.js";
import { runAdvisor } from "./advisor.js";
import { runReviewer } from "./reviewer.js";
import { createReviewSessionRunner, type ReviewModelConfig, type ReviewSessionRunner } from "./session.js";
import {
	type CardData,
	type Phase,
	type ReviewEffect,
	type ReviewEvent,
	type ReviewState,
	initialState,
	reduce,
} from "./state.js";

const FEEDBACK_TYPE = "firecode-review-feedback";
/** 总结回合提示：与修复反馈同通道（进上下文不渲染），不参与证据自指。 */
const SUMMARY_REQUEST_TYPE = "firecode-review-summary";
/** sendMessage 没有 Promise/错误回调；用 agent_start 作为反馈已启动的回执。 */
const FOLLOW_UP_START_TIMEOUT_MS = 2_000;
const PROMPTS = new URL("./prompts/", import.meta.url);
/** 总体超时：maxRounds 轮 × 每轮 2 倍单进程超时，最低 30 分钟。 */
function overallTimeoutMs(config: ReviewConfig) {
	return Math.max(
		30 * 60_000,
		config.maxRounds * config.timeoutMinutes * 2 * 60_000,
	);
}

/** 审查生命周期内：总结回合也算——占用标签持有到总结完成，Master 才不会在结果卡与总结之间的窗口提前结算、漏掉总结回复。 */
function isActive(state: ReviewState) {
	return state.phase !== "idle" && state.phase !== "settled";
}

/** 当前审查者/顾问任务；执行模型 agent_start 必须 await 它退出后才能继续。 */
interface Action {
	/** 本运行时已启动的阶段；reload 后新 controller 会重启被中断的审查会话。 */
	key: string;
	abort: AbortController;
	done: Promise<void>;
}

interface Controller {
	ctx: ExtensionContext;
	config: ReviewConfig;
	state: ReviewState;
	/** 用户取消、超时或持久化失败后置位：此后不再启动新工作。 */
	cancelled: boolean;
	watchdog: ReturnType<typeof setTimeout> | undefined;
	/** 本 controller 上一次写入的凭证；null=本审查还没写过，undefined=冲突/失败后停写。 */
	persistedStamp: CheckpointStamp | null | undefined;
	/** streaming 时 sendMessage 会变成 steer；展示卡必须等 settled 后再发。 */
	pendingCards: CardData[];
	ui: ReviewUi;
	action?: Action;
	/** 修复反馈/总结提示已 sendMessage，等待 agent_start 回执。 */
	startTimer?: ReturnType<typeof setTimeout>;
	/** 占用频道的 true/false 必须由同一 controller 配对，订阅方按最近一条取值。 */
	occupancyHeld?: boolean;
}

/** 一个会话的审查运行时：controller 是当前这场审查，queue 串行化它的状态迁移。 */
interface ReviewRuntime {
	readonly pi: ExtensionAPI;
	readonly runSession: ReviewSessionRunner;
	controller: Controller | undefined;
	queue: Promise<void>;
}

interface ReviewDependencies {
	runSession?: ReviewSessionRunner;
}

export interface ReviewHandle {
	/** 等待 event-loop barrier 与其产生的状态迁移排空（测试用）。 */
	settled(): Promise<void>;
}

export function registerReview(
	pi: ExtensionAPI,
	enabled = true,
	configBroken = false,
	dependencies: ReviewDependencies = {},
): ReviewHandle {
	// 渲染器与开关解耦：关闭 review 后历史卡 reload 仍使用原生结果卡样式。
	registerCardRenderer(pi);
	const rt: ReviewRuntime = {
		pi,
		runSession: dependencies.runSession ?? createReviewSessionRunner(new InProcessSessionPool()),
		controller: undefined,
		queue: Promise.resolve(),
	};
	const handle: ReviewHandle = {
		settled: async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await rt.queue;
			await new Promise<void>((resolve) => setImmediate(resolve));
			await rt.queue;
		},
	};
	if (!enabled) {
		// 只有用户明确关闭才封存活动 checkpoint（防重新启用后恢复幽灵审查）；
		// features 配置坏掉不是关闭：保留 checkpoint，修好配置重启后继续恢复。
		if (!configBroken) pi.on("session_start", (_event, ctx) => settleDisabledCheckpoint(pi, ctx));
		return handle;
	}
	pi.registerCommand("fire-review", {
		description: msg.command.description,
		handler: (args, ctx) => handleCommand(rt, args, ctx),
	});
	pi.on("session_start", (_event, ctx) => handleSessionStart(rt, ctx));
	// 宿主保证 resources_discover 在整次 session_start（含所有异步 handler）完成后发出。
	pi.on("resources_discover", (_event, ctx) => requestAdvance(rt, ctx));
	pi.on("agent_start", () => handleAgentStart(rt));
	// agent_end 只记录修复/总结回合的结局，不在此推进审查。
	pi.on("agent_end", (event) => handleAgentEnd(rt, event));
	// settled 后尝试恢复；后续异步 handler 若再触发模型，agent_start 互锁会先停审查。
	pi.on("agent_settled", (_event, ctx) => requestAdvance(rt, ctx));
	pi.on("session_shutdown", (event, ctx) => handleShutdown(rt, event.reason, ctx));
	return handle;
}

/** 追加一条已封存的终态 checkpoint（活动态清空），写不进去时抛错。 */
function sealCheckpoint(pi: ExtensionAPI, state: ReviewState): void {
	beginCheckpoint(pi, {
		...state,
		phase: "settled",
		active: null,
		pending: null,
		repair: null,
		summary: null,
		updatedAt: Date.now(),
	});
}

function settleDisabledCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	try {
		sealCheckpoint(pi, checkpoint);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(msg.notify.cannotSealOld(errorText(error)), "error");
	}
}

/** 串行化状态迁移：reducer 同步执行，副作用排队；同一时刻只有一个迁移在跑。
 * 返回队尾 Promise，让 pi 的事件处理器（session_shutdown 等）可 await 持久化落盘。 */
function dispatch(rt: ReviewRuntime, event: ReviewEvent): Promise<void> {
	const run = rt.queue.then(async () => {
		const active = rt.controller;
		if (!active) return;
		const { state, effects } = reduce(active.state, event, active.config, Date.now());
		if (state !== active.state) {
			active.state = state;
			// 持久化失败不能当成功继续：否则会拿不一致的状态去起会话、投反馈，
			// 重启后又从旧 checkpoint 恢复，重现幽灵审查与重复反馈。
			if (!persist(rt, state)) return;
			if (!isActive(state)) clearWatchdog(active);
			syncOccupancy(rt, active);
			syncUi(rt, active);
		}
		await runEffects(rt, effects);
	});
	// 队列一旦 rejected 就再也不会执行后续迁移（连 esc 取消也会失效）：
	// 副作用异常只能到此为止，不得杀死状态机。
	rt.queue = run.catch((error) => notifyEffectFailure(rt, error));
	return rt.queue;
}

function notify(active: Controller, message: string, level: "info" | "warning" | "error"): void {
	if (active.ctx.hasUI) active.ctx.ui.notify(message, level);
}

function notifyEffectFailure(rt: ReviewRuntime, error: unknown) {
	if (rt.controller) notify(rt.controller, msg.notify.stepFailed(errorText(error)), "warning");
}

function newController(ctx: ExtensionContext, config: ReviewConfig, state: ReviewState, stamp: CheckpointStamp | null): Controller {
	return {
		ctx,
		config,
		state,
		cancelled: false,
		watchdog: undefined,
		persistedStamp: stamp,
		pendingCards: [],
		ui: new ReviewUi(),
	};
}

async function handleCommand(rt: ReviewRuntime, args: string, ctx: ExtensionContext) {
	// 配置解析失败不能让命令无声失败：pi 会捕获 handler 异常，用户只会看到什么都没发生。
	// 命令与恢复两个入口共用同一判定：任何一个静默回退默认模型都会花真钱跑错模型。
	const loaded = loadConfig().review;
	if ("error" in loaded) return refuse(rt, ctx, loaded.error, "error");
	if (rt.controller && isActive(rt.controller.state)) return refuse(rt, ctx, msg.command.alreadyRunning, "info");
	const input = args.trim();
	if (input.startsWith("--")) return refuse(rt, ctx, msg.command.invalidArgs, "error");
	rt.controller = newController(ctx, loaded.config, initialState(randomUUID()), null);
	armWatchdog(rt);
	// 命令入口也只提出推进请求；真正开审统一经过下一 event-loop 的 idle barrier。
	void dispatch(rt, { type: "START", focus: input });
}

/** 拒绝启动：有 UI 时通知，无论有无 UI 都记录——Worker 里没有 UI，Master 靠这条记录读到原因。 */
function refuse(rt: ReviewRuntime, ctx: ExtensionContext, message: string, level: "info" | "error"): void {
	recordRefusal(rt.pi, message);
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** 重启 / 会话恢复：从 checkpoint 重建 controller 并续跑未完成的环节。
 * reload / new / resume / fork 是运行时替换（新 pi、新 runtime），旧 runtime 已在
 * session_shutdown 收口；这里只按新会话的 checkpoint 恢复，quit 之外不 settle。 */
function handleSessionStart(rt: ReviewRuntime, ctx: ExtensionContext): Promise<void> | void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	// 配置问题的告警由入口统一聚合；这里保留活动 checkpoint，修好后继续恢复。
	const loaded = loadConfig().review;
	if ("error" in loaded) return;
	const active = newController(ctx, loaded.config, checkpoint, readStamp(ctx));
	rt.controller = active;
	armWatchdog(rt);
	syncOccupancy(rt, active);
	syncUi(rt, active);
	// 恢复只更新持久状态并提出推进请求；绝不在 session_start handler 内起任何工作。
	return dispatch(rt, { type: "RECOVER" });
}

async function handleAgentStart(rt: ReviewRuntime): Promise<void> {
	const active = rt.controller;
	if (!active) return;
	const { state } = active;
	if (state.phase === "awaiting_fix" && state.repair?.status === "awaiting_start") {
		clearStartTimer(active);
		await dispatch(rt, { type: "REPAIR_STARTED" });
		return;
	}
	if (state.phase === "summarizing" && state.summary?.status === "awaiting_start") {
		clearStartTimer(active);
		await dispatch(rt, { type: "SUMMARY_STARTED" });
		return;
	}
	// 其他扩展可在我们排队后异步触发执行模型。agent_start 是宿主提供的硬边界：
	// 宿主会 await 本 handler，因此先 abort 并等所有审查会话真正退出，再允许模型 turn_start。
	if (!active.action) return;
	active.action.abort.abort();
	await active.action.done;
}

function handleAgentEnd(rt: ReviewRuntime, event: AgentEndEvent): Promise<void> | void {
	const active = rt.controller;
	if (!active) return;
	// 总结回合任何结局都收尾：裁决已落地，总结失败/中断不重试不升级。
	if (active.state.phase === "summarizing" && active.state.summary?.status === "running")
		return dispatch(rt, { type: "SUMMARY_SETTLED" });
	if (active.state.phase !== "awaiting_fix" || active.state.repair?.status !== "running") return;
	const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
	if (assistant && assistant.stopReason !== "error" && assistant.stopReason !== "aborted")
		return dispatch(rt, { type: "REPAIR_COMPLETED" });
	stopWork(active);
	return dispatch(rt, { type: "CANCEL", reason: "user" });
}

function requestAdvance(rt: ReviewRuntime, ctx: ExtensionContext): void {
	const active = rt.controller;
	if (!active) return;
	void advanceWhenIdle(rt, ctx, active.state.runId).catch((error) => {
		notifyEffectFailure(rt, error);
		if (rt.controller !== active) return;
		stopWork(active);
		void dispatch(rt, { type: "CANCEL", reason: "user" });
	});
}

async function advanceWhenIdle(rt: ReviewRuntime, ctx: ExtensionContext, runId: string): Promise<void> {
	const active = rt.controller;
	// 所有启动入口共享 idle 门；正确性另由 agent_start 的同步停审互锁保证。
	if (
		!active ||
		active.state.runId !== runId ||
		active.cancelled ||
		!ctx.isIdle() ||
		ctx.hasPendingMessages()
	) return;
	active.ctx = ctx;
	flushPendingCards(rt);
	const { state } = active;
	switch (state.phase) {
		case "queued":
			return dispatch(rt, { type: "ADVANCE" });
		case "reviewing":
			return startAction(rt, active, `review:${state.round}`, "reviewer", (signal) => startReviewers(rt, active, signal));
		case "needs_fix":
			return startAction(rt, active, `advisor:${state.round}`, "advisor", (signal) => consultAdvisor(rt, active, signal));
		case "summarizing":
			if (state.summary?.status !== "pending") return;
			await dispatch(rt, { type: "SUMMARY_DISPATCHED" });
			if (rt.controller === active && active.state.phase === "summarizing" && active.state.summary?.status === "awaiting_start")
				deliverSummary(rt, active, active.state);
			return;
		case "awaiting_fix":
			if (state.repair?.status === "completed") return dispatch(rt, { type: "ADVANCE" });
			if (state.repair?.status !== "pending") return;
			await dispatch(rt, { type: "FEEDBACK_DISPATCHED" });
			if (rt.controller === active && active.state.repair?.status === "awaiting_start")
				deliverFeedback(rt, active, active.state.repair);
			return;
	}
}

function startAction(
	rt: ReviewRuntime,
	active: Controller,
	key: string,
	kind: "reviewer" | "advisor",
	run: (signal: AbortSignal) => Promise<void>,
): void {
	if (active.action?.key === key) return;
	const abort = new AbortController();
	const done: Promise<void> = run(abort.signal)
		.catch(async (error) => {
			if (rt.controller !== active || abort.signal.aborted) return;
			await dispatch(rt, { type: "INFRASTRUCTURE_ERROR", details: sessionErrorText(kind, error) });
		})
		.finally(() => {
			if (active.action?.done === done) active.action = undefined;
		});
	active.action = { key, abort, done };
}

/** 停止此刻在途的审查会话，并让后续的推进请求失效。 */
function stopWork(active: Controller): void {
	active.cancelled = true;
	active.action?.abort.abort();
}

/** 会话离开当前运行时：取消并等待审查会话退出，quit 落终态，其余保留 checkpoint 给新运行时恢复。
 * 收口后清空 controller——宿主随后 dispose 会作废 ctx，迟到回调看到空 controller 直接返回。 */
async function handleShutdown(
	rt: ReviewRuntime,
	reason: "quit" | "reload" | "new" | "resume" | "fork",
	ctx: ExtensionContext,
): Promise<void> {
	const active = rt.controller;
	if (!active) return;
	// 会话离开当前运行时就立即释放；reload 恢复会由新 controller 重新配对喊占用。
	setOccupancy(rt, active, false);
	// 无论何种终止都先取消并等待当前审查会话；旧动作不得泄漏到新运行时。
	stopWork(active);
	clearWatchdog(active);
	clearStartTimer(active);
	await active.action?.done;
	active.ctx = ctx;
	if (reason === "quit") await dispatch(rt, { type: "CANCEL", reason: "shutdown" });
	else {
		active.ui.clear(active.ctx);
		await rt.queue;
	}
	if (rt.controller === active) rt.controller = undefined;
}

function armWatchdog(rt: ReviewRuntime) {
	const active = rt.controller;
	if (!active) return;
	clearWatchdog(active);
	const elapsed = active.state.startedAt ? Math.max(0, Date.now() - active.state.startedAt) : 0;
	const remaining = Math.max(0, overallTimeoutMs(active.config) - elapsed);
	if (remaining === 0) {
		stopWork(active);
		void dispatch(rt, { type: "TIMEOUT" });
		return;
	}
	active.watchdog = setTimeout(() => {
		if (rt.controller !== active || !isActive(active.state)) return;
		stopWork(active);
		void dispatch(rt, { type: "TIMEOUT" });
	}, remaining);
	active.watchdog.unref?.();
}

function clearWatchdog(active: Controller) {
	if (active.watchdog) clearTimeout(active.watchdog);
}

function clearStartTimer(active: Controller): void {
	if (active.startTimer) clearTimeout(active.startTimer);
	active.startTimer = undefined;
}

// ---- 持久化 ----

/** 返回是否已可靠落盘；false 时调用方必须停下本次迁移的副作用。 */
function persist(rt: ReviewRuntime, state: ReviewState): boolean {
	const active = rt.controller;
	if (!active) return false;
	const persisted = active.persistedStamp;
	if (persisted === undefined) return false; // 冲突或写入失败后停写
	try {
		active.persistedStamp =
			persisted === null
				? beginCheckpoint(rt.pi, state)
				: writeCheckpoint(rt.pi, active.ctx, state, persisted);
		return true;
	} catch (error) {
		haltOnPersistFailure(rt, active, state, error);
		return false;
	}
}

/** 冲突与写入失败共用的收口：停写、释放占用、中止在途动作并告知。 */
function haltOnPersistFailure(rt: ReviewRuntime, active: Controller, state: ReviewState, error: unknown): void {
	setOccupancy(rt, active, false);
	active.persistedStamp = undefined;
	stopWork(active);
	if (error instanceof CheckpointConflictError) {
		// 持久化里出现不是本 controller 写的 Run ID：并发冲突，停止审查。
		notify(active, msg.notify.checkpointConflict, "warning");
		void dispatch(rt, { type: "CANCEL", reason: "shutdown" });
		return;
	}
	// 普通写入失败（如会话落盘异常）：停掉本场审查，不带着不一致状态继续跑。
	notify(active, msg.notify.checkpointWriteFailed(errorText(error)), "error");
	active.ui.clear(active.ctx);
	// 磁盘上可能还留着上一条活动 checkpoint，重启会把它恢复成幽灵审查：
	// 尽力补写一条终态。写不进去时不假装成功，在通知里告知用户。
	let sealed = true;
	try {
		sealCheckpoint(rt.pi, state);
	} catch {
		sealed = false;
	}
	// 内存态也必须释放：只停会话但留着活动态 controller，会把幽灵审查从磁盘搬到内存——
	// 后续命令永远被「已有审查在进行中」挡住，且无处取消。
	clearWatchdog(active);
	clearStartTimer(active);
	rt.controller = undefined;
	if (!sealed) notify(active, msg.notify.cannotSeal, "warning");
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function syncOccupancy(rt: ReviewRuntime, active: Controller): void {
	setOccupancy(rt, active, isActive(active.state));
}

function setOccupancy(rt: ReviewRuntime, active: Controller, held: boolean): void {
	if (Boolean(active.occupancyHeld) === held) return;
	active.occupancyHeld = held;
	try {
		const payload: OccupancyPayload = held
			? { active: true, progress: () => reviewProgress(rt) }
			: { active: false };
		rt.pi.events.emit(OCCUPANCY_CHANNEL, payload);
	} catch (error) {
		// 占用信号只对齐展示；订阅方故障不能改变审查状态机或会话生命周期，通知本身也一样。
		try {
			notify(active, msg.notify.occupancyFailed(errorText(error)), "warning");
		} catch {}
	}
}

/** UI 投影：终端标题 + esc 接管，全部从当前状态派生；审查进度经占用频道由输入框外壳显示。 */
function syncUi(rt: ReviewRuntime, active: Controller): void {
	if (!isActive(active.state) || !active.ctx.hasUI) return active.ui.clear(active.ctx);
	const { phase, round } = active.state;
	// 只在等模型结论时接管编辑器；awaiting_fix 与 summarizing 相把输入交还用户。
	const canCancel = phase === "queued" || phase === "reviewing" || phase === "needs_fix";
	active.ui.show(active.ctx, round, canCancel, () => cancelByUser(rt));
}

const STAGE: Partial<Record<Phase, ReviewStage>> = {
	queued: "queued", reviewing: "reviewing", needs_fix: "advisor", awaiting_fix: "fixing", summarizing: "summarizing",
};

/** 审查进度只读 reducer 的当前状态；只有审查相的票数可数。 */
function reviewProgress(rt: ReviewRuntime): ReviewProgress | undefined {
	const state = rt.controller?.state;
	const stage = state && STAGE[state.phase];
	if (!state || !stage) return undefined;
	const reviewers = stage === "reviewing" ? state.active?.reviewers ?? [] : [];
	const count = (status: string) => reviewers.filter((reviewer) => reviewer.status === status).length;
	return { stage, round: state.round, passed: count("passed"), blocked: count("failed"), total: reviewers.length };
}

function cancelByUser(rt: ReviewRuntime) {
	const active = rt.controller;
	if (!active) return;
	if (active.state.phase === "needs_fix") {
		// 顾问阶段的 Esc 只跳过本次咨询，不取消整场审查。
		active.action?.abort.abort();
		void (active.action?.done ?? Promise.resolve()).then(() =>
			dispatch(rt, { type: "ADVISOR_SKIPPED" }),
		);
		return;
	}
	stopWork(active);
	void dispatch(rt, { type: "CANCEL", reason: "user" });
}

// ---- 副作用执行器 ----

/** reducer 只发卡、通知或请求推进；所有会启动工作的动作统一经过 idle barrier。 */
async function runEffects(rt: ReviewRuntime, effects: ReviewEffect[]) {
	for (const effect of effects) {
		const active = rt.controller;
		if (!active) return;
		if (effect.kind === "advance") requestAdvance(rt, active.ctx);
		else if (effect.kind === "notify_cancelled") notify(active, msg.notify.cancelled, "info");
		else
			try {
				sendCard(rt, active, effect.card);
			} catch (error) {
				notifyEffectFailure(rt, error);
			}
	}
}

function modelConfig(atom: ModelAtom, config: ReviewConfig): ReviewModelConfig {
	return {
		model: atom.model,
		thinking: atom.thinking,
		tools: config.tools,
		timeoutMs: config.timeoutMinutes * 60_000,
	};
}

/** 开审那一刻取会话分支快照构造 prompt，所有审查者共用同一 prompt。 */
async function startReviewers(rt: ReviewRuntime, active: Controller, signal: AbortSignal): Promise<void> {
	const { state, config } = active;
	if (!state.active) return;
	const evidence = buildEvidence(sessionEntries(active), { sessionFile: active.ctx.sessionManager.getSessionFile() });
	const prompt = buildReviewPrompt(readPrompt(PROMPTS, "review"), {
		scope: msg.command.scope,
		focus: state.focus,
		evidence,
		history: state.history,
		round: state.round,
	});
	const tasks = state.active.reviewers
		.filter((reviewer) => reviewer.status === "running")
		.map(async (reviewer) => {
			try {
				const result = await runReviewer({
					index: reviewer.index,
					config: modelConfig(reviewer, config),
					prompt,
					cwd: active.ctx.cwd,
					signal,
					runSession: rt.runSession,
				});
				if (!signal.aborted)
					await dispatch(rt, { type: "REVIEWER_SETTLED", index: result.index, result });
			} catch (error) {
				if (signal.aborted) return;
				await dispatch(rt, {
					type: "REVIEWER_SETTLED",
					index: reviewer.index,
					result: {
						index: reviewer.index,
						model: reviewer.model,
						thinking: reviewer.thinking,
						status: "error",
						summary: "",
						details: sessionErrorText("reviewer", error),
					},
				});
			}
		});
	await Promise.all(tasks);
}

async function consultAdvisor(rt: ReviewRuntime, active: Controller, signal: AbortSignal): Promise<void> {
	const { state, config } = active;
	if (!state.pending) return;
	const prompt = buildAdvisorPrompt(readPrompt(PROMPTS, "advisor"), {
		focus: state.focus,
		details: state.pending.details,
		history: state.history,
		round: state.pending.round,
	});
	try {
		const result = await runAdvisor({
			config: modelConfig(config.advisor, config),
			prompt,
			cwd: active.ctx.cwd,
			signal,
			runSession: rt.runSession,
		});
		if (!signal.aborted) await dispatch(rt, { type: "ADVISOR_SETTLED", result });
	} catch (error) {
		if (signal.aborted) return;
		await dispatch(rt, { type: "INFRASTRUCTURE_ERROR", details: sessionErrorText("advisor", error) });
	}
}

function sessionErrorText(kind: "reviewer" | "advisor", error: unknown) {
	const reason = errorText(error);
	return kind === "reviewer" ? msg.failure.reviewerSession(reason) : msg.failure.advisorSession(reason);
}

/**
 * 修复反馈与总结提示共用的投递：display:false 的消息进 LLM 上下文但不渲染，triggerTurn 让执行模型开回合；
 * sendMessage 返回 void，真实异步失败不会进 try/catch，所以持久化状态等 agent_start 回执，超时即视为没启动。
 */
function sendFollowUp(
	rt: ReviewRuntime,
	active: Controller,
	customType: string,
	content: string,
	handlers: { stillAwaiting: (state: ReviewState) => boolean; onNotStarted: () => void; onSendError: (error: unknown) => void },
): void {
	clearStartTimer(active);
	active.startTimer = setTimeout(() => {
		if (rt.controller !== active || !handlers.stillAwaiting(active.state)) return;
		active.startTimer = undefined;
		handlers.onNotStarted();
	}, FOLLOW_UP_START_TIMEOUT_MS);
	active.startTimer.unref?.();
	try {
		rt.pi.sendMessage({ customType, content, display: false }, { deliverAs: "followUp", triggerTurn: true });
	} catch (error) {
		clearStartTimer(active);
		handlers.onSendError(error);
	}
}

function deliverFeedback(rt: ReviewRuntime, active: Controller, repair: NonNullable<ReviewState["repair"]>): void {
	sendFollowUp(rt, active, FEEDBACK_TYPE, buildFixFeedback(repair), {
		stillAwaiting: (state) => state.phase === "awaiting_fix" && state.repair?.status === "awaiting_start",
		onNotStarted: () => {
			notify(active, msg.notify.feedbackNotStarted, "error");
			stopWork(active);
			void dispatch(rt, { type: "CANCEL", reason: "user" });
		},
		// 同步失败交给 requestAdvance 的收口：通知、中止、取消。
		onSendError: (error) => { throw error; },
	});
}

/** 总结是尽力而非必须：投递失败或没能启动回合都静默收尾，裁决与结果卡已落地。 */
function deliverSummary(rt: ReviewRuntime, active: Controller, state: ReviewState): void {
	if (!state.summary) return;
	const last = state.history.at(-1);
	const material = state.summary.kind === "advisor_stop"
		? last?.advisor?.advice ?? last?.details ?? ""
		: last?.details ?? "";
	const prompt = buildSummaryPrompt({ kind: state.summary.kind, rounds: state.history.length, material });
	sendFollowUp(rt, active, SUMMARY_REQUEST_TYPE, prompt, {
		stillAwaiting: (current) => current.phase === "summarizing" && current.summary?.status === "awaiting_start",
		onNotStarted: () => {
			notify(active, msg.notify.summaryNotStarted, "warning");
			void dispatch(rt, { type: "SUMMARY_SETTLED" });
		},
		onSendError: (error) => {
			notifyEffectFailure(rt, error);
			void dispatch(rt, { type: "SUMMARY_SETTLED" });
		},
	});
}

function sendCard(rt: ReviewRuntime, active: Controller, card: CardData) {
	// 宿主在 streaming 时会把无 options 的 sendMessage 当 steer 塞进当前模型回合。
	// 卡片只是 UI 投影，绝不能因此唤醒或打断执行模型。
	if (!active.ctx.isIdle()) {
		active.pendingCards.push(card);
		return;
	}
	sendCardNow(rt, card);
}

function flushPendingCards(rt: ReviewRuntime): void {
	const active = rt.controller;
	if (!active || !active.ctx.isIdle() || active.pendingCards.length === 0) return;
	for (const card of active.pendingCards.splice(0)) {
		try {
			sendCardNow(rt, card);
		} catch (error) {
			notifyEffectFailure(rt, error);
		}
	}
}

function sendCardNow(rt: ReviewRuntime, card: CardData): void {
	const built = buildCard(card);
	rt.pi.sendMessage({
		customType: CARD_TYPE,
		content: wrapEnvelope("firecode_review", built.content),
		display: true,
		details: built.details,
	});
}

/** 会话分支 entries（供证据组装）；本插件的卡与反馈消息不参与证据，避免自指。 */
function sessionEntries(active: Controller) {
	const own = new Set([CARD_TYPE, FEEDBACK_TYPE, SUMMARY_REQUEST_TYPE]);
	return active.ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type !== "custom_message" || !own.has(entry.customType));
}
