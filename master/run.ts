/**
 * 回合编排：打开 Worker 会话、跑一个回合、按终态落定（成功/失败/中断/fallback 续跑）、审查监视与中断续跑提醒。
 * 所有 await 之后的写回经 runtime.current/commit 重读档案：kill 赢过迟到的异步写回。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { MasterRole, ModelAtom } from "../config.js";
import { wrapEnvelope } from "../deliver.js";
import { clip, firstSentence, textOf } from "../format.js";
import { outcomeOfEntry, readReviewOutcome, reviewProgressOf, type ReviewOutcome } from "../review/outcome.js";
import { masterEvent, type MasterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import { assembleWorkerPrompt } from "./prompt.js";
import type { MasterRuntime, WorkerLive } from "./runtime.js";
import { modelAtomText, type WorkerRef } from "./state.js";

const WORKER_TOOLS = ["read", "bash", "edit", "write"];
/** Worker 跟随指挥官是否启用 codemode；on/only 由 Worker 会话读到的同一份 settings 决定，不另传。 */
const CODEMODE_TOOL = "codemode";
const FAULT_SUMMARY_WIDTH = 80;
/** 算作“有输出”的子会话事件：模型 token 流与工具执行；活动列表据此判卡住。 */
const OUTPUT_EVENTS = new Set(["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface WorkerTerminal {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

/** 新建（start）或恢复（send/review 冷启动）Worker 会话；会话路径是档案身份的唯一事实源。 */
export async function spawnWorker(active: MasterRuntime, worker: WorkerRef, resume: boolean): Promise<AgentSession> {
	const { pool, exclusions } = active.setup;
	const model = await pool.resolveModel(worker.model);
	active.assertOpen();
	const spawned = await pool.spawn({
		cwd: worker.cwd ?? process.cwd(),
		model,
		thinking: worker.thinking,
		tools: active.setup.pi.getActiveTools().includes(CODEMODE_TOOL) ? [...WORKER_TOOLS, CODEMODE_TOOL] : WORKER_TOOLS,
		excludeExtensions: exclusions,
		systemPrompt: { mode: "append", text: assembleWorkerPrompt(active.setup.workerPrompt, worker.name) },
		contextFiles: true,
		persistence: { type: "file", sessionPath: worker.sessionPath, ...(resume ? { resume: true } : {}) },
	});
	if (active.closed) {
		await spawned.dispose();
		active.assertOpen();
	}
	return spawned.session;
}

export async function openWorkerSession(active: MasterRuntime, worker: WorkerRef): Promise<AgentSession> {
	active.assertOpen();
	return active.setup.pool.getSession(worker.sessionPath) ?? spawnWorker(active, worker, true);
}

/** 投影当前动作、卡住判定与审查进度的唯一订阅。 */
export function observeWorker(active: MasterRuntime, worker: WorkerRef, session: AgentSession): void {
	active.observe(worker, session, (live, event) => {
		if (OUTPUT_EVENTS.has(event.type)) live.lastOutputAt = Date.now();
		if (event.type === "tool_execution_start")
			live.currentTools.set(event.toolCallId, { tool: event.toolName, args: event.args, startedAt: Date.now() });
		if (event.type === "tool_execution_end") live.currentTools.delete(event.toolCallId);
		if (event.type === "entry_appended") live.reviewProgress = reviewProgressOf(event.entry) ?? live.reviewProgress;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "entry_appended") active.schedulePublish();
	});
}

/** resolve 即回合已在飞：宿主 prompt 的前置阶段仍报空闲，期间 abort 会被丢弃，interrupt 必须晚于 preflight。 */
export async function runWorker(active: MasterRuntime, worker: WorkerRef, session: AgentSession, prompt: string): Promise<void> {
	// 启动回合的路径都经这里：准备期间被 kill 的不调模型、不留热会话。
	active.current(worker);
	observeWorker(active, worker, session);
	const live = active.liveOf(worker.name);
	const run = Symbol(worker.name);
	live.run = run;
	const mine = () => !active.closed && active.live.get(worker.name) === live && live.run === run;
	let terminal: WorkerTerminal | undefined;
	const unsubscribeTerminal = session.subscribe((event) => {
		if (mine() && event.type === "agent_end") terminal = captureWorkerTerminal(event.messages);
	});
	const settled = async (error?: unknown) => {
		unsubscribeTerminal();
		if (!mine()) return;
		const stranded = session.clearQueue().steering;
		if (stranded.length) active.outbox.enqueue(masterEvent.stranded(worker.name, stranded), worker.name);
		live.run = undefined;
		if (live.interruptedRun === run) {
			live.interruptedRun = undefined;
			settleInterrupted(active, worker);
			return;
		}
		if (terminal?.stopReason === "error" && error === undefined) {
			await resumeWithFallback(active, worker, session, terminal, faultSummary(terminal));
			return;
		}
		settleWorker(active, worker, terminal, error);
	};
	const inflight = Promise.withResolvers<void>();
	void session.prompt(prompt, { preflightResult: () => inflight.resolve() })
		.then(() => settled(), settled)
		.finally(() => inflight.resolve());
	await inflight.promise;
}

function settleInterrupted(active: MasterRuntime, identity: WorkerRef): void {
	const current = active.find(identity);
	if (!current) return;
	const interrupted: WorkerRef = { ...current, status: "idle", interruptedAt: Date.now() };
	active.store.upsert(interrupted);
	active.markIdle(interrupted, { kind: "interrupted" }, interrupted.interruptedAt);
	active.outbox.enqueue(masterEvent.interrupted(identity.name, current.reviewNeeded === true, takeViewPrompts(active, identity)), identity.name);
}

/**
 * 会话重载打断的回合：恢复后满时限仍未续派就提醒指挥官；按档案里的中断时刻补算剩余时间。指挥官自己 interrupt 的不提醒。
 * 只提醒、不代发“继续”：工作说明归指挥官，插件盲续会复活它已作废的任务。
 */
export function armInterruptReminder(active: MasterRuntime, worker: WorkerRef): void {
	if (active.closed) return;
	const live = active.liveOf(worker.name);
	clearTimeout(live.interruptTimer);
	const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + active.setup.interruptResumeMs - Date.now());
	live.interruptTimer = setTimeout(() => {
		if (active.closed || active.live.get(worker.name) !== live) return;
		live.interruptTimer = undefined;
		const current = active.find(worker);
		if (!current?.interruptedAt || current.interruptedAt !== worker.interruptedAt) return;
		active.store.upsert({ ...current, disposition: "reminded" });
		active.outbox.enqueue(masterEvent.resumeReminder(worker.name), worker.name);
	}, delay);
	live.interruptTimer.unref?.();
}

