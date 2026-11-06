/**
 * 回合编排：打开 Worker 会话、跑一个回合、按终态落定（成功/失败/中断/暂停）、审查监视、中断续跑提醒与暂停后的自动续跑。
 * 所有 await 之后的写回经 runtime.current/commit 重读档案：kill 赢过迟到的异步写回。
 *
 * 暂停：回合或审查因瞬时故障（模型路由判定整条链暂时不可用，见 model-route.ts 的 routePause）收场时不报失败，
 * 档案记 idle + resume（到时刻与原因），只告知指挥官一次不唤醒，到时在原会话自动续跑；续跑结束才是这次运行唯一的落定事件。
 * 非瞬时失败（鉴权、参数、模型不存在）照常作为失败落定。
 */
import { existsSync } from "node:fs";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { modelAtomText, type ThinkingLevelValue } from "../config.js";
import { type Delivery, wrapEnvelope } from "../deliver.js";
import { clip, firstSentence, oneLine, textOf, tildeHome } from "../format.js";
import { routePause, type ChainPause } from "../model-route.js";
import { delayUntil } from "../timing.js";
import { outcomeOfEntry, readReviewOutcome, reviewProgressOf, type ReviewOutcome } from "../review/outcome.js";
import { quietMinutes, workerPhase } from "./activity-list.js";
import { MASTER_EVENT_TYPE, masterEvent, type MasterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import { msg as commonMsg } from "../messages.js";
import { CODEMODE_TOOL } from "../spawn.js";
import { assembleWorkerPrompt } from "./prompt.js";
import type { MasterRuntime, WorkerLive } from "./runtime.js";
import type { WorkerRef } from "./state.js";

/** 指挥官开着 codemode 时 Worker 也开（on/only 读同一份 settings）；同进程共用的名额由池按子会话加开，见 spawn.ts。 */
const WORKER_TOOLS = ["read", "bash", "edit", "write"];
/** 续跑提示里的故障原文截到这么宽：供应商报错常带整段 JSON。 */
const RESUME_REASON_WIDTH = 300;
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
			// 只告知不唤醒：同一会话自动续跑，指挥官无事可做（断网时每次切换都唤醒它，只换来一串同样失败的指挥官回合）。
			if (from.model !== atom.model)
				active.outbox.enqueue(masterEvent.modelSwitched(worker.name, modelAtomText(from), modelAtomText(atom), reason ?? ""), worker.name, true);
		},
		tools: active.setup.pi.getActiveTools().includes(CODEMODE_TOOL) ? [...WORKER_TOOLS, CODEMODE_TOOL] : WORKER_TOOLS,
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
		if (OUTPUT_EVENTS.has(event.type)) {
			live.lastOutputAt = Date.now();
			if (live.stallReported) {
				live.stallReported = undefined;
				watchStall(active, worker);
			}
		}
		if (event.type === "tool_execution_start") {
			live.currentTools.set(event.toolCallId, { tool: event.toolName, args: event.args, startedAt: Date.now() });
			active.progress?.toolCall(worker.name, event.toolName, event.args, worker.cwd ?? "");
		}
		// 只记带工具调用的正文（边说边做）；以 stop 收尾的最终回复意味着回合马上落定，为它再调一次模型是白花。
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse")
			active.progress?.said(worker.name, textOf(event.message.content));
		if (event.type === "tool_execution_end") live.currentTools.delete(event.toolCallId);
		if (event.type === "entry_appended") live.reviewProgress = reviewProgressOf(event.entry) ?? live.reviewProgress;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "entry_appended") active.schedulePublish();
	});
}

/**
 * 停摆唤醒：在跑的回合落入活动列表的“卡住”（同一个 workerPhase 判定、同一份 lastOutputAt）时给指挥官投一条事件。
 * 计时器不另算无输出时长，只在判定可能成立的时刻去看一眼：还没到就按剩余时间重挂，不再 working 就停；
 * 报过后停到下一次输出（observeWorker 清掉标记并重挂），所以同一段无输出只报一次。
 */
