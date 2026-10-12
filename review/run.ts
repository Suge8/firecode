/**
 * 一场 /fire-review 的执行器：领域状态只活在纯 reducer（state.ts）里，本文件是唯一执行副作用的地方
 * （起审查会话、投递反馈、发卡、持久化、占用信号、界面接管、总体看门狗），会话结果一律回灌成事件交给 reducer。
 *
 * 迁移是同步的：dispatch 把事件放进收件箱，若已有迁移在跑（效果里又触发了事件）就留给外层循环依次处理，
 * 所以没有异步队列，也没有“等队列排空”的需要。所有终止路径（reducer 收尾、持久化失败、会话离开）都汇到 release()。
 */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { OCCUPANCY_CHANNEL, type ReviewProgress, type ReviewStage } from "../busy.js";
import type { ModelAtom, ReviewConfig } from "../config.js";
import { deliver, parseEnvelopes, wrapEnvelope } from "../deliver.js";
import { textOf } from "../format.js";
import { readPrompt } from "../i18n.js";
import { runAdvisor } from "./advisor.js";
import { buildCard, CARD_TYPE } from "./card.js";
import { type CheckpointWriter, sealCheckpoint } from "./checkpoint.js";
import { buildEvidence } from "./evidence.js";
import { msg } from "./messages.js";
import { buildAdvisorPrompt, buildFixFeedback, buildReviewPrompt, buildSummaryPrompt, type PromptLayers } from "./prompt.js";
import { runReviewer } from "./reviewer.js";
import type { InProcessSessionPool } from "../spawn.js";
import type { ReviewModelConfig } from "./session.js";
import {
	type CardData,
	findingsOf,
	isActive,
	type Phase,
	type ReviewEffect,
	type ReviewEvent,
	type ReviewerResult,
	type ReviewState,
	reduce,
	resultsOf,
	roundText,
	summaryKindOf,
} from "./state.js";
import { ReviewUi } from "./ui.js";

const PROMPTS = new URL("./prompts/", import.meta.url);

/** 总体超时：maxRounds 轮 × 每轮 2 倍单进程超时，最低 30 分钟。 */
function overallTimeoutMs(config: ReviewConfig) {
	return Math.max(30 * 60_000, config.maxRounds * config.timeoutMinutes * 2 * 60_000);
}

export interface RunHost {
	readonly pi: ExtensionAPI;
	readonly pool: InProcessSessionPool;
	/** 这场审查已收尾：宿主侧不再持有它。 */
	ended(run: Run): void;
}

/** 在途的审查者/顾问任务；执行模型 agent_start 必须 await 它退出后才能继续。 */
interface Action {
	/** 本运行时已启动的阶段；reload 后新 Run 会重启被中断的审查会话。 */
	key: string;
	abort: AbortController;
	done: Promise<void>;
}

const STAGE: Partial<Record<Phase, ReviewStage>> = {
	queued: "queued", reviewing: "reviewing", needs_fix: "advisor", awaiting_fix: "fixing", summarizing: "summarizing",
};