/**
 * 任何 error 终态都沿角色链切换，不按关键词分类故障：供应商措辞多变，关键词白名单实测一次未命中，分类也不改变决策。
 * 瞬时限流与 Claude 令牌换发在 error 之前已由宿主重试和 claude-sub 自愈处理。由插件而非宿主做：宿主不知道角色与档案。
 */
async function resumeWithFallback(
	active: MasterRuntime,
	identity: WorkerRef,
	session: AgentSession,
	terminal: WorkerTerminal,
	reason: string,
): Promise<void> {
	const current = active.current(identity);
	const configuredRole = active.setup.roster.find((entry) => entry.role === current.role);
	if (!configuredRole)
		return settleWorker(active, current, terminal, new Error(`${terminalFailure(terminal)}\n${msg.run.roleGone(current.role)}`));
	const fallback = nextFallback(configuredRole, current);
	if (!fallback)
		return settleWorker(active, current, terminal, new Error(`${terminalFailure(terminal)}\n${msg.run.fallbackExhausted(current.role)}`));
	try {
		const model = await active.setup.pool.resolveModel(fallback.model);
		active.assertOpen();
		await session.setModel(model);
		active.assertOpen();
		session.setThinkingLevel(fallback.thinking);
		const switched = active.commit(current, (latest) => ({ ...latest, ...fallback, status: "working" }));
		const from = modelAtomText(current);
		const to = modelAtomText(fallback);
		active.outbox.enqueue(masterEvent.modelSwitched(current.name, from, to, reason), current.name);
		await runWorker(active, switched, session, fallbackResumePrompt(from, to, reason));
	} catch (error) {
		const failure = `${terminalFailure(terminal)}\n${msg.run.fallbackFailed(error instanceof Error ? error.message : String(error))}`;
		settleWorker(active, current, terminal, new Error(failure));
	}
}

function settleWorker(active: MasterRuntime, identity: WorkerRef, terminal: WorkerTerminal | undefined, error?: unknown): void {
	const current = active.find(identity);
	if (!current) return;
	const failure = error instanceof Error ? error.message : error === undefined ? terminalFailure(terminal) : String(error);
	const idle: WorkerRef = { ...current, status: "idle" };
	active.store.upsert(idle);
	// 活动列表展开行显示结果首句（失败是错误首句），不是千篇一律的“已返回”。
	active.markIdle(idle, failure ? { kind: "failed", note: firstSentence(failure) } : { kind: "done", note: firstSentence(terminal!.text) });
	const obligation = current.reviewNeeded === true;
	const event: MasterEvent = failure
		? masterEvent.failed(identity.name, failure, obligation, takeViewPrompts(active, identity))
		: masterEvent.returned(identity.name, terminal!.text, obligation, takeViewPrompts(active, identity));
	active.outbox.enqueue(event, identity.name);
}

