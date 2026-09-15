/**
 * /fire-review：对抗性审查插件的执行器与入口。
 *
 * 职责分界：
 * - 领域状态只活在纯 reducer（state.ts）里，所有迁移经 reduce() 计算；
 *   本文件是唯一执行器，只做副作用（起审查会话、投递反馈、发卡、持久化、活动条），
 *   会话结果一律回灌成事件交给 reducer。
 * - 运行时状态按会话隔离：pi 在同一进程内对同一 cwd 复用扩展模块实例，主会话与每个
 *   Worker 子会话共用本文件；`registerReview(pi)` 各自持有一份 ReviewRuntime，模块级不留
 *   任何会话状态，一个会话被 dispose 不会拖累另一个。
 * - 渲染器在此顶层无条件注册（不懒加载），live 与 reload 外观一致。
 */
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type Language, type ReviewConfig } from "../config.js";
import { herdrPaneEnv, herdrRequest } from "../herdr-client.js";
import { InProcessSessionPool } from "../master/spawn.js";
import { buildCard, CARD_TYPE, decisionText, registerCardRenderer } from "./card.js";
import {
	beginCheckpoint,
	CHECKPOINT_TYPE,
	CheckpointConflictError,
	type CheckpointStamp,
	readCheckpoint,
	readStamp,
	writeCheckpoint,
} from "./checkpoint.js";
import { buildEvidence } from "./evidence.js";
import {
	applySessionEvent,
	initialProgress,
	type ReviewerProgress,
	settleProgress,
} from "./progress.js";
import {
	type ActivityView,
	hideActivity,
	lockEditor,
	showActivity,
	unlockEditor,
} from "./ui.js";
import { REVIEW_OCCUPANCY_LABEL as OCCUPANCY_LABEL } from "./outcome.js";
import { buildAdvisorPrompt, buildFixFeedback, buildReviewPrompt, buildSummaryPrompt, readPrompt, reviewEnvelope } from "./prompt.js";
import { runAdvisor } from "./advisor.js";
import { runReviewer, type ReviewModelConfig } from "./reviewer.js";
import { createReviewSessionRunner, type ReviewSessionRunner } from "./session.js";
import {
	type AdvisorResult,
	type CardData,
	type ReviewEffect,
	type ReviewEvent,
	type ReviewLimits,
	type ReviewState,
	initialState,
	reduce,
} from "./state.js";

export const FEEDBACK_TYPE = "firecode-review-feedback";
/** 总结回合提示：与修复反馈同通道（进上下文不渲染），不参与证据自指。 */
export const SUMMARY_REQUEST_TYPE = "firecode-review-summary";
const OCCUPANCY_CHANNEL = "herdr:blocked";
const OCCUPANCY_SOURCE = "firecode-review";
/** herdr 按 seq 丢弃过期上报；同一 source 单调递增。 */
let occupancySeq = Date.now() * 1000;
/** 标签租约：TTL 要容得下至少两次续约失败，否则瞬断会让 Master 误读。 */
const OCCUPANCY_TTL_MS = 60_000;
const OCCUPANCY_REFRESH_MS = 20_000;
/** sendMessage 没有 Promise/错误回调；用 agent_start 作为反馈已启动的回执。 */
const FEEDBACK_START_TIMEOUT_MS = 2_000;
/** 总体超时：maxRounds 轮 × 每轮 2 倍单进程超时，最低 30 分钟。 */
function overallTimeoutMs(config: ReviewConfig) {
	return Math.max(
		30 * 60_000,
		config.maxRounds * config.timeoutMinutes * 2 * 60_000,
	);
}

function isActive(state: ReviewState) {
	return (
		state.phase === "queued" ||
		state.phase === "reviewing" ||
		state.phase === "needs_fix" ||
		state.phase === "awaiting_fix" ||
		// 总结回合仍属审查生命周期：占用标签持有到总结完成，Master 才不会在
		// 结果卡与总结之间的窗口提前结算、漏掉总结回复。
		state.phase === "summarizing"
	);
}