export function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export class Run {
	state: ReviewState;
	ctx: ExtensionContext;
	private readonly pi: ExtensionAPI;
	/** 终止时中止：投递中的前门唤起、新工作的启动都以它为准。 */
	private readonly lifetime = new AbortController();
	private readonly ui = new ReviewUi();
	private readonly inbox: ReviewEvent[] = [];
	private action: Action | undefined;
	private watchdog: ReturnType<typeof setTimeout> | undefined;
	private draining = false;
	private delivering = false;
	private occupied = false;
	private released = false;

	constructor(
		private readonly host: RunHost,
		ctx: ExtensionContext,
		private readonly config: ReviewConfig,
		state: ReviewState,
		private readonly writer: CheckpointWriter,
	) {
		this.pi = host.pi;
		this.ctx = ctx;
		this.state = state;
	}

	get active(): boolean {
		return isActive(this.state);
	}

	/** 命令入口：只提出排队请求；真正开审统一经 advance 的 idle 门。 */
	start(focus: string): void {
		this.armWatchdog();
		this.dispatch({ type: "START", focus });
	}

	/** 会话恢复：只更新持久状态并提出推进请求，绝不在 session_start handler 内起任何工作。 */
	resume(): void {
		this.syncOccupancy();
		this.syncUi();
		this.armWatchdog();
		this.dispatch({ type: "RECOVER" });
	}

	dispatch(event: ReviewEvent): void {
		if (this.released) return;
		this.inbox.push(event);
		if (this.draining) return;
		this.draining = true;
		try {
			for (let next = this.inbox.shift(); next; next = this.inbox.shift()) this.step(next);
		} finally {
			this.draining = false;
		}
	}

	private step(event: ReviewEvent): void {
		const { state, effects } = reduce(this.state, event, this.config, Date.now());
		if (state !== this.state) {
			this.state = state;
			// 持久化失败不能当成功继续：否则会拿不一致的状态去起会话、投反馈，重启后又从旧 checkpoint 恢复，重现幽灵审查与重复反馈。
			if (!this.persist()) return;
			this.syncOccupancy();
			this.syncUi();
		}
		for (const effect of effects) this.execute(effect);
		if (!this.active) this.release();
	}

	private execute(effect: ReviewEffect): void {
		if (effect.kind === "advance") return this.advance(this.ctx);
		if (effect.kind === "notify_cancelled") return this.notify(msg.notify.cancelled, "info");
		// 发卡只是展示，失败不能吞掉同一迁移里的推进请求。
		try {
			this.sendCard(effect.card);
		} catch (error) {
			this.notify(msg.notify.stepFailed(errorText(error)), "warning");
		}
	}

	// ---- 终止 ----

	/** 所有终止路径的唯一出口，幂等：中止在途工作与投递、停看门狗、放占用、还界面。 */
	release(): void {
		if (this.released) return;
		this.released = true;
		this.lifetime.abort();
		this.action?.abort.abort();
		clearTimeout(this.watchdog);
		this.setOccupancy(false);
		this.ui.clear(this.ctx);
		this.host.ended(this);
	}

	/** 返回是否已可靠落盘；失败即收口：通知、尽力补写终态（否则重启会把磁盘上的活动 checkpoint 恢复成幽灵审查）、释放。 */
	private persist(): boolean {
		try {
			this.writer.write(this.state);
			return true;
		} catch (error) {
			this.notify(msg.notify.checkpointWriteFailed(errorText(error)), "error");
			try {
				sealCheckpoint(this.pi, this.state);
			} catch {
				this.notify(msg.notify.cannotSeal, "warning");
			}
			this.release();
			return false;
		}
	}

	/** 会话离开当前运行时：取消并等待审查会话退出，quit 落终态，其余保留 checkpoint 给新运行时恢复。 */
	async shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork", ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.lifetime.abort();
		this.action?.abort.abort();
		await this.action?.done;
		if (reason === "quit") this.dispatch({ type: "CANCEL", reason: "shutdown" });
		this.release();
	}

	private armWatchdog(): void {
		const elapsed = this.state.startedAt ? Math.max(0, Date.now() - this.state.startedAt) : 0;
		const remaining = Math.max(0, overallTimeoutMs(this.config) - elapsed);
		if (remaining === 0) return this.dispatch({ type: "TIMEOUT" });
		this.watchdog = setTimeout(() => this.dispatch({ type: "TIMEOUT" }), remaining);
		this.watchdog.unref?.();
	}

	// ---- 宿主事件 ----

	/** 其他扩展可在我们排队后异步触发执行模型。agent_start 是宿主提供的硬边界：宿主会 await 本 handler，
	 * 所以先 abort 并等所有审查会话真正退出，再允许模型 turn_start。 */
	async agentStarted(): Promise<void> {
		const action = this.action;
		if (!action) return;
		action.abort.abort();
		await action.done;
	}

	/** 修复/总结回合的结局：总结任何结局都收尾；修复被中断按用户取消收尾。 */
	agentEnded(event: AgentEndEvent): void {
		const { state } = this;
		if ((state.phase !== "awaiting_fix" && state.phase !== "summarizing") || state.turn !== "running") return;
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const aborted = !assistant || assistant.stopReason === "error" || assistant.stopReason === "aborted";
		this.dispatch({ type: "TURN_ENDED", aborted });
	}

	/** 推进的唯一入口：所有启动工作的路径都经过这道 idle 门；正确性另由 agentStarted 的同步停审互锁保证。 */
	advance(ctx: ExtensionContext): void {
		if (this.released || this.lifetime.signal.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		this.ctx = ctx;
		const { state } = this;
		switch (state.phase) {
			case "queued":
				return this.dispatch({ type: "ADVANCE" });
			case "reviewing":
				return this.startAction(`review:${state.round}`, (signal) => this.reviewRound(signal));
			case "needs_fix":
				return this.startAction(`advisor:${state.round}`, (signal) => this.consultAdvisor(signal));
			case "summarizing":
				if (state.turn === "pending") void this.deliverTurn(this.summaryPrompt());
				return;
			case "awaiting_fix":
				if (state.turn === "done") return this.dispatch({ type: "ADVANCE" });
				if (state.turn === "pending") void this.deliverTurn(this.feedbackPrompt());
				return;
		}
	}

	/** 对外中止整场审查（CANCEL_REVIEW_COMMAND）：与 esc 取消同一事件，但顾问阶段也整场取消，不只是跳过咨询。 */
	cancel(): void {
		this.dispatch({ type: "CANCEL", reason: "user" });
	}

	/** 界面上的 esc：顾问阶段只跳过本次咨询，其余取消整场审查。 */
	private cancelByUser(): void {
		if (this.state.phase !== "needs_fix") return this.dispatch({ type: "CANCEL", reason: "user" });
		const action = this.action;
		action?.abort.abort();
		void (action?.done ?? Promise.resolve()).then(() => this.dispatch({ type: "ADVISOR_SKIPPED" }));
	}

	// ---- 工作 ----

	private startAction(key: string, work: (signal: AbortSignal) => Promise<void>): void {
		if (this.action?.key === key) return;
		const abort = new AbortController();
		const done: Promise<void> = work(abort.signal)
			.catch((error) => {
				if (!abort.signal.aborted) this.dispatch({ type: "INFRASTRUCTURE_ERROR", details: msg.failure.reviewerSession(errorText(error)) });
			})
			.finally(() => {
				if (this.action?.done === done) this.action = undefined;
			});
		this.action = { key, abort, done };
	}

	private modelConfig(atom: ModelAtom): ReviewModelConfig {
		return { model: atom.model, thinking: atom.thinking, tools: this.config.tools, timeoutMs: this.config.timeoutMinutes * 60_000 };
	}

	/** 开审那一刻取会话分支快照构造 prompt，所有审查者共用同一 prompt。 */
	private async reviewRound(signal: AbortSignal): Promise<void> {
		const { state } = this;
		if (state.phase !== "reviewing") return;
		const evidence = buildEvidence(this.sessionEntries(), { sessionFile: this.ctx.sessionManager.getSessionFile() });
		const prompt = buildReviewPrompt(readPrompt(PROMPTS, "review"), {
			scope: msg.command.scope,
			focus: state.focus,
			evidence,
			history: state.history,
			round: state.round,
		});
		await Promise.all(state.slots.map((slot, index) => (slot.result ? undefined : this.review(index, slot, prompt, signal))));
	}

	private async review(index: number, slot: ModelAtom, prompt: PromptLayers, signal: AbortSignal): Promise<void> {
		const result = await runReviewer({
			index,
			config: this.modelConfig(slot),
			prompt,
			cwd: this.ctx.cwd,
			signal,
			pool: this.host.pool,
		}).catch((error): ReviewerResult => ({
			index,
			model: slot.model,
			thinking: slot.thinking,
			status: "error",
			summary: "",
			details: msg.failure.reviewerSession(errorText(error)),
		}));
		if (!signal.aborted) this.dispatch({ type: "REVIEWER_SETTLED", index, result });
	}

	/** 顾问不可用不终止审查：跳过咨询，带着本轮发现继续修复，并发一张可见的卡说明。 */
	private async consultAdvisor(signal: AbortSignal): Promise<void> {
		const { state } = this;
		if (state.phase !== "needs_fix") return;
		try {
			const prompt = buildAdvisorPrompt(readPrompt(PROMPTS, "advisor"), {
				focus: state.focus,
				details: findingsOf(state.voters),
				history: state.history,
				round: state.round,
			});
			const result = await runAdvisor({ config: this.modelConfig(this.config.advisor), prompt, cwd: this.ctx.cwd, signal, pool: this.host.pool });
			if (!signal.aborted) this.dispatch({ type: "ADVISOR_SETTLED", result });
		} catch (error) {
			if (!signal.aborted) this.dispatch({ type: "ADVISOR_SKIPPED", message: errorText(error) });
		}
	}

	private feedbackPrompt(): string {
		const last = this.state.history.at(-1);
		return buildFixFeedback({ details: last ? roundText(last) : "", advisor: last?.advisor ?? null });
	}

	private summaryPrompt(): string {
		const last = this.state.history.at(-1);
		return buildSummaryPrompt({ kind: summaryKindOf(last), rounds: this.state.history.length, material: last ? roundText(last) : "" });
	}

	/**
	 * 修复反馈与总结提示经统一投递入口（deliver.ts）：空闲时前门唤起，回合照常经过 before_agent_start；
	 * deliver resolve 即消息已进入回合，pending → running 由它推进，没有计时器。宿主拒收时 deliver 不 resolve，
	 * 状态停在 pending，等下一个回合带着这条信封补投；reload 同样从 pending 重投。delivering 防止等待期间重复投递。
	 * 总结是尽力而非必须：投递抛错就静默收尾（裁决与结果卡已落地）；修复反馈投递抛错按用户取消收尾。
	 */
	private async deliverTurn(content: string): Promise<void> {
		if (this.delivering) return;
		this.delivering = true;
		const { signal } = this.lifetime;
		try {
			await deliver(this.pi, this.ctx, { customType: CARD_TYPE, content }, signal);
			this.dispatch({ type: "TURN_STARTED" });
		} catch (error) {
			if (signal.aborted) return;
			this.notify(msg.notify.stepFailed(errorText(error)), "warning");
			this.dispatch(this.state.phase === "summarizing" ? { type: "TURN_ENDED", aborted: false } : { type: "CANCEL", reason: "user" });
		} finally {
			this.delivering = false;
		}
	}

	// ---- 投影 ----

	private notify(message: string, level: "info" | "warning" | "error"): void {
		if (this.ctx.hasUI) this.ctx.ui.notify(message, level);
	}

	private syncOccupancy(): void {
		this.setOccupancy(this.active);
	}

	private setOccupancy(held: boolean): void {
		if (this.occupied === held) return;
		this.occupied = held;
		this.pi.events.emit(OCCUPANCY_CHANNEL, held ? { active: true, progress: () => this.progress() } : { active: false });
	}

	/** 审查进度只读 reducer 的当前状态；只有审查相的票数可数。 */
	private progress(): ReviewProgress | undefined {
		const { state } = this;
		const stage = STAGE[state.phase];
		if (!stage) return undefined;
		const results = state.phase === "reviewing" ? resultsOf(state.slots) : [];
		const count = (status: string) => results.filter((result) => result.status === status).length;
		return { stage, round: state.round, passed: count("passed"), blocked: count("failed"), total: state.phase === "reviewing" ? state.slots.length : 0 };
	}

	/** UI 投影：终端标题 + esc 接管，全部从当前状态派生；审查进度经占用频道由输入框外壳显示。 */
	private syncUi(): void {
		if (!this.active || !this.ctx.hasUI) return this.ui.clear(this.ctx);
		const { phase, round } = this.state;
		// 只在等模型结论时接管编辑器；awaiting_fix 与 summarizing 相把输入交还用户。
		const canCancel = phase === "queued" || phase === "reviewing" || phase === "needs_fix";
		this.ui.show(this.ctx, round, canCancel, () => this.cancelByUser());
	}

	/**
	 * 结果卡一律不带 triggerTurn：卡片只是 UI 投影，不能唤醒执行模型；宿主在回合进行中会把它推迟到本回合末追加，
	 * 空闲时当场追加。
	 */
	private sendCard(card: CardData): void {
		const built = buildCard(card);
		this.pi.sendMessage(
			{ customType: CARD_TYPE, content: wrapEnvelope("firecode_review", built.content), display: true, details: built.details },
			{ triggerTurn: false },
		);
	}

	/** 会话分支 entries（供证据组装）；本插件的卡与投给执行模型的反馈/总结信封不参与证据，避免自指。 */
	private sessionEntries(): SessionEntry[] {
		return this.ctx.sessionManager.getBranch().filter((entry) => !isOwnMessage(entry));
	}
}

/** 结果卡（含忙时补投的提示，沿用卡的类型，渲染器降级成纯文本），或空闲时前门送达、整条由审查信封构成的用户消息。 */
function isOwnMessage(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return entry.customType === CARD_TYPE;
	if (entry.type !== "message" || entry.message.role !== "user") return false;
	return parseEnvelopes(textOf(entry.message.content))?.every((envelope) => envelope.tag === "firecode_review") ?? false;
}
