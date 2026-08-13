/**
 * /fire-review：对抗性审查插件的执行器与入口。
 *
 * 职责分界：
 * - 领域状态只活在纯 reducer（state.ts）里，所有迁移经 reduce() 计算；
 *   本文件是唯一执行器，只做副作用（起子进程、投递反馈、发卡、持久化、状态栏），
 *   子进程结果一律回灌成事件交给 reducer。模块级只有一个 controller。
 * - 渲染器在此顶层无条件注册（不懒加载），live 与 reload 外观一致。
 */
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type Language, type ReviewConfig } from "../config.js";
import { buildCard, CARD_TYPE, registerCardRenderer } from "./card.js";
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
	applyProcessEvent,
	initialProgress,
	type ReviewerProgress,
	settleProgress,
} from "./progress.js";
import {
	type ActivityView,
	DETAILS_SHORTCUT,
	hideActivity,
	lockEditor,
	openDetails,
	showActivity,
	unlockEditor,
} from "./ui.js";
import { buildAdvisorPrompt, buildFixFeedback, buildReviewPrompt, readPrompt } from "./prompt.js";
import { runAdvisor } from "./advisor.js";
import { runReviewer, type ReviewModelConfig } from "./reviewer.js";
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
const STATUS_KEY = "fire-review";
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
		state.phase === "awaiting_fix"
	);
}

interface Controller {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: ReviewConfig;
	state: ReviewState;
	signal: AbortController;
	watchdog: ReturnType<typeof setTimeout> | undefined;
	/** 本 controller 上一次写入的凭证；null=本审查还没写过，undefined=冲突/失败后停写。 */
	persistedStamp: CheckpointStamp | null | undefined;
	/** 等 agent 完全 settled 后补投的修复反馈。 */
	pendingFeedback?: { details: string; advisor: AdvisorResult | null };
	/** streaming 时 sendMessage 会变成 steer；展示卡必须等 settled 后再发。 */
	pendingCards: CardData[];
	/** 子进程实时进度：纯 UI 态，高频更新，不入 checkpoint。 */
	progress: readonly ReviewerProgress[];
	/** 编辑器是否已被审查接管（禁输入 + esc 取消）。 */
	editorLocked?: boolean;
}

let controller: Controller | undefined;
let dispatchQueue: Promise<void> = Promise.resolve();

export function registerReview(pi: ExtensionAPI): void {
	// 渲染器顶层注册：任何 reload/冷启动路径下历史卡都走同一渲染器。
	registerCardRenderer(pi);
	pi.registerShortcut(DETAILS_SHORTCUT, {
		description: "fire-review 进度详情",
		handler: (ctx) => openDetails(ctx, activityView),
	});
	pi.registerCommand("fire-review", {
		description: "对抗性审查：审这个会话到目前为止做完的事",
		handler: (args, ctx) => handleCommand(pi, args, ctx),
	});
	pi.on("session_start", (_event, ctx) => handleSessionStart(pi, ctx));
	// agent_end 后宿主仍可能消费扩展排入的 steer/follow-up；只有 agent_settled
	// 保证本次运行及所有自动续跑都已结束，审查不能早于这个边界启动。
	pi.on("agent_settled", (_event, ctx) => handleAgentSettled(pi, ctx));
	pi.on("session_shutdown", (event, ctx) => handleShutdown(pi, event.reason, ctx));
}

/** 串行化状态迁移：reducer 同步执行，副作用排队；同一时刻只有一个迁移在跑。
 * 返回队尾 Promise，让 pi 的事件处理器（session_shutdown 等）可 await 持久化落盘。 */