interface Controller {
	ctx: ExtensionContext;
	config: ReviewConfig;
	state: ReviewState;
	signal: AbortController;
	watchdog: ReturnType<typeof setTimeout> | undefined;
	/** 本 controller 上一次写入的凭证；null=本审查还没写过，undefined=冲突/失败后停写。 */
	persistedStamp: CheckpointStamp | null | undefined;
	/** streaming 时 sendMessage 会变成 steer；展示卡必须等 settled 后再发。 */
	pendingCards: CardData[];
	/** 本运行时已启动的阶段；reload 后新 controller 会重启被中断的审查会话。 */
	runningAction?: string;
	/** 当前审查者/顾问任务；执行模型 agent_start 必须 await 它退出后才能继续。 */
	actionPromise?: Promise<void>;
	actionController?: AbortController;
	/** 反馈 sendMessage 已调用，等待 agent_start 回执。 */
	feedbackStartTimer?: ReturnType<typeof setTimeout>;
	/** 审查会话实时进度：纯 UI 态，高频更新，不入 checkpoint。 */
	progress: readonly ReviewerProgress[];
	/** 当前 progress 属于审查者还是顾问：修复相据此决定是否展示裁决摘要。 */
	progressKind?: "reviewers" | "advisor";
	/** 编辑器是否已被审查接管（禁输入 + esc 取消）。 */
	editorLocked?: boolean;
	/** Herdr blocked 频道采用计数语义，每个 true 必须由同一 controller 配对 false。 */
	occupancyHeld?: boolean;
	/** 占用标签租约续期计时器；释放与 shutdown 时清除。 */
	occupancyTimer?: ReturnType<typeof setInterval>;
}

/** 一个会话的审查运行时：controller 是当前这场审查，queue 串行化它的状态迁移。 */
interface ReviewRuntime {
	readonly pi: ExtensionAPI;
	readonly runSession: ReviewSessionRunner;
	controller: Controller | undefined;
	queue: Promise<void>;
}

interface ReviewDependencies {
	pool?: InProcessSessionPool;
	resolveModel?: (id: string) => Promise<Model<any>>;
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
		runSession: dependencies.runSession ?? createReviewSessionRunner(
			dependencies.pool ?? new InProcessSessionPool(),
			dependencies.resolveModel ?? resolveConfiguredModel,
		),
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
		description: "对抗性审查：审这个会话到目前为止做完的事",
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

function settleDisabledCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	settleUnavailableCheckpoint(pi, ctx, checkpoint);
}

function settleUnavailableCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	checkpoint: ReviewState,
): void {
	try {
		beginCheckpoint(pi, ctx, {
			...checkpoint,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			summary: null,
			updatedAt: Date.now(),
		});
	} catch (error) {
		if (ctx.hasUI)
			ctx.ui.notify(`fire-review 无法收口旧 checkpoint：${errorText(error)}`, "error");
	}
}

/** 串行化状态迁移：reducer 同步执行，副作用排队；同一时刻只有一个迁移在跑。
 * 返回队尾 Promise，让 pi 的事件处理器（session_shutdown 等）可 await 持久化落盘。 */
function dispatch(rt: ReviewRuntime, event: ReviewEvent): Promise<void> {
	const run = rt.queue.then(async () => {
		const active = rt.controller;
		if (!active) return;
		const { state, effects } = reduce(active.state, event, limitsOf(active.config), Date.now());
		if (state !== active.state) {
			active.state = state;
			// 持久化失败不能当成功继续：否则会拿不一致的状态去起会话、投反馈，
			// 重启后又从旧 checkpoint 恢复，重现幽灵审查与重复反馈。
			if (!persist(rt, state)) return;
			if (!isActive(state)) clearWatchdog(rt);
			syncOccupancy(rt, active);
			syncUi(rt);
		}
		await runEffects(rt, effects);
	});
	// 队列一旦 rejected 就再也不会执行后续迁移（连 esc 取消也会失效）：
	// 副作用异常只能到此为止，不得杀死状态机。
	rt.queue = run.catch((error) => {
		notifyEffectFailure(rt, error);
	});
	return rt.queue;
}

function notifyEffectFailure(rt: ReviewRuntime, error: unknown) {
	const active = rt.controller;
	if (!active?.ctx.hasUI) return;
	const message = error instanceof Error ? error.message : String(error);
	active.ctx.ui.notify(
		active.config.language === "en"
			? `fire-review step failed: ${message}`
			: `fire-review 步骤失败：${message}`,
		"warning",
	);
}

/**
 * 读 review 配置；存在配置问题就不交出可用配置。
 * 命令与恢复两个入口共用：任何一个静默回退默认模型都会花真钱跑错模型。
 */