/** 起审：在原 Worker 会话里跑 /fire-review，终态经 review/outcome.ts 读取后落定并投递。 */
export function monitorAndSettleReview(active: MasterRuntime, target: WorkerRef, session: AgentSession, previousRunId: string | undefined): void {
	const live = active.liveOf(target.name);
	const reviewing = () => {
		const current = active.closed || active.live.get(target.name) !== live ? undefined : active.find(target);
		return current?.status === "reviewing" ? current : undefined;
	};
	void monitorReview(session, target.sessionPath, previousRunId).then(
		(outcome) => {
			const current = reviewing();
			if (!current) return;
			const { reviewNeeded: _needed, ...fulfilled } = current;
			const idle: WorkerRef = { ...(outcome.status === "passed" || outcome.status === "stopped" ? fulfilled : current), status: "idle" };
			active.store.upsert(idle);
			active.markIdle(idle, reviewOutcomeRow(outcome));
			active.outbox.enqueue(masterEvent.review(target.name, outcome, textOf(lastAssistant<{ role: string; content?: unknown }>(session.messages)?.content)), target.name);
		},
		(error) => {
			const current = reviewing();
			if (!current) return;
			const idle: WorkerRef = { ...current, status: "idle" };
			active.store.upsert(idle);
			active.markIdle(idle, { kind: "failed", note: msg.run.reviewIncomplete });
			active.outbox.enqueue(masterEvent.reviewIncomplete(target.name, String(error)), target.name);
		},
	);
}

/** 这次运行里视图说过的话交给落定事件后清空：下一次运行另算。 */
function takeViewPrompts(active: MasterRuntime, worker: WorkerRef): string[] {
	const live = active.liveOf(worker.name);
	const prompts = live.viewPrompts;
	live.viewPrompts = [];
	return prompts;
}

export function reviewRunId(outcome: ReviewOutcome): string | undefined {
	return "runId" in outcome ? outcome.runId : undefined;
}

function monitorReview(session: AgentSession, sessionPath: string, previousRunId: string | undefined): Promise<ReviewOutcome> {
	return new Promise((resolve, reject) => {
		let done = false;
		let unsubscribe = () => {};
		const fail = (error: unknown) => {
			if (done) return;
			done = true;
			unsubscribe();
			reject(error);
		};
		const finish = (outcome: ReviewOutcome) => {
			if (done) return;
			const runId = reviewRunId(outcome);
			if (outcome.status !== "error"
				&& (!runId || runId === previousRunId || outcome.status === "in_progress" || outcome.status === "none")) return;
			done = true;
			unsubscribe();
			resolve(outcome);
		};
		// 只看刚追加的那条记录，不每条都重读整份 JSONL；回合结束时再读一次文件兜底。
		unsubscribe = session.subscribe((event) => {
			const outcome = event.type === "entry_appended" ? outcomeOfEntry(event.entry) : undefined;
			if (outcome) finish(outcome);
		});
		void session.prompt("/fire-review").then(
			() => {
				const outcome = readReviewOutcome(sessionPath);
				const runId = reviewRunId(outcome);
				if (outcome.status === "error") return finish(outcome);
				if (!runId || runId === previousRunId) return fail(new Error(msg.run.reviewNotStarted));
				finish(outcome);
			},
			fail,
		);
	});
}

/** 审查落定在活动列表上的结局：只有通过算完成，停止与未完成都是要指挥官看的失败行。 */
function reviewOutcomeRow(outcome: ReviewOutcome): WorkerLive["outcome"] {
	if (outcome.status === "passed") return { kind: "done", note: msg.run.reviewPassed };
	return { kind: "failed", note: outcome.status === "stopped" ? msg.run.reviewStopped : msg.run.reviewIncomplete };
}

function captureWorkerTerminal(
	messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>,
): WorkerTerminal | undefined {
	const message = lastAssistant(messages);
	if (!message) return undefined;
	return {
		text: textOf(message.content),
		...(message.stopReason ? { stopReason: message.stopReason } : {}),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
	};
}

function terminalFailure(terminal: WorkerTerminal | undefined): string | undefined {
	if (!terminal) return msg.run.noTerminal;
	if (terminal.stopReason === "error") return terminal.errorMessage || msg.run.unknownProviderError;
	if (terminal.stopReason === "aborted") return msg.run.aborted(terminal.errorMessage || msg.run.noReason);
	if (!terminal.text) return msg.run.noReply;
	return undefined;
}

function faultSummary(terminal: WorkerTerminal): string {
	const message = terminal.errorMessage?.trim();
	if (!message) return msg.run.unknownProviderError;
	const [first = message] = message.split(/(?<=[.。!！?？])\s|\n/u);
	return clip(first.trim(), FAULT_SUMMARY_WIDTH);
}

function lastAssistant<T extends { role: string }>(messages: readonly T[]): T | undefined {
	return messages.findLast((candidate) => candidate.role === "assistant");
}

function nextFallback(role: MasterRole, worker: WorkerRef): ModelAtom | undefined {
	const chain: ModelAtom[] = [role, ...role.fallback];
	let index = chain.findIndex((atom) => atom.model === worker.model && atom.thinking === worker.thinking);
	if (index < 0) index = chain.findIndex((atom) => atom.model === worker.model);
	return chain[index + 1];
}

/** 首次续派前置的现场核对提示。 */
export function resumeCheckPrompt(): string {
	return wrapEnvelope("firecode_master_event", msg.run.resumeCheck);
}

function fallbackResumePrompt(from: string, to: string, reason: string): string {
	return wrapEnvelope("firecode_master_event", msg.run.fallbackResume(from, to, reason));
}