function dispatch(pi: ExtensionAPI, event: ReviewEvent): Promise<void> {
	const run = dispatchQueue.then(async () => {
		if (!controller || controller.pi !== pi) return;
		const { state, effects } = reduce(
			controller.state,
			event,
			limitsOf(controller.config),
			Date.now(),
		);
		if (state !== controller.state) {
			controller.state = state;
			// 持久化失败不能当成功继续：否则会拿不一致的状态去起子进程、投反馈，
			// 重启后又从旧 checkpoint 恢复，重现幽灵审查与重复反馈。
			const persisted = persist(pi, state);
			syncUi();
			if (!persisted) return;
		}
		await runEffects(effects);
	});
	// 队列一旦 rejected 就再也不会执行后续迁移（连 esc 取消也会失效）：
	// 副作用异常只能到此为止，不得杀死状态机。
	dispatchQueue = run.catch((error) => {
		notifyEffectFailure(error);
	});
	return dispatchQueue;
}

function notifyEffectFailure(error: unknown) {
	const active = controller;
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
	// 两类都必须阻断：文件整体解析不了（此时 review 节根本没被读到），以及 review 节自身有错。
	// 三类都必须阻断：文件整体解析不了、review 节自身有错、
	// 以及 features.review 开关类型错（字符串 "false" 会因 `!== false` 静默启用付费审查）。
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("review") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features.review"),
	);
	if (problems.length > 0)
		return { error: `fire-review 配置有问题，已停止：${problems.join("；")}` };
	return { config: loaded.config.review };
}

function limitsOf(config: ReviewConfig): ReviewLimits {
	return {
		maxRounds: config.maxRounds,
		advisorAfterFailures: config.advisorAfterFailures,
		reviewers: config.reviewers.map((item) => ({
			model: item.model,
			thinking: item.thinking,
		})),
	};
}

async function handleCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
) {
	// 配置解析失败不能让命令无声失败：pi 会捕获 handler 异常，用户只会看到什么都没发生。
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		ctx.ui.notify(loaded.error, "error");
		return;
	}
	const config = loaded.config;
	if (!ctx.hasUI) {
		ctx.ui.notify(
			config.language === "en"
				? "Adversarial review requires the TUI."
				: "对抗性审查需要交互式界面。",
			"info",
		);
		return;
	}
	if (controller && isActive(controller.state)) {
		ctx.ui.notify(
			config.language === "en"
				? "A review is already running."
				: "已有审查在进行中。",
			"info",
		);
		return;
	}
	// 旧审查的看门狗必须在覆盖 controller 前停掉：它的回调读的是全局 controller，
	// 否则旧超时到点时会把新一场审查中止。
	clearWatchdog();
	controller = {
		pi,
		ctx,
		config,
		state: initialState(randomUUID()),
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: null,
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog();
	void dispatch(pi, { type: "START", focus: args.trim(), busy: !ctx.isIdle(), generation: controller.state.generation });
}

/** 重启 / 会话恢复：从 checkpoint 重建 controller 并续跑未完成的环节。
 * reload / new / resume / fork 是运行时替换（新 pi），先清掉旧 controller，
 * 再按新会话的 checkpoint 恢复；quit 之外不 settle，审查能在重启后继续。 */
function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (controller && controller.pi !== pi) controller = undefined;
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) {
		// 无待恢复的审查：终态 controller 在此清掉，避免挡住新会话的恢复。
		if (controller && !isActive(controller.state)) controller = undefined;
		return;
	}
	// 同一会话内已有活动审查时不重复恢复。
	if (controller && isActive(controller.state)) return;
	// 恢复入口与命令入口同标准：配置有问题就不能拿默认模型继续发起真实调用。
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		if (ctx.hasUI) ctx.ui.notify(loaded.error, "error");
		return;
	}
	const config = loaded.config;
	clearWatchdog();
	controller = {
		pi,
		ctx,
		config,
		state: checkpoint,
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: readStamp(ctx),
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog();
	syncUi();
	if (checkpoint.phase === "reviewing") startReviewers(pi);
	else if (checkpoint.phase === "needs_fix") consultAdvisor(pi);
	else if (ctx.isIdle())
		// queued / awaiting_fix 等的是「当前运行完全结束」，而 reload 不会产生 agent_settled：
		// session_start 已证明会话空闲，此时可按 settled 推进恢复态。
		void dispatch(pi, { type: "AGENT_END" });
}