function loadReviewConfig(): { config: ReviewConfig } | { error: string } {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return {
			error: `fire-review 配置读取失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	// 三类都必须阻断：文件整体解析不了、review 节自身有错、
	// 以及 features.review 开关类型错（字符串 "false" 会因 `!== false` 静默启用付费审查）。
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("review") ||
			problem.startsWith("未知字段 review.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0)
		return { error: `fire-review 配置有问题，已停止：${problems.join("；")}` };
	if (!loaded.config.review.advisor.model || loaded.config.review.reviewers.length === 0)
		return { error: "fire-review 配置有问题，已停止：请显式完整配置 review" };
	return { config: loaded.config.review };
}

function limitsOf(config: ReviewConfig): ReviewLimits {
	return {
		maxRounds: config.maxRounds,
		advisorAfterFailures: config.advisorAfterFailures,
		advisorModel: config.advisor.model,
		language: config.language,
		reviewers: config.reviewers.map((item) => ({
			model: item.model,
			thinking: item.thinking,
		})),
	};
}

async function handleCommand(rt: ReviewRuntime, args: string, ctx: ExtensionContext) {
	// 配置解析失败不能让命令无声失败：pi 会捕获 handler 异常，用户只会看到什么都没发生。
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		if (ctx.hasUI) ctx.ui.notify(loaded.error, "error");
		return;
	}
	const config = loaded.config;
	if (rt.controller && isActive(rt.controller.state)) {
		if (ctx.hasUI) ctx.ui.notify(
			config.language === "en"
				? "A review is already running."
				: "已有审查在进行中。",
			"info",
		);
		return;
	}
	const command = parseCommand(args, config.language);
	if ("error" in command) {
		if (ctx.hasUI) ctx.ui.notify(command.error, "error");
		return;
	}
	rt.controller = {
		ctx,
		config,
		state: initialState(randomUUID()),
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: null,
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog(rt);
	// 命令入口也只提出推进请求；真正开审统一经过下一 event-loop 的 idle barrier.
	void dispatch(rt, {
		type: "START",
		focus: command.focus,
		busy: true,
	});
}

/** 重启 / 会话恢复：从 checkpoint 重建 controller 并续跑未完成的环节。
 * reload / new / resume / fork 是运行时替换（新 pi、新 runtime），旧 runtime 已在
 * session_shutdown 收口；这里只按新会话的 checkpoint 恢复，quit 之外不 settle。 */
function handleSessionStart(rt: ReviewRuntime, ctx: ExtensionContext): Promise<void> | void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		// session_start 的配置告警由入口统一聚合；这里只保留活动 checkpoint，修好后继续。
		return;
	}
	const config = loaded.config;
	rt.controller = {
		ctx,
		config,
		state: checkpoint,
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: readStamp(ctx),
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog(rt);
	syncOccupancy(rt, rt.controller);
	syncUi(rt);
	// 恢复只更新持久状态并提出推进请求；绝不在 session_start handler 内起任何工作。
	return dispatch(rt, { type: "RECOVER" });
}

async function handleAgentStart(rt: ReviewRuntime): Promise<void> {
	const active = rt.controller;
	if (!active) return;
	if (
		active.state.phase === "awaiting_fix" &&
		active.state.repair?.status === "awaiting_start"
	) {
		clearFeedbackStartTimer(active);
		await dispatch(rt, { type: "REPAIR_STARTED" });
		return;
	}
	if (
		active.state.phase === "summarizing" &&
		active.state.summary?.status === "awaiting_start"
	) {
		clearFeedbackStartTimer(active);
		await dispatch(rt, { type: "SUMMARY_STARTED" });
		return;
	}
	// 其他扩展可在我们排队后异步触发执行模型。agent_start 是宿主提供的硬边界：
	// 宿主会 await 本 handler，因此先 abort 并等所有审查会话真正退出，再允许模型 turn_start。
	if (!active.actionPromise) return;
	active.actionController?.abort();
	await active.actionPromise;
	if (rt.controller !== active || !isActive(active.state)) return;
	active.runningAction = undefined;
	active.actionPromise = undefined;
}

function handleAgentEnd(rt: ReviewRuntime, event: { messages: readonly unknown[] }): Promise<void> | void {
	const active = rt.controller;
	if (!active) return;
	// 总结回合任何结局都收尾：裁决已落地，总结失败/中断不重试不升级。
	if (active.state.phase === "summarizing" && active.state.summary?.status === "running")
		return dispatch(rt, { type: "SUMMARY_SETTLED" });
	if (
		active.state.phase !== "awaiting_fix" ||
		active.state.repair?.status !== "running"
	) return;
	const assistant = [...event.messages]
		.reverse()
		.find((message) => isRecord(message) && message.role === "assistant");
	if (isRecord(assistant) && assistant.stopReason !== "error" && assistant.stopReason !== "aborted")
		return dispatch(rt, { type: "REPAIR_COMPLETED" });
	active.signal.abort();
	return dispatch(rt, { type: "CANCEL", reason: "user" });
}

function requestAdvance(rt: ReviewRuntime, ctx: ExtensionContext): void {
	const active = rt.controller;
	if (!active) return;
	const runId = active.state.runId;
	void advanceWhenIdle(rt, ctx, runId).catch((error) => {
		notifyEffectFailure(rt, error);
		if (rt.controller !== active) return;
		active.signal.abort();
		void dispatch(rt, { type: "CANCEL", reason: "user" });
	});
}

async function advanceWhenIdle(rt: ReviewRuntime, ctx: ExtensionContext, runId: string): Promise<void> {
	const active = rt.controller;
	// 所有启动入口共享 idle 门；正确性另由 agent_start 的同步停审互锁保证。
	if (
		!active ||
		active.state.runId !== runId ||
		active.signal.signal.aborted ||
		!ctx.isIdle() ||
		ctx.hasPendingMessages()
	) return;
	active.ctx = ctx;
	flushPendingCards(rt);
	const { state } = active;
	if (state.phase === "queued") {
		await dispatch(rt, { type: "ADVANCE" });
		return;
	}
	if (state.phase === "reviewing") {
		startAction(rt, active, `review:${state.round}`, "reviewer", () => startReviewers(rt));
		return;
	}
	if (state.phase === "needs_fix") {
		startAction(rt, active, `advisor:${state.round}`, "advisor", () => consultAdvisor(rt));
		return;
	}
	if (state.phase === "summarizing") {
		if (state.summary?.status !== "pending") return;
		await dispatch(rt, { type: "SUMMARY_DISPATCHED" });
		const current = rt.controller?.state;
		if (rt.controller === active && current?.phase === "summarizing" && current.summary?.status === "awaiting_start")
			deliverSummaryNow(rt, current);
		return;
	}
	if (state.phase !== "awaiting_fix" || !state.repair) return;
	if (state.repair.status === "pending") {
		await dispatch(rt, { type: "FEEDBACK_DISPATCHED" });
		const repair = rt.controller?.state.repair;
		if (rt.controller === active && repair?.status === "awaiting_start")
			deliverFeedbackNow(rt, repair.details, repair.advisor);
		return;
	}
	if (state.repair.status === "completed") await dispatch(rt, { type: "ADVANCE" });
}

function startAction(
	rt: ReviewRuntime,
	active: Controller,
	key: string,
	kind: "reviewer" | "advisor",
	run: () => Promise<void>,
): void {
	if (active.runningAction === key) return;
	active.runningAction = key;
	active.actionController = new AbortController();
	const action = run()
		.catch(async (error) => {
			if (rt.controller !== active || active.actionController?.signal.aborted) return;
			await dispatch(rt, {
				type: "INFRASTRUCTURE_ERROR",
				details: sessionErrorText(kind, active.config.language, error),
			});
		})
		.finally(() => {
			if (active.actionPromise !== action) return;
			active.actionPromise = undefined;
			active.actionController = undefined;
			active.runningAction = undefined;
		});
	active.actionPromise = action;
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
	active.signal.abort();
	active.actionController?.abort();
	clearWatchdog(rt);
	clearFeedbackStartTimer(active);
	await active.actionPromise;
	if (active.ctx !== ctx) active.ctx = ctx;
	if (reason === "quit") await dispatch(rt, { type: "CANCEL", reason: "shutdown" });
	else {
		hideActivity(active.ctx);
		releaseEditor(active);
		await rt.queue;
	}
	if (rt.controller === active) rt.controller = undefined;
}

function armWatchdog(rt: ReviewRuntime) {
	const active = rt.controller;
	if (!active) return;
	clearWatchdog(rt);
	const elapsed = active.state.startedAt ? Math.max(0, Date.now() - active.state.startedAt) : 0;
	const remaining = Math.max(0, overallTimeoutMs(active.config) - elapsed);
	if (remaining === 0) {
		active.signal.abort();
		void dispatch(rt, { type: "TIMEOUT" });
		return;
	}
	active.watchdog = setTimeout(() => {
		if (rt.controller !== active || !isActive(active.state)) return;
		active.signal.abort();
		active.actionController?.abort();
		dispatch(rt, { type: "TIMEOUT" });
	}, remaining);
	active.watchdog.unref?.();
}

function clearWatchdog(rt: ReviewRuntime) {
	if (rt.controller?.watchdog) clearTimeout(rt.controller.watchdog);
}

function clearFeedbackStartTimer(active: Controller): void {
	if (active.feedbackStartTimer) clearTimeout(active.feedbackStartTimer);
	active.feedbackStartTimer = undefined;
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
				? beginCheckpoint(rt.pi, active.ctx, state)
				: writeCheckpoint(rt.pi, active.ctx, state, persisted);
		return true;
	} catch (error) {
		if (error instanceof CheckpointConflictError) {
			// 持久化里出现不是本 controller 写的 Run ID：并发冲突，停止审查。
			setOccupancy(rt, active, false);
			active.persistedStamp = undefined;
			active.signal.abort();
			active.actionController?.abort();
			if (active.ctx.hasUI)
				active.ctx.ui.notify(
					active.config.language === "en"
						? "fire-review checkpoint conflict; review stopped."
						: "fire-review checkpoint 冲突，已停止审查。",
					"warning",
				);
			void dispatch(rt, { type: "CANCEL", reason: "shutdown" });
			return false;
		}
		// 普通写入失败（如会话落盘异常）：停掉本场审查，不带着不一致状态继续跑。
		setOccupancy(rt, active, false);
		active.persistedStamp = undefined;
		active.signal.abort();
		active.actionController?.abort();
		if (active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? `fire-review checkpoint write failed; review stopped: ${errorText(error)}`
					: `fire-review checkpoint 写入失败，已停止审查：${errorText(error)}`,
				"error",
			);
		releaseEditor(active);
		hideActivity(active.ctx);
		// 磁盘上可能还留着上一条活动 checkpoint，重启会把它恢复成幽灵审查：
		// 尽力补写一条终态。写不进去时不假装成功，在通知里告知用户。
		let sealed = true;
		try {
			beginCheckpoint(rt.pi, active.ctx, {
				...state,
				phase: "settled",
				active: null,
				pending: null,
				repair: null,
				summary: null,
			});
		} catch {
			sealed = false;
		}
		// 内存态也必须释放：只停会话但留着活动态 controller，会把幽灵审查从磁盘搬到内存——
		// 后续命令永远被「已有审查在进行中」挡住，且无处取消。
		clearWatchdog(rt);
		clearFeedbackStartTimer(active);
		rt.controller = undefined;
		if (!sealed && active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "fire-review could not seal the checkpoint; a restart may resume this review — cancel it with esc."
					: "fire-review 无法写入终态，重启后可能恢复这场审查，到时按 esc 取消。",
				"warning",
			);
		return false;
	}
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function syncOccupancy(rt: ReviewRuntime, active: Controller): void {
	setOccupancy(rt, active, isActive(active.state));
}

/**
 * 标签租约：持有期带 TTL 定时续约，释放时清除失败重试一次、再失败由 TTL 到期兜底。
 * 定时续约是租约业务语义：herdr 没有“进程退出即清 metadata”的接口（源码核实），
 * crash/kill 后无 TTL 的标签永驻会让 Master 把 Worker 的真提问误判为审查占用；
 * 续约同时充当首次投递失败的重试。
 */
function publishOccupancyLabel(rt: ReviewRuntime, active: Controller, held: boolean): void {
	if (held) {
		void sendOccupancyLabel();
		if (!active.occupancyTimer) {
			active.occupancyTimer = setInterval(() => void sendOccupancyLabel(), OCCUPANCY_REFRESH_MS);
			active.occupancyTimer.unref?.();
		}
		return;
	}
	if (active.occupancyTimer) {
		clearInterval(active.occupancyTimer);
		active.occupancyTimer = undefined;
	}
	void clearOccupancyLabel(rt);
}

function sendOccupancyLabel(): Promise<boolean> {
	const env = herdrPaneEnv();
	if (!env) return Promise.resolve(false);
	return herdrRequest(OCCUPANCY_SOURCE, "pane.report_metadata", {
		pane_id: env.paneId,
		source: OCCUPANCY_SOURCE,
		state_labels: { blocked: OCCUPANCY_LABEL },
		ttl_ms: OCCUPANCY_TTL_MS,
		seq: (occupancySeq += 1),
	});
}

async function clearOccupancyLabel(rt: ReviewRuntime): Promise<void> {
	const env = herdrPaneEnv();
	if (!env) return;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		// 新审查已重新持有时中止重试：迟到的清除会撤掉新租约的标签。
		if (rt.controller?.occupancyHeld) return;
		const delivered = await herdrRequest(OCCUPANCY_SOURCE, "pane.report_metadata", {
			pane_id: env.paneId,
			source: OCCUPANCY_SOURCE,
			clear_state_labels: true,
			seq: (occupancySeq += 1),
		});
		if (delivered) return;
	}
	// 两次未送达：标签带 TTL，最迟 60s 自行过期，不会永久残留。
}

function setOccupancy(rt: ReviewRuntime, active: Controller, held: boolean): void {
	if (Boolean(active.occupancyHeld) === held) return;
	active.occupancyHeld = held;
	// 标签走 metadata state_labels：herdr 会丢弃 report_agent 的 message（实测），
	// 只有这条通道能同时到达 Master（state_labels 判定）与侧边栏（state_text token）。
	// 频道仍要发：它驱动 herdr 集成的 blocked 状态本身。占用信号不伤审查。
	publishOccupancyLabel(rt, active, held);
	try {
		rt.pi.events.emit(OCCUPANCY_CHANNEL, {
			active: held,
			...(held ? { label: OCCUPANCY_LABEL } : {}),
		});
	} catch (error) {
		// 占用信号只对齐 Herdr 展示；集成故障不能改变审查状态机或会话生命周期。
		try {
			if (active.ctx.hasUI)
				active.ctx.ui.notify(`fire-review 无法同步 Herdr 占用状态：${errorText(error)}`, "warning");
		} catch {
			// 通知本身同样只是展示，不能反向打断审查。
		}
	}
}

/**
 * UI 投影：编辑器上方活动条 + esc 接管，全部从当前状态派生。
 * 活动条自己按帧重绘，因此进度变化不需要在这里通知。
 */
function syncUi(rt: ReviewRuntime): void {
	const active = rt.controller;
	if (!active) return;
	const view = () => activityView(rt);
	if (view()) {
		showActivity(active.ctx, view);
		// 只在等模型结论时接管编辑器；awaiting_fix 相把输入交还用户。
		if (canCancelWithKey(rt)) {
			if (!active.editorLocked) {
				lockEditor(active.ctx, view, () => cancelByUser(rt));
				active.editorLocked = true;
			}
		} else releaseEditor(active);
		return;
	}
	hideActivity(active.ctx);
	releaseEditor(active);
}

function releaseEditor(active: Controller) {
	if (!active.editorLocked) return;
	unlockEditor(active.ctx);
	active.editorLocked = false;
}

/** 活动条只读取当前审查状态，总结阶段由 UI 收成一行。 */
function activityView(rt: ReviewRuntime): ActivityView | undefined {
	const active = rt.controller;
	if (!active || !isActive(active.state) || !active.ctx.hasUI) return undefined;
	return {
		phase: active.state.phase,
		round: active.state.round,
		startedAt: active.state.startedAt,
		reviewers: active.progress,
		progressKind: active.progressKind,
		consecutiveFailures: active.state.consecutiveFailures,
		language: active.config.language,
	};
}

function canCancelWithKey(rt: ReviewRuntime) {
	const phase = rt.controller?.state.phase;
	return phase === "queued" || phase === "reviewing" || phase === "needs_fix";
}

function cancelByUser(rt: ReviewRuntime) {
	const active = rt.controller;
	if (!active) return;
	if (active.state.phase === "needs_fix") {
		// pi-flow 语义：顾问阶段的 Esc 只跳过本次咨询，不取消整场审查。
		active.actionController?.abort();
		void (active.actionPromise ?? Promise.resolve()).then(() =>
			dispatch(rt, { type: "ADVISOR_SKIPPED" }),
		);
		return;
	}
	active.signal.abort();
	active.actionController?.abort();
	void dispatch(rt, { type: "CANCEL", reason: "user" });
}

// ---- 副作用执行器 ----

/** reducer 只发卡或请求推进；所有会启动工作的动作统一经过 idle barrier。 */
async function runEffects(rt: ReviewRuntime, effects: ReviewEffect[]) {
	for (const effect of effects) {
		const active = rt.controller;
		if (!active) return;
		if (effect.kind === "advance") {
			requestAdvance(rt, active.ctx);
			continue;
		}
		try {
			sendCard(rt, effect.card);
		} catch (error) {
			notifyEffectFailure(rt, error);
		}
	}
}

async function resolveConfiguredModel(id: string): Promise<Model<any>> {
	const runtime = await ModelRuntime.create({
		authPath: `${getAgentDir()}/auth.json`,
		modelsPath: `${getAgentDir()}/models.json`,
	});
	const slash = id.indexOf("/");
	const model = slash > 0 ? runtime.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`找不到模型：${id}；审查会话只能使用内置 provider 的模型`);
	return model;
}

function reviewerModelConfig(model: ReviewConfig["advisor"], config: ReviewConfig): ReviewModelConfig {
	return {
		model: model.model,
		thinking: model.thinking,
		tools: config.tools,
		timeoutMs: config.timeoutMinutes * 60_000,
	};
}

/** 开审那一刻取会话分支快照构造 prompt，所有审查者共用同一 prompt。 */
async function startReviewers(rt: ReviewRuntime): Promise<void> {
	const active = rt.controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.active) return;
	const currentActive = state.active;
	const actionSignal = active.actionController?.signal ?? active.signal.signal;
	active.progressKind = "reviewers";
	active.progress = initialProgress(
		currentActive.reviewers.map((item) => ({ model: item.model })),
		config.language,
	);
	for (const reviewer of currentActive.reviewers)
		if (reviewer.status !== "running" && reviewer.result)
			active.progress = settleProgress(
				active.progress,
				reviewer.index,
				reviewer.status,
				config.language,
				reviewer.result.summary,
				reviewer.result.details,
			);
	const evidence = buildEvidence(sessionEntries(rt), config.language);
	const prompt = buildReviewPrompt(readPrompt("review", config.language), {
		language: config.language,
		scope: scopeText(config.language),
		focus: state.focus,
		evidence: evidence.text,
		history: state.history,
		round: state.round,
	});
	const tasks = currentActive.reviewers
		.filter((reviewer) => reviewer.status === "running")
		.map(async (reviewer) => {
			try {
				const result = await runReviewer({
					index: reviewer.index,
					config: reviewerModelConfig(reviewer, config),
					prompt,
					cwd: active.ctx.cwd,
					language: config.language,
					signal: actionSignal,
					runSession: rt.runSession,
					onEvent: (event) => {
						if (rt.controller !== active) return;
						active.progress = applySessionEvent(
							active.progress,
							reviewer.index,
							event,
							config.language,
						);
					},
				});
				if (rt.controller === active)
					active.progress = settleProgress(
						active.progress,
						result.index,
						result.status,
						config.language,
						result.summary,
						result.details,
					);
				if (!actionSignal.aborted)
					await dispatch(rt, { type: "REVIEWER_SETTLED", index: result.index, result });
			} catch (error) {
				if (actionSignal.aborted) return;
				await dispatch(rt, {
					type: "REVIEWER_SETTLED",
					index: reviewer.index,
					result: {
						index: reviewer.index,
						model: reviewer.model,
						thinking: reviewer.thinking,
						status: "error",
						summary: "",
						details: sessionErrorText("reviewer", active.config.language, error),
					},
				});
			}
		});
	await Promise.all(tasks);
}

async function consultAdvisor(rt: ReviewRuntime): Promise<void> {
	const active = rt.controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.pending) return;
	const pending = state.pending;
	const actionSignal = active.actionController?.signal ?? active.signal.signal;
	active.progressKind = "advisor";
	active.progress = initialProgress([{ model: config.advisor.model }], config.language);
	const prompt = buildAdvisorPrompt(readPrompt("advisor", config.language), {
		language: config.language,
		focus: state.focus,
		details: pending.details,
		history: state.history,
		round: pending.round,
	});
	try {
		const result = await runAdvisor({
			config: reviewerModelConfig(config.advisor, config),
			prompt,
			cwd: active.ctx.cwd,
			language: config.language,
			signal: actionSignal,
			runSession: rt.runSession,
			onEvent: (event) => {
				if (rt.controller !== active) return;
				active.progress = applySessionEvent(active.progress, 0, event, config.language);
			},
		});
		if (rt.controller === active)
			active.progress = settleProgress(
				active.progress,
				0,
				"passed",
				config.language,
				advisorSummary(result, config.language),
				result.advice,
			);
		if (!actionSignal.aborted)
			await dispatch(rt, { type: "ADVISOR_SETTLED", result });
	} catch (error) {
		if (actionSignal.aborted) return;
		await dispatch(rt, {
			type: "INFRASTRUCTURE_ERROR",
			details: sessionErrorText("advisor", active.config.language, error),
		});
	}
}

/** 顾问落定后的一行摘要：裁决 + 「下一步方向」首句，与审查者摘要同一展示通道。
 * 建议正文以「核实结论」段开头，直取首行只会露出段标题星号，预览零信息量。 */
function advisorSummary(result: AdvisorResult, language: Language) {
	const label = decisionText(result.verdict, language);
	const first = adviceHighlight(result.advice);
	if (!first) return label;
	return language === "en" ? `${label}: ${first}` : `${label}：${first}`;
}

const NEXT_DIRECTION_LABEL = /^\*{0,2}(?:下一步方向|Next direction)\*{0,2}\s*[:：]\s*/iu;

function adviceHighlight(advice: string) {
	const lines = advice.split(/\r?\n/u);
	const index = lines.findIndex((line) => NEXT_DIRECTION_LABEL.test(line.trim()));
	const source = index >= 0
		? [lines[index].trim().replace(NEXT_DIRECTION_LABEL, ""), ...lines.slice(index + 1)]
		: lines;
	const first = source.map(stripBold).find((line) => line.trim())?.trim() ?? "";
	return first.replace(/^[-*+]\s*/u, "").trim();
}

function stripBold(text: string) {
	return text.replace(/\*\*([^*]+)\*\*/gu, "$1");
}

function sessionErrorText(kind: "reviewer" | "advisor", language: Language, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (kind === "reviewer")
		return language === "en" ? `reviewer session error: ${message}` : `审查会话异常：${message}`;
	return language === "en" ? `advisor session error: ${message}` : `顾问会话异常：${message}`;
}

function deliverFeedbackNow(rt: ReviewRuntime, details: string, advisor: AdvisorResult | null) {
	const active = rt.controller;
	if (!active) return;
	const feedback = buildFixFeedback({
		language: active.config.language,
		details,
		advisor,
	});
	clearFeedbackStartTimer(active);
	// API 返回 void，真实异步失败不会进 try/catch；持久化状态等待 agent_start 回执。
	active.feedbackStartTimer = setTimeout(() => {
		if (
			rt.controller !== active ||
			active.state.phase !== "awaiting_fix" ||
			active.state.repair?.status !== "awaiting_start"
		) return;
		active.feedbackStartTimer = undefined;
		if (active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "fire-review feedback did not start a repair turn; review stopped."
					: "fire-review 修复反馈未能启动回合，审查已停止。",
				"error",
			);
		active.signal.abort();
		void dispatch(rt, { type: "CANCEL", reason: "user" });
	}, FEEDBACK_START_TIMEOUT_MS);
	active.feedbackStartTimer.unref?.();
	// display:false 的消息进 LLM 上下文但不渲染；triggerTurn 让执行模型开始修复回合。
	try {
		rt.pi.sendMessage(
			{ customType: FEEDBACK_TYPE, content: feedback, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		clearFeedbackStartTimer(active);
		throw error;
	}
}

/** 总结提示投递：与修复反馈同一套 agent_start 回执机制；失败不升级，静默收尾。 */
function deliverSummaryNow(rt: ReviewRuntime, state: ReviewState): void {
	const active = rt.controller;
	if (!active || !state.summary) return;
	const last = state.history.at(-1);
	const material = state.summary.kind === "advisor_stop"
		? last?.advisor?.advice ?? last?.details ?? ""
		: last?.details ?? "";
	const prompt = buildSummaryPrompt({
		language: active.config.language,
		kind: state.summary.kind,
		rounds: state.history.length,
		material,
	});
	clearFeedbackStartTimer(active);
	active.feedbackStartTimer = setTimeout(() => {
		if (
			rt.controller !== active ||
			active.state.phase !== "summarizing" ||
			active.state.summary?.status !== "awaiting_start"
		) return;
		active.feedbackStartTimer = undefined;
		// 总结是尽力而非必须：未能启动回合就静默收尾，裁决与结果卡已落地。
		if (active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "fire-review summary turn did not start; finishing without it."
					: "fire-review 总结回合未能启动，已直接收尾。",
				"warning",
			);
		void dispatch(rt, { type: "SUMMARY_SETTLED" });
	}, FEEDBACK_START_TIMEOUT_MS);
	active.feedbackStartTimer.unref?.();
	try {
		rt.pi.sendMessage(
			{ customType: SUMMARY_REQUEST_TYPE, content: prompt, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		clearFeedbackStartTimer(active);
		notifyEffectFailure(rt, error);
		void dispatch(rt, { type: "SUMMARY_SETTLED" });
	}
}

function sendCard(rt: ReviewRuntime, card: CardData) {
	const active = rt.controller;
	if (!active) return;
	// pi-flow 的用户取消是即时临时通知，不进会话；shutdown 静默收口。
	if (card.kind === "cancel") {
		if (card.reason === "user" && active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "⏸ Review cancelled\nStopped by user"
					: "⏸ 审查已取消\n已按你的操作停止",
				"info",
			);
		return;
	}
	// 宿主在 streaming 时会把无 options 的 sendMessage 当 steer 塞进当前模型回合。
	// 卡片只是 UI 投影，绝不能因此唤醒或打断执行模型。
	if (!active.ctx.isIdle()) {
		active.pendingCards.push(card);
		return;
	}
	sendCardNow(rt, active, card);
}

function flushPendingCards(rt: ReviewRuntime): void {
	const active = rt.controller;
	if (!active || !active.ctx.isIdle() || active.pendingCards.length === 0) return;
	const cards = active.pendingCards.splice(0);
	for (const card of cards) {
		try {
			sendCardNow(rt, active, card);
		} catch (error) {
			notifyEffectFailure(rt, error);
		}
	}
}

function sendCardNow(rt: ReviewRuntime, active: Controller, card: CardData): void {
	const built = buildCard(card, active.config.language);
	rt.pi.sendMessage({
		customType: CARD_TYPE,
		content: reviewEnvelope(built.content),
		display: true,
		details: built.details,
	});
}

function parseCommand(args: string, language: Language): { focus: string } | { error: string } {
	const input = args.trim();
	return input.startsWith("--")
		? { error: language === "en" ? "Invalid fire-review arguments." : "fire-review 参数无效" }
		: { focus: input };
}

/** 会话分支 entries（供证据组装）；本插件的卡与反馈消息不参与证据，避免自指。 */
function sessionEntries(rt: ReviewRuntime) {
	const manager = rt.controller?.ctx.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	const entries = manager?.getBranch?.() ?? [];
	return entries.filter(
		(entry) =>
			!isRecord(entry) ||
			entry.type !== "custom_message" ||
			(entry.customType !== CARD_TYPE && entry.customType !== FEEDBACK_TYPE &&
				entry.customType !== SUMMARY_REQUEST_TYPE),
	);
}

function scopeText(language: Language) {
	return language === "en"
		? "Delivery quality of the current task in this conversation. The first user message is the original-request anchor; later user messages may override, narrow, or correct it."
		: "当前会话当前任务的交付质量。首条用户消息是原始需求锚点；后续用户消息可能覆盖、缩小或修正，以后者为准。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 导出供测试用（纯函数 / 类型）
export { CHECKPOINT_TYPE };
