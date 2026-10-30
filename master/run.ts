/**
 * 回合编排：打开 Worker 会话、跑一个回合、按终态落定（成功/失败/中断）、审查监视与中断续跑提醒。
 * 所有 await 之后的写回经 runtime.current/commit 重读档案：kill 赢过迟到的异步写回。
 */
import { existsSync } from "node:fs";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { modelAtomText, type ThinkingLevelValue } from "../config.js";
import { type Delivery, wrapEnvelope } from "../deliver.js";
import { firstSentence, textOf, tildeHome } from "../format.js";
import { outcomeOfEntry, readReviewOutcome, reviewProgressOf, type ReviewOutcome } from "../review/outcome.js";
import { masterEvent, type MasterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import { msg as commonMsg } from "../messages.js";
import { assembleWorkerPrompt } from "./prompt.js";
import type { MasterRuntime, WorkerLive } from "./runtime.js";
import type { WorkerRef } from "./state.js";

/**
 * Worker 不开 codemode：宿主让同一进程里所有会话共用两个 codemode 名额，脚本等工具返回时也占着，满额直接报错。
 * Worker 与指挥官同进程，两个 Worker 各跑一条长命令就会占满，codemode only 的指挥官随之一个工具都调不了，连中断都发不出。
 */
const WORKER_TOOLS = ["read", "bash", "edit", "write"];
/** 算作“有输出”的子会话事件：模型 token 流与工具执行；活动列表据此判卡住。 */
const OUTPUT_EVENTS = new Set(["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface WorkerTerminal {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

/**
 * 新建（start）或恢复（send/review 冷启动）Worker 会话；会话路径是档案身份的唯一事实源。
 * 恢复时文件不存在只可能是子代理在第一条回复落盘之前就被中断或释放（宿主此前没写文件），没有任何上下文可恢复，
 * 就在同一路径上新开；这也包括文件被人删掉的情形，那时同样没有东西可恢复。
 */
export async function spawnWorker(active: MasterRuntime, worker: WorkerRef, resume: boolean, override?: ThinkingLevelValue): Promise<AgentSession> {
	const { pool, exclusions } = active.setup;
	const role = active.setup.roster.find((entry) => entry.role === worker.role);
	if (!role) throw new Error(msg.run.roleGone(worker.role, active.setup.roster.map((entry) => entry.role).join(", ")));
	active.assertOpen();
	const spawned = await pool.spawn({
		cwd: worker.cwd ?? process.cwd(),
		chain: role.models,
		thinkingOverride: override,
		onModelChange: (atom, previous, reason) => {
			const current = active.find(worker);
			if (!current) return;
			const from = previous ?? { model: current.model, thinking: current.thinking };
			active.commit(current, (latest) => ({ ...latest, ...atom }));
			if (from.model !== atom.model)
				active.outbox.enqueue(masterEvent.modelSwitched(worker.name, modelAtomText(from), modelAtomText(atom), reason ?? ""), worker.name);
		},
		tools: WORKER_TOOLS,
		excludeExtensions: exclusions,
		systemPrompt: { mode: "append", text: assembleWorkerPrompt(active.setup.workerPrompt, worker.name) },
		contextFiles: true,
		persistence: { type: "file", sessionPath: worker.sessionPath, ...(resume && existsSync(worker.sessionPath) ? { resume: true } : {}) },
		onExtensionError: (error) => reportExtensionError(active, worker, error),
	});
	if (active.closed) {
		await spawned.dispose();
		active.assertOpen();
	}
	return spawned.session;
}

export async function openWorkerSession(active: MasterRuntime, worker: WorkerRef, override?: ThinkingLevelValue): Promise<AgentSession> {
	active.assertOpen();
	return active.setup.pool.hold(worker.sessionPath) ?? spawnWorker(active, worker, true, override);
}

/** 子代理会话里的扩展出错：同一处错误只告知指挥官一次（事件处理器每次触发都会再抛）。 */
function reportExtensionError(active: MasterRuntime, worker: WorkerRef, error: ExtensionError): void {
	if (!active.find(worker)) return;
	const live = active.liveOf(worker.name);
	const key = `${error.extensionPath}\n${error.event}\n${error.error}`;
	if (live.reportedErrors.has(key)) return;
	live.reportedErrors.add(key);
	active.outbox.enqueue(masterEvent.extensionError(worker.name, tildeHome(error.extensionPath), error.event, error.error), worker.name);
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

/**
 * resolve 即回合已在飞。工作说明是用户消息，经宿主 prompt：它的前置阶段仍报空闲，期间 abort 会被丢弃，interrupt 必须晚于 preflight。
 * 插件自己的续跑提示是机器消息，以自定义消息 + triggerTurn 开回合：宿主同步置忙，开回合前的 abort 在回合开始时生效，发出即在飞。
 */
export async function runWorker(active: MasterRuntime, worker: WorkerRef, session: AgentSession, input: string | Delivery): Promise<void> {
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
		settleWorker(active, worker, terminal, error);
	};
	if (typeof input !== "string") {
		void session.sendCustomMessage({ ...input, display: true }, { triggerTurn: true }).then(() => settled(), settled);
		return;
	}
	const inflight = Promise.withResolvers<void>();
	void session.prompt(input, { preflightResult: () => inflight.resolve() })
		.then(() => settled(), settled)
		.finally(() => inflight.resolve());
	await inflight.promise;
}

/** 被中断落定：回合被 interrupt 打断，或审查被 interrupt 取消（review）。两者都回到 idle 并带中断标记，审查义务保留。 */
function settleInterrupted(active: MasterRuntime, identity: WorkerRef, review = false): void {
	const current = active.find(identity);
	if (!current) return;
	const interrupted: WorkerRef = { ...current, status: "idle", interruptedAt: Date.now() };
	active.store.upsert(interrupted);
	active.markIdle(interrupted, { kind: "interrupted" }, interrupted.interruptedAt);
	const obligation = current.reviewNeeded === true;
	active.outbox.enqueue(
		review ? masterEvent.reviewInterrupted(identity.name, obligation) : masterEvent.interrupted(identity.name, obligation, takeViewPrompts(active, identity)),
		identity.name,
	);
}

/**
 * 会话重载打断的回合：恢复后满时限仍未续派就提醒指挥官；按档案里的中断时刻补算剩余时间。指挥官自己 interrupt 的不提醒。
 * 只提醒、不代发“继续”：工作说明归指挥官，插件盲续会复活它已作废的任务。
 */
export function armInterruptReminder(active: MasterRuntime, worker: WorkerRef): void {
	if (active.closed) return;
	const live = active.liveOf(worker.name);
	clearTimeout(live.interruptTimer);
	const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + active.setup.pool.timing.interruptResumeMs - Date.now());
	live.interruptTimer = setTimeout(() => {
		if (active.closed || active.live.get(worker.name) !== live) return;
		live.interruptTimer = undefined;
		const current = active.find(worker);
		if (!current?.interruptedAt || current.interruptedAt !== worker.interruptedAt) return;
		active.outbox.enqueue(masterEvent.resumeReminder(worker.name), worker.name);
	}, delay);
	live.interruptTimer.unref?.();
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
		const current = active.live.get(target.name) !== live ? undefined : active.find(target);
		return current?.status === "reviewing" ? current : undefined;
	};
	void monitorReview(session, target.sessionPath, previousRunId).then(
		(outcome) => {
			const interrupted = live.interruptedReview;
			live.interruptedReview = undefined;
			const current = reviewing();
			if (!current) return;
			if (interrupted && outcome.status === "cancelled") return settleInterrupted(active, current, true);
			const { reviewNeeded: _needed, ...fulfilled } = current;
			const idle: WorkerRef = { ...(outcome.status === "passed" || outcome.status === "stopped" ? fulfilled : current), status: "idle" };
			active.store.upsert(idle);
			active.markIdle(idle, reviewOutcomeRow(outcome));
			active.outbox.enqueue(masterEvent.review(target.name, outcome, textOf(lastAssistant<{ role: string; content?: unknown }>(session.messages)?.content)), target.name);
		},
		(error) => {
			live.interruptedReview = undefined;
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
	if (terminal.stopReason === "length") return commonMsg.outputTruncated;
	if (terminal.stopReason === "error") return terminal.errorMessage || msg.run.unknownProviderError;
	if (terminal.stopReason === "aborted") return msg.run.aborted(terminal.errorMessage || msg.run.noReason);
	if (!terminal.text) return msg.run.noReply;
	return undefined;
}

function lastAssistant<T extends { role: string }>(messages: readonly T[]): T | undefined {
	return messages.findLast((candidate) => candidate.role === "assistant");
}

/** 首次续派前置的现场核对提示。 */
export function resumeCheckPrompt(): string {
	return wrapEnvelope("firecode_master_event", msg.run.resumeCheck);
}