async function handleAgentSettled(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (controller) controller.ctx = ctx;
	flushPendingCards(pi);
	// 用户审查中插话：feedback 未投就绪，先补投。这个 settled 属于插话回合，
	// 不推进审查轮次；反馈触发的修复回合 settled 后才开下一轮。
	const pending = controller?.pendingFeedback;
	if (controller && pending) {
		const active = controller;
		active.pendingFeedback = undefined;
		try {
			deliverFeedbackNow(pi, pending.details, pending.advisor);
		} catch (error) {
			notifyEffectFailure(error);
			active.signal.abort();
			await dispatch(pi, { type: "CANCEL", reason: "user" });
		}
		return;
	}
	await dispatch(pi, { type: "AGENT_END" });
}

function handleShutdown(
	pi: ExtensionAPI,
	reason: "quit" | "reload" | "new" | "resume" | "fork",
	ctx: ExtensionContext,
): Promise<void> | void {
	const active = controller;
	if (!active) return;
	// 无论何种终止都先杀子进程、停看门狗；quit 之外保留可恢复状态。
	active.signal.abort();
	clearWatchdog();
	if (active.ctx !== ctx) active.ctx = ctx;
	if (reason === "quit") {
		// 真终止：落成终态 checkpoint（await 由 pi 事件处理器保证落盘完成）。
		return dispatch(pi, { type: "CANCEL", reason: "shutdown" });
	}
	// reload / new / resume / fork：运行时替换，checkpoint 停在当前相，
	// 由随后 session_start 的恢复分支接手（重新拉起本轮未完成的子进程）。
	// UI 绑在旧 ctx 上，必须在此释放，否则旧的输入钩子会泄漏到新运行时。
	active.pendingFeedback = undefined;
	hideActivity(active.ctx);
	releaseEditor(active);
	// 等未完成的迁移落盘：reload 随后会作废旧运行时，此时未写完的 checkpoint 就丢了。
	return dispatchQueue;
}

function armWatchdog() {
	if (!controller) return;
	clearWatchdog();
	controller.watchdog = setTimeout(() => {
		const active = controller;
		if (!active || !isActive(active.state)) return;
		active.signal.abort();
		dispatch(active.pi, { type: "TIMEOUT" });
	}, overallTimeoutMs(controller.config));
	controller.watchdog.unref?.();
}

function clearWatchdog() {
	if (controller?.watchdog) clearTimeout(controller.watchdog);
}

// ---- 持久化与状态栏（状态的投影）----