function watchStall(active: MasterRuntime, identity: WorkerRef): void {
	const live = active.liveOf(identity.name);
	const check = () => {
		clearTimeout(live.stallTimer);
		live.stallTimer = undefined;
		if (active.closed || active.live.get(identity.name) !== live || live.stallReported) return;
		const facts = active.activityFacts();
		const index = facts.workers.findIndex((worker) => worker.sessionPath === identity.sessionPath);
		if (index < 0) return;
		const now = Date.now();
		const { kind, action, startedAt, quietMs } = workerPhase(facts, index, now);
		if (quietMs === undefined) return;
		if (kind !== "stuck") {
			live.stallTimer = setTimeout(check, facts.stallMs - quietMs);
			live.stallTimer.unref?.();
			return;
		}
		live.stallReported = true;
		active.outbox.enqueue(masterEvent.stalled(identity.name, quietMinutes(quietMs), action, startedAt === undefined ? undefined : now - startedAt), identity.name);
	};
	check();
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
	watchStall(active, worker);
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
		const pause = error === undefined && terminal?.stopReason === "error" ? routePause(session.model) : undefined;
		if (pause) return pauseWorker(active, worker, pause);
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
	const interrupted: WorkerRef = { ...landed(current), interruptedAt: Date.now() };
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

/** 运行落定回到 idle：这次运行（含自动续跑）到此结束，续跑意图随之清掉。 */
function landed({ resume: _resume, ...worker }: WorkerRef): WorkerRef {
	return { ...worker, status: "idle" };
}

/**
 * 瞬时故障暂停：回到 idle 并记下续跑时刻；这次运行第一次暂停时告知指挥官（不唤醒），到时 armResume 自动续跑。
 * “已告知过”只读档案：resume 从第一次暂停起留到这次运行落定（自动续跑不清、reload 不丢，指挥官接手才清），
 * 所以暂停前档案已带 resume 就是同一次运行里的再次暂停。
 */
function pauseWorker(active: MasterRuntime, identity: WorkerRef, pause: ChainPause, review = false): void {
	const current = active.find(identity);
	if (!current) return;
	const paused: WorkerRef = { ...current, status: "idle", resume: { at: pause.until, reason: pause.reason, ...(review ? { review: true as const } : {}) } };
	active.store.upsert(paused);
	active.markIdle(paused, undefined);
	if (!current.resume) {
		active.outbox.enqueue(masterEvent.paused(identity.name, pause.until, pause.reason, review), identity.name, true);
	}
	armResume(active, paused);
}

/** 按档案里的 resume.at 挂自动续跑（激活时对每个暂停中的票调用）；没有 resume 的票不挂。 */
export function armResume(active: MasterRuntime, worker: WorkerRef): void {
	const resume = worker.resume;
	if (!resume || active.closed) return;
	const live = active.liveOf(worker.name);
	clearTimeout(live.resumeTimer);
	live.resumeTimer = setTimeout(() => {
		live.resumeTimer = undefined;
		if (active.closed || active.live.get(worker.name) !== live) return;
		if (Date.now() < resume.at) armResume(active, worker);
		else void resumeWorker(active, worker, resume);
	}, delayUntil(resume.at));
	live.resumeTimer.unref?.();
}

/**
 * 到时续跑：档案仍是这次暂停（指挥官没有 send/review/interrupt/ack 接手）才续；任务在原会话里以续跑提示开回合，
 * 审查则重新发起 fire-review。本次运行的起点与来源沿用暂停前的，落定事件只有续跑结束的那一条。
 * 续跑准备失败（会话打不开、角色已删）不是瞬时故障，照常作为失败交给指挥官。
 */
async function resumeWorker(active: MasterRuntime, identity: WorkerRef, resume: NonNullable<WorkerRef["resume"]>): Promise<void> {
	const live = active.liveOf(identity.name);
	const current = active.find(identity);
	if (current?.status !== "idle" || current.resume?.at !== resume.at || live.transitioning) return;
	live.transitioning = true;
	try {
		if (resume.review) {
			await startReview(active, current, true);
			return;
		}
		const session = await openWorkerSession(active, current);
		await session.waitForIdle();
		active.assertOpen();
		if (resumeSuperseded(active, current, resume)) return;
		// resume 留到落定：续跑中被 reload 打断时载入收敛回暂停再续（state.ts）。
		const working = active.commit(current, (latest) => ({ ...latest, status: "working" }));
		live.runStartedAt ??= Date.now();
		active.progress?.resume(identity.name);
		const prompt = wrapEnvelope("firecode_master_event", msg.run.resumeAfterPause(clip(oneLine(resume.reason), RESUME_REASON_WIDTH)));
		await runWorker(active, working, session, { customType: MASTER_EVENT_TYPE, content: prompt });
	} catch (error) {
		const latest = active.find(identity);
		if (!latest?.resume) return;
		const idle = landed(latest);
		active.store.upsert(idle);
		const failure = error instanceof Error ? error.message : String(error);
		active.markIdle(idle, { kind: "failed", note: firstSentence(failure) });
		active.outbox.enqueue(masterEvent.failed(identity.name, failure, idle.reviewNeeded === true, takeViewPrompts(active, identity)), identity.name);
	} finally {
		live.transitioning = undefined;
	}
}

/**
 * 续跑准备越过 await 后的核对：档案已不是这次暂停（准备期间指挥官 ack 清掉了 resume）就放弃续跑，
 * 补回 openWorkerSession 取消的释放计时。ack 不等准备结束、也不拒绝：取消还没开跑的续跑正是它的承诺，写回方让路。
 * 票被 kill 时 current 抛错，由调用方的失败路径放弃。
 */
function resumeSuperseded(active: MasterRuntime, identity: WorkerRef, resume: NonNullable<WorkerRef["resume"]>): boolean {
	if (active.current(identity).resume?.at === resume.at) return false;
	active.setup.pool.markIdle(identity.sessionPath);
	return true;
}

/**
 * 在原 Worker 会话里发起 fire-review（review 动作与暂停后的续审共用）。续审沿用暂停前的运行起点与来源。
 * 先写档案再挂订阅：kill 或会话关闭时 commit 抛错，不会给已删的票留下订阅。
 */
export async function startReview(active: MasterRuntime, target: WorkerRef, resumed = false): Promise<void> {
	const session = await openWorkerSession(active, target);
	await session.waitForIdle();
	active.assertOpen();
	if (resumed && resumeSuperseded(active, target, target.resume!)) return;
	const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
	// 指挥官发起的审查接手了这票，清掉续跑意图；自动续审保留到落定（同 resumeWorker）。
	active.commit(target, ({ interruptedAt: _interruptedAt, resume, ...rest }) => ({ ...rest, ...(resumed && resume ? { resume } : {}), status: "reviewing" }));
	observeWorker(active, target, session);
	if (!resumed) active.beginRun(target.name);
	else active.liveOf(target.name).runStartedAt ??= Date.now();
	monitorAndSettleReview(active, target, session, previousRunId);
}

function settleWorker(active: MasterRuntime, identity: WorkerRef, terminal: WorkerTerminal | undefined, error?: unknown): void {
	const current = active.find(identity);
	if (!current) return;
	const failure = error instanceof Error ? error.message : error === undefined ? terminalFailure(terminal) : String(error);
	const idle = landed(current);
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
			if (outcome.status === "failed" && outcome.retry) return pauseWorker(active, current, outcome.retry, true);
			const { reviewNeeded: _needed, ...fulfilled } = current;
			const idle = landed(outcome.status === "passed" || outcome.status === "stopped" ? fulfilled : current);
			active.store.upsert(idle);
			active.markIdle(idle, reviewOutcomeRow(outcome));
			active.outbox.enqueue(masterEvent.review(target.name, outcome, textOf(lastAssistant<{ role: string; content?: unknown }>(session.messages)?.content)), target.name);
		},
		(error) => {
			live.interruptedReview = undefined;
			const current = reviewing();
			if (!current) return;
			const idle = landed(current);
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