/** 返回是否已可靠落盘；false 时调用方必须停下本次迁移的副作用。 */
function persist(pi: ExtensionAPI, state: ReviewState): boolean {
	if (!controller) return false;
	const persisted = controller.persistedStamp;
	if (persisted === undefined) return false; // 冲突或写入失败后停写
	try {
		controller.persistedStamp =
			persisted === null
				? beginCheckpoint(pi, controller.ctx, state)
				: writeCheckpoint(pi, controller.ctx, state, persisted);
		return true;
	} catch (error) {
		if (error instanceof CheckpointConflictError) {
			// 持久化里出现不是本 controller 写的 generation：并发冲突，停止审查。
			controller.persistedStamp = undefined;
			controller.signal.abort();
			controller.ctx.ui.notify(
				controller.config.language === "en"
					? "fire-review checkpoint conflict; review stopped."
					: "fire-review checkpoint 冲突，已停止审查。",
				"warning",
			);
			void dispatch(pi, { type: "CANCEL", reason: "shutdown" });
			return false;
		}
		// 普通写入失败（如会话落盘异常）：停掉本场审查，不带着不一致状态继续跑。
		controller.persistedStamp = undefined;
		controller.signal.abort();
		if (controller.ctx.hasUI)
			controller.ctx.ui.notify(
				controller.config.language === "en"
					? `fire-review checkpoint write failed; review stopped: ${errorText(error)}`
					: `fire-review checkpoint 写入失败，已停止审查：${errorText(error)}`,
				"error",
			);
		releaseEditor(controller);
		hideActivity(controller.ctx);
		// 磁盘上可能还留着上一条活动 checkpoint，重启会把它恢复成幽灵审查：
		// 尽力补写一条终态。写不进去时不假装成功，在通知里告知用户。
		let sealed = true;
		try {
			beginCheckpoint(pi, controller.ctx, {
				...state,
				phase: "settled",
				active: null,
				pending: null,
			});
		} catch {
			sealed = false;
		}
		// 内存态也必须释放：只停子进程但留着活动态 controller，会把幽灵审查从磁盘搬到内存——
		// 后续命令永远被「已有审查在进行中」挡住，且无处取消。
		clearWatchdog();
		const uiCtx = controller.ctx;
		const language = controller.config.language;
		if (uiCtx.hasUI) uiCtx.ui.setStatus(STATUS_KEY, undefined);
		controller = undefined;
		if (!sealed && uiCtx.hasUI)
			uiCtx.ui.notify(
				language === "en"
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

/**
 * UI 投影：状态栏一行 + 编辑器上方活动条 + esc 接管，全部从当前状态派生。
 * 活动条自己按帧重绘，因此进度变化不需要在这里通知。
 */
function syncUi(): void {
	const active = controller;
	if (!active) return;
	renderStatus(active.ctx, active.state, active.config.language);
	if (activityView()) {
		showActivity(active.ctx, activityView);
		// 只在等模型结论时接管编辑器；awaiting_fix 相把输入交还用户。
		if (canCancelWithKey()) {
			if (!active.editorLocked) {
				lockEditor(active.ctx, activityView, cancelByUser);
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

/** 活动条快照；非活动相返回 undefined（组件据此不渲染）。 */
function activityView(): ActivityView | undefined {
	const active = controller;
	if (!active || !isActive(active.state) || !active.ctx.hasUI) return undefined;
	return {
		phase: active.state.phase,
		round: active.state.round,
		focus: active.state.focus,
		roundStartedAt: active.state.roundStartedAt,
		reviewers: active.progress,
		advisorRunning: active.state.phase === "needs_fix",
		language: active.config.language,
	};
}

function canCancelWithKey() {
	const phase = controller?.state.phase;
	return phase === "queued" || phase === "reviewing" || phase === "needs_fix";
}

function cancelByUser() {
	const active = controller;
	if (!active) return;
	active.signal.abort();
	void dispatch(active.pi, { type: "CANCEL", reason: "user" });
}

function renderStatus(
	ctx: ExtensionContext,
	state: ReviewState,
	language: Language,
) {
	if (!ctx.hasUI) return;
	let text: string | undefined;
	if (state.phase === "queued")
		text = language === "en" ? "⏳ Review queued" : "⏳ 审查排队中";
	else if (state.phase === "reviewing") {
		const marks = state.active?.reviewers
			.map((item) => {
				if (item.status === "passed") return "✓";
				if (item.status === "failed") return "✗";
				if (item.status === "error") return "⚠";
				return "…";
			})
			.join(" ");
		text = language === "en"
			? `🔍 Review R${state.round} [${marks}]`
			: `🔍 审查 R${state.round} [${marks}]`;
	} else if (state.phase === "needs_fix")
		text = language === "en" ? `💭 Advisor R${state.round}` : `💭 顾问仲裁 R${state.round}`;
	else if (state.phase === "awaiting_fix")
		text = language === "en" ? `🔧 Fixing R${state.round}` : `🔧 修复中 R${state.round}`;
	else text = undefined;
	ctx.ui.setStatus(STATUS_KEY, text);
}

// ---- 副作用执行器 ----

/**
 * 逐 effect 隔离异常，但两类失败后果不同：
 * - 发卡是展示，失败只降级为通知，不能连带吞掉后面的推进动作；
 * - 起子进程 / 请顾问 / 投反馈是循环的唯一推力，它们失败后不会再有任何事件到来，
 *   只通知会把审查永久停在活动态（awaiting_fix 既等不到 agent_end，esc 也不覆盖该相），
 *   因此必须就地取消收口。
 */
async function runEffects(effects: ReviewEffect[]) {
	for (const effect of effects) {
		if (!controller) return;
		try {
			switch (effect.kind) {
				case "start_reviewers":
					startReviewers(controller.pi);
					break;
				case "consult_advisor":
					consultAdvisor(controller.pi);
					break;
				case "deliver_feedback":
					deliverFeedback(controller.pi, effect.details, effect.advisor);
					break;
				case "send_card":
					sendCard(controller.pi, effect.card);
					break;
			}
		} catch (error) {
			notifyEffectFailure(error);
			if (effect.kind !== "send_card") {
				const active = controller;
				if (!active) return;
				active.signal.abort();
				await dispatch(active.pi, { type: "CANCEL", reason: "user" });
				return;
			}
		}
	}
}

function reviewerModelConfig(model: { model: string; thinking: string }, config: ReviewConfig): ReviewModelConfig {
	return {
		model: model.model,
		thinking: model.thinking,
		command: config.background.command,
		tools: config.tools,
		timeoutMs: config.timeoutMinutes * 60_000,
	};
}

/** 开审那一刻取会话分支快照构造 prompt，所有审查者共用同一 prompt。 */
function startReviewers(pi: ExtensionAPI) {
	const active = controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.active) return;
	const currentActive = state.active;
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
			);
	const evidence = buildEvidence(sessionEntries(), config.language);
	const prompt = buildReviewPrompt(readPrompt("review", config.language), {
		language: config.language,
		scope: scopeText(config.language),
		focus: state.focus,
		evidence: evidence.text,
		history: state.history,
		round: state.round,
	});
	for (const reviewer of currentActive.reviewers) {
		if (reviewer.status !== "running") continue;
		runReviewer({
			index: reviewer.index,
			config: reviewerModelConfig(reviewer, config),
			prompt,
			cwd: active.ctx.cwd,
			language: config.language,
			signal: active.signal.signal,
			onEvent: (event) => {
				if (controller !== active) return;
				active.progress = applyProcessEvent(
					active.progress,
					reviewer.index,
					event,
					config.language,
				);
			},
		})
			.then((result) => {
				if (controller === active)
					active.progress = settleProgress(
						active.progress,
						result.index,
						result.status,
						config.language,
					);
				if (!active.signal.signal.aborted)
					dispatch(pi, { type: "REVIEWER_SETTLED", index: result.index, result });
			})
			.catch((error) => {
				if (!active.signal.signal.aborted)
					dispatch(pi, {
						type: "REVIEWER_SETTLED",
						index: reviewer.index,
						result: {
							index: reviewer.index,
							model: reviewer.model,
							thinking: reviewer.thinking,
							status: "error",
							summary: "",
							details: processErrorText("reviewer", active.config.language, error),
						},
					});
			});
	}
}

function consultAdvisor(pi: ExtensionAPI) {
	const active = controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.pending) return;
	const pending = state.pending;
	const prompt = buildAdvisorPrompt(readPrompt("advisor", config.language), {
		language: config.language,
		focus: state.focus,
		details: pending.details,
		history: state.history,
		round: pending.round,
	});
	runAdvisor({
		config: reviewerModelConfig(config.advisor, config),
		prompt,
		cwd: active.ctx.cwd,
		language: config.language,
		signal: active.signal.signal,
	})
		.then((result) => {
			if (!active.signal.signal.aborted)
				dispatch(pi, { type: "ADVISOR_SETTLED", result });
		})
		.catch((error) => {
			if (!active.signal.signal.aborted)
				dispatch(pi, {
					type: "ADVISOR_SETTLED",
					result: {
						verdict: "continue",
						advice: processErrorText("advisor", active.config.language, error),
					},
				});
		});
}

function processErrorText(kind: "reviewer" | "advisor", language: Language, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (kind === "reviewer")
		return language === "en" ? `reviewer subprocess error: ${message}` : `审查子进程异常：${message}`;
	return language === "en" ? `advisor subprocess error: ${message}` : `顾问子进程异常：${message}`;
}

function deliverFeedback(
	pi: ExtensionAPI,
	details: string,
	advisor: AdvisorResult | null,
) {
	if (!controller) return;
	if (controller.ctx.isIdle()) {
		deliverFeedbackNow(pi, details, advisor);
		return;
	}
	// agent 仍在运行：把反馈挂起，等 agent_settled 再投，不能打断当前回复。
	controller.pendingFeedback = { details, advisor };
}

function deliverFeedbackNow(
	pi: ExtensionAPI,
	details: string,
	advisor: AdvisorResult | null,
) {
	if (!controller) return;
	const feedback = buildFixFeedback({
		language: controller.config.language,
		details,
		advisor,
	});
	// display:false 的消息进 LLM 上下文但不渲染；triggerTurn 让执行模型开始修复回合。
	pi.sendMessage(
		{ customType: FEEDBACK_TYPE, content: feedback, display: false },
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function sendCard(pi: ExtensionAPI, card: CardData) {
	if (!controller) return;
	// 宿主在 streaming 时会把无 options 的 sendMessage 当 steer 塞进当前模型回合。
	// 卡片只是 UI 投影，绝不能因此唤醒或打断执行模型。
	if (!controller.ctx.isIdle()) {
		controller.pendingCards.push(card);
		emitReviewSettlement(pi, card);
		return;
	}
	try {
		sendCardNow(pi, card);
	} finally {
		emitReviewSettlement(pi, card);
	}
}

function flushPendingCards(pi: ExtensionAPI): void {
	const active = controller;
	if (!active || !active.ctx.isIdle() || active.pendingCards.length === 0) return;
	const cards = active.pendingCards.splice(0);
	for (const card of cards) {
		try {
			sendCardNow(pi, card);
		} catch (error) {
			notifyEffectFailure(error);
		}
	}
}

function sendCardNow(pi: ExtensionAPI, card: CardData): void {
	if (!controller) return;
	const built = buildCard(card, controller.config.language);
	pi.sendMessage({
		customType: CARD_TYPE,
		content: built.content,
		display: true,
		details: built.details,
	});
}

function emitReviewSettlement(pi: ExtensionAPI, card: CardData): void {
	if (card.kind === "pass")
		pi.events.emit("firecode:review-settled", {
			passed: true,
			details: card.details || card.summary,
		});
	else if (card.kind === "error")
		pi.events.emit("firecode:review-settled", { passed: false, details: card.message });
	else if (card.kind === "stop" || card.kind === "cancel" || card.kind === "timeout")
		pi.events.emit("firecode:review-settled", {
			passed: false,
			details: "details" in card && card.details ? card.details : `review ${card.kind}: ${card.reason}`,
		});
}

/** 会话分支 entries（供证据组装）；本插件的卡与反馈消息不参与证据，避免自指。 */
function sessionEntries() {
	const manager = controller?.ctx.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	const entries = manager?.getBranch?.() ?? [];
	return entries.filter(
		(entry) =>
			!isRecord(entry) ||
			entry.type !== "custom_message" ||
			(entry.customType !== CARD_TYPE && entry.customType !== FEEDBACK_TYPE),
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

/** 测试专用：等待 dispatch 队列排空，避免断言依赖异步时序。 */
export async function __reviewFlushForTests(): Promise<void> {
	await dispatchQueue;
}
