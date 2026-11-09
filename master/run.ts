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
import { CANCEL_REVIEW_COMMAND, outcomeOfEntry, readReviewOutcome, reviewProgressOf, type ReviewOutcome } from "../review/outcome.js";
import { quietMinutes, workerPhase } from "./phase.js";
import { MASTER_EVENT_TYPE, masterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import { msg as commonMsg } from "../messages.js";
import { CODEMODE_TOOL } from "../spawn.js";
import { assembleWorkerPrompt } from "./prompt.js";
import type { MasterRuntime, Turn, WorkerLive } from "./runtime.js";
import { transition, type WorkerRef } from "./state.js";

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
	const role = active.roles.require(worker.role);
	active.assertOpen();
	const spawned = await pool.spawn({
		cwd: worker.cwd,
		chain: role.models,
		thinkingOverride: override,
		// 档案的模型原子只由这里写：路由每次选定（新会话首选、换角色或思考档后重选、故障切换）都报到这里。
		onModelChange: (atom, previous, reason) => active.detached(worker.name, () => {
			const current = active.find(worker);
			if (!current) return;
			active.commit(current, (latest) => ({ ...latest, ...atom }));
			// 只有故障切换才告知：首选与指挥官自己换角色、思考档不是新闻。只告知不唤醒：同一会话自动续跑，指挥官无事可做
			// （断网时每次切换都唤醒它，只换来一串同样失败的指挥官回合）。
			if (reason !== undefined && previous)
				active.enqueue(masterEvent.modelSwitched(worker.name, modelAtomText(previous), modelAtomText(atom), reason), worker.name, true);
		}),
		tools: active.setup.pi.getActiveTools().includes(CODEMODE_TOOL) ? [...WORKER_TOOLS, CODEMODE_TOOL] : WORKER_TOOLS,
		excludeExtensions: exclusions,
		systemPrompt: { mode: "append", text: assembleWorkerPrompt(worker.name) },
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

/** 准备段里打开要开回合的会话：热的经 hold 取消释放计时，冷的重开；归还由 prepare 负责。 */
export async function openWorkerSession(active: MasterRuntime, worker: WorkerRef, override?: ThinkingLevelValue): Promise<AgentSession> {
	active.assertOpen();
	return active.setup.pool.hold(worker.sessionPath) ?? spawnWorker(active, worker, true, override);
}

/**
 * 准备段（send、review 与暂停后的自动续跑）：按 Worker 单飞（transitioning）跑 work，结束（含失败）后归还会话。
 * 准备期间到期的自动续跑见 transitioning 就让路，所以归还时还要补回它。
 */
export async function prepare<T>(active: MasterRuntime, target: WorkerRef, work: () => Promise<T>): Promise<T> {
	const live = active.liveOf(target.name);
	live.transitioning = true;
	try {
		return await work();
	} finally {
		live.transitioning = undefined;
		returnSession(active, target);
	}
}

/**
 * 准备段或 start 结束后归还会话：hold 取消了池的释放计时，没开成回合就得补回，否则这个热会话不再释放。
 * 票已不在（期间被 kill 或同名换票）就释放它；仍是 idle（准备失败、续跑让路、回合已落定）就补回释放计时与暂停续跑；
 * 进了 working/reviewing 由那次运行落定（runtime.settle）归还。
 */
export function returnSession(active: MasterRuntime, target: WorkerRef): void {
	if (active.closed) return;
	const current = active.find(target);
	if (!current) {
		void active.setup.pool.dispose(target.sessionPath);
		return;
	}
	if (current.status !== "idle") return;
	active.setup.pool.markIdle(target.sessionPath);
	armResume(active, current);
}

/** 子代理会话里的扩展出错：同一处错误只告知指挥官一次（事件处理器每次触发都会再抛）。 */
function reportExtensionError(active: MasterRuntime, worker: WorkerRef, error: ExtensionError): void {
	if (!active.find(worker)) return;
	const live = active.liveOf(worker.name);
	const key = `${error.extensionPath}\n${error.event}\n${error.error}`;
	if (live.reportedErrors.has(key)) return;
	live.reportedErrors.add(key);
	active.enqueue(masterEvent.extensionError(worker.name, tildeHome(error.extensionPath), error.event, error.error), worker.name);
}

/** 投影当前动作、卡住判定与审查进度的唯一订阅。 */
export function observeWorker(active: MasterRuntime, worker: WorkerRef, session: AgentSession): void {
	active.observe(worker, session, (live, event) => {
		if (OUTPUT_EVENTS.has(event.type)) {
			live.quietSince = Date.now();
			if (live.stallReported) {
				live.stallReported = undefined;
				watchStall(active, worker);
			}
		}
		if (event.type === "tool_execution_start") {
			live.currentTools.set(event.toolCallId, { tool: event.toolName, args: event.args });
			active.progress?.toolCall(worker.name, event.toolName, event.args, worker.cwd);
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
 * 停摆唤醒：在跑的回合落入“卡住”（与活动列表同一个 workerPhase 判定、同一份 quietSince）时给指挥官投一条事件。
 * 计时器不另算无输出时长，只在判定可能成立的时刻去看一眼：还没到就按剩余时间重挂，不再 working 就停；
 * 报过后停到下一次输出（observeWorker 清掉标记并重挂），所以同一段无输出只报一次。
 */
function watchStall(active: MasterRuntime, identity: WorkerRef): void {
	const live = active.liveOf(identity.name);
	const check = () => {
		clearTimeout(live.stallTimer);
		live.stallTimer = undefined;
		if (active.closed || active.live.get(identity.name) !== live || live.stallReported) return;
		const current = active.find(identity);
		if (!current) return;
		const now = Date.now();
		const { stallMs } = active.setup.pool.timing;
		const { kind, action, startedAt, quietMs } = workerPhase(active.workerFacts(current), stallMs, now);
		if (quietMs === undefined) return;
		if (kind !== "stuck") {
			live.stallTimer = setTimeout(check, stallMs - quietMs);
			live.stallTimer.unref?.();
			return;
		}
		live.stallReported = true;
		active.enqueue(masterEvent.stalled(identity.name, quietMinutes(quietMs), action, startedAt === undefined ? undefined : now - startedAt), identity.name);
	};
	check();
}

/**
 * 起一个回合：同步挂上 Turn（与档案进入 working 同一同步段），再等会话（start 在这里等开会话）并经宿主开回合；
 * resolve 即回合已在飞或没开成。工作说明是用户消息，经宿主 prompt：它的前置阶段仍报空闲，宿主报 started 才算在飞。
 * 插件自己的续跑提示是机器消息，以自定义消息 + triggerTurn 开回合：宿主同步置忙，发出即在飞。
 * 回合在飞之前到达的 interrupt 只记意图：还没开回合就直接按中断落定、不调模型，否则在飞后由 interrupt 自己中止。
 */
export async function runWorker(active: MasterRuntime, worker: WorkerRef, opening: AgentSession | Promise<AgentSession>, input: string | Delivery): Promise<void> {
	const live = active.liveOf(worker.name);
	const running = Promise.withResolvers<AgentSession | undefined>();
	const turn: Turn = { running: running.promise };
	live.turn = turn;
	try {
		const session = await opening;
		// 启动回合的路径都经这里：准备期间被 kill 的不调模型、不留热会话。
		active.current(worker);
		observeWorker(active, worker, session);
		// 静默从本回合开始算：自动续跑沿用暂停前的运行起点，暂停期不是无输出。
		live.quietSince = Date.now();
		watchStall(active, worker);
		const mine = () => !active.closed && active.live.get(worker.name) === live && live.turn === turn;
		let terminal: WorkerTerminal | undefined;
		const unsubscribeTerminal = session.subscribe((event) => {
			if (mine() && event.type === "agent_end") terminal = captureWorkerTerminal(event.messages);
		});
		const settle = (error?: unknown) => {
			unsubscribeTerminal();
			if (!mine()) return;
			const stranded = session.clearQueue().steering;
			if (stranded.length) active.enqueue(masterEvent.stranded(worker.name, stranded), worker.name);
			if (turn.interrupted) return settleInterrupted(active, worker);
			const pause = error === undefined && terminal?.stopReason === "error" ? routePause(session.model) : undefined;
			if (pause) return pauseWorker(active, worker, pause);
			settleWorker(active, worker, terminal, error);
		};
		const settled = (error?: unknown) => active.detached(worker.name, () => settle(error));
		if (turn.interrupted) return settled();
		if (typeof input !== "string") {
			void session.sendCustomMessage({ ...input, display: true }, { triggerTurn: true }).then(() => settled(), settled);
			running.resolve(session);
			return;
		}
		const preflight = Promise.withResolvers<void>();
		void session.prompt(input, {
			preflightResult: (disposition) => {
				if (disposition === "started") running.resolve(session);
				preflight.resolve();
			},
		})
			.then(() => settled(), settled)
			.finally(() => preflight.resolve());
		await preflight.promise;
	} finally {
		running.resolve(undefined);
	}
}

/**
 * interrupt 在跑或审查中的票：记下意图就返回，不等回合。宿主 prompt 的前置阶段（input 处理器、鉴权）里会话仍报空闲，
 * 那里的 abort 会被静默丢弃，处理器卡住时也没有时限；所以中止等回合真正在飞再做：working 中止回合，reviewing 先在会话里
 * 取消审查（review/outcome.ts 的 CANCEL_REVIEW_COMMAND，与 esc 同一路径）再中止可能在跑的修复/总结回合。
 * 回合没开成就由 runWorker 按意图直接落定为中断、不调模型；结局都经落定事件告知。中止失败时撤回意图，回合按自己的结局落定。
 */
export function interruptTurn(active: MasterRuntime, worker: WorkerRef): void {
	const live = active.liveOf(worker.name);
	const turn = live.turn;
	if (turn.interrupted) return;
	turn.interrupted = true;
	active.detached(worker.name, async () => {
		const session = await turn.running;
		if (!session || active.live.get(worker.name) !== live || live.turn !== turn) return;
		try {
			if (worker.status === "reviewing") {
				await session.prompt(CANCEL_REVIEW_COMMAND);
				if (session.isStreaming) await session.abort();
			} else await session.abort();
		} catch (error) {
			// 中止没成：回合照常跑完，按它自己的结局落定，不误记为中断；失败经 detached 报给用户。
			turn.interrupted = undefined;
			throw error;
		}
	});
}

/**
 * 补话交给在跑的回合：在飞后经宿主 steer 在句缝送达，不打断，调用方不等。steer 会 await 子会话的 input 处理器，
 * 期间回合可能落定或被 kill；送进时回合还是这一个才算送达（delivered 在此时写回）。没开成、已不在流式、已记下中断意图、或送进时回合已结束而
 * 滞留在队列里的，作为“补充说明未送达”事件回报指挥官重发——与落定时清出的滞留补话同一条事件，回合落定后才进队列的由这里清出。
 */
export function steerTurn(active: MasterRuntime, worker: WorkerRef, prompt: string, delivered: () => void): void {
	const live = active.liveOf(worker.name);
	const turn = live.turn;
	const ours = () => active.live.get(worker.name) === live && live.turn === turn && active.find(worker)?.status === "working";
	active.detached(worker.name, async () => {
		const session = await turn.running;
		let stranded = [prompt];
		// 已记下中断意图的回合不再送进：它马上被中止，送进去的话随中断落定沉默。
		if (session?.isStreaming && !turn.interrupted && ours()) {
			await session.steer(prompt);
			if (ours()) return delivered();
			stranded = session.isStreaming ? [] : session.clearQueue().steering;
		}
		if (stranded.length && active.find(worker)) active.enqueue(masterEvent.stranded(worker.name, stranded), worker.name);
	});
}

/** 被中断落定：回合被 interrupt 打断，或审查被 interrupt 取消（review）。两者都回到 idle 并带中断标记，审查义务保留。 */
function settleInterrupted(active: MasterRuntime, identity: WorkerRef, review = false): void {
	const at = Date.now();
	active.settle(identity, (current) => {
		const obligation = current.reviewNeeded === true;
		return {
			worker: transition.interrupted(current, at),
			outcome: { kind: "interrupted" },
			at,
			event: review ? masterEvent.reviewInterrupted(identity.name, obligation) : masterEvent.interrupted(identity.name, obligation, takeViewPrompts(active, identity)),
		};
	});
}

/**
 * 会话重载打断的回合（档案带 reloadInterrupted）：恢复后满时限仍未续派就提醒指挥官；按档案里的中断时刻补算剩余时间，
 * 时限内再 reload 也照样按原时刻提醒。指挥官自己 interrupt 的不带标记、不提醒。提醒的 pending 落进主会话后才清标记（之后由 reload 重投保证送达），
 * 落盘失败就保留标记，reload 后再提醒。
 * 只提醒、不代发“继续”：工作说明归指挥官，插件盲续会复活它已作废的任务。
 */
export function armInterruptReminder(active: MasterRuntime, worker: WorkerRef): void {
	if (active.closed || !worker.reloadInterrupted) return;
	const live = active.liveOf(worker.name);
	clearTimeout(live.interruptTimer);
	const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + active.setup.pool.timing.interruptResumeMs - Date.now());
	live.interruptTimer = setTimeout(() => active.detached(worker.name, () => {
		if (active.closed || active.live.get(worker.name) !== live) return;
		live.interruptTimer = undefined;
		const current = active.find(worker);
		if (!current?.reloadInterrupted || current.interruptedAt !== worker.interruptedAt) return;
		// pending 没落盘时 reload 不会重投这条提醒：标记留着，reload 后照常再提醒。
		if (!active.enqueue(masterEvent.resumeReminder(worker.name), worker.name)) return;
		active.store.upsert(transition.reminded(current));
	}), delay);
	live.interruptTimer.unref?.();
}

/**
 * 瞬时故障暂停：回到 idle 并记下续跑时刻；这次运行第一次暂停时告知指挥官（不唤醒），到时 armResume 自动续跑。
 * “已告知过”只读档案：resume 从第一次暂停起留到这次运行落定（自动续跑不清、reload 不丢，指挥官接手才清），
 * 所以暂停前档案已带 resume 就是同一次运行里的再次暂停。
 */
function pauseWorker(active: MasterRuntime, identity: WorkerRef, pause: ChainPause, review = false): void {
	const paused = active.settle(identity, (current) => ({
		worker: transition.paused(current, { at: pause.until, reason: pause.reason, ...(review ? { review: true as const } : {}) }),
		...(current.resume ? {} : { event: masterEvent.paused(identity.name, pause.until, pause.reason, review), informOnly: true }),
	}));
	if (paused) armResume(active, paused);
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
		else active.detached(worker.name, () => resumeWorker(active, worker, resume));
	}, delayUntil(resume.at));
	live.resumeTimer.unref?.();
}

/**
 * 到时续跑：档案仍是这次暂停（指挥官没有 send/review/interrupt/ack 接手）才续；任务在原会话里以续跑提示开回合，
 * 审查则重新发起 fire-review。本次运行的起点与来源沿用暂停前的，落定事件只有续跑结束的那一条。
 * 续跑准备失败（会话打不开、角色已删）不是瞬时故障，照常作为失败交给指挥官；那时 resume 已被接手清掉就不再报。
 */
async function resumeWorker(active: MasterRuntime, identity: WorkerRef, resume: NonNullable<WorkerRef["resume"]>): Promise<void> {
	const current = active.find(identity);
	if (current?.status !== "idle" || current.resume?.at !== resume.at || active.liveOf(identity.name).transitioning) return;
	await prepare(active, current, async () => {
		try {
			if (resume.review) return await startReview(active, current, true);
			const session = await openWorkerSession(active, current);
			await session.waitForIdle();
			active.assertOpen();
			if (superseded(active, current, resume)) return;
			const working = active.commit(current, (latest) => transition.continued(latest, "working"));
			active.continueRun(identity.name);
			active.progress?.resume(identity.name);
			const prompt = wrapEnvelope("firecode_master_event", msg.run.resumeAfterPause(clip(oneLine(resume.reason), RESUME_REASON_WIDTH)));
			await runWorker(active, working, session, { customType: MASTER_EVENT_TYPE, content: prompt });
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			active.settle(identity, (latest) => latest.resume && {
				worker: transition.landed(latest),
				outcome: { kind: "failed", note: firstSentence(failure) },
				event: masterEvent.failed(identity.name, failure, latest.reviewNeeded === true, takeViewPrompts(active, identity)),
			});
		}
	});
}

/**
 * 续跑准备越过 await 后的核对：档案已不是这次暂停（准备期间指挥官 ack 清掉了 resume）就放弃续跑，会话由 prepare 归还。
 * ack 不等准备结束、也不拒绝：取消还没开跑的续跑正是它的承诺，写回方让路。票被 kill 时 current 抛错，由调用方的失败路径放弃。
 */
function superseded(active: MasterRuntime, identity: WorkerRef, resume: NonNullable<WorkerRef["resume"]>): boolean {
	return active.current(identity).resume?.at !== resume.at;
}

/**
 * 在原 Worker 会话里发起 fire-review（review 动作与暂停后的续审共用）。续审沿用暂停前的运行起点与来源。
 * 先写档案再挂订阅：kill 或会话关闭时 commit 抛错，不会给已删的票留下订阅。
 */
export async function startReview(active: MasterRuntime, target: WorkerRef, resumed = false): Promise<void> {
	const session = await openWorkerSession(active, target);
	await session.waitForIdle();
	active.assertOpen();
	if (resumed && superseded(active, target, target.resume!)) return;
	const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
	active.commit(target, (latest) => (resumed ? transition.continued(latest, "reviewing") : transition.takeOver(latest, "reviewing")));
	const turn: Turn = { running: Promise.resolve(session) };
	active.liveOf(target.name).turn = turn;
	observeWorker(active, target, session);
	if (resumed) active.continueRun(target.name);
	else active.beginRun(target.name);
	monitorAndSettleReview(active, target, session, previousRunId, turn);
}

function settleWorker(active: MasterRuntime, identity: WorkerRef, terminal: WorkerTerminal | undefined, error?: unknown): void {
	const failure = error instanceof Error ? error.message : error === undefined ? terminalFailure(terminal) : String(error);
	active.settle(identity, (current) => {
		const obligation = current.reviewNeeded === true;
		// 活动列表展开行显示结果首句（失败是错误首句），不是千篇一律的“已返回”。
		return failure
			? { worker: transition.landed(current), outcome: { kind: "failed", note: firstSentence(failure) }, event: masterEvent.failed(identity.name, failure, obligation, takeViewPrompts(active, identity)) }
			: { worker: transition.landed(current), outcome: { kind: "done", note: firstSentence(terminal!.text) }, event: masterEvent.returned(identity.name, terminal!.text, obligation, takeViewPrompts(active, identity)) };
	});
}

/** 起审：在原 Worker 会话里跑 /fire-review，终态经 review/outcome.ts 读取后落定并投递。 */
function monitorAndSettleReview(active: MasterRuntime, target: WorkerRef, session: AgentSession, previousRunId: string | undefined, turn: Turn): void {
	// 只认自己这一次审查：期间被 kill 或换了回合的迟到结果作废。
	const mine = () => active.live.get(target.name)?.turn === turn;
	void monitorReview(session, target.sessionPath, previousRunId).then(
		(outcome) => active.detached(target.name, () => {
			if (!mine()) return;
			if (turn.interrupted && outcome.status === "cancelled") return settleInterrupted(active, target, true);
			if (outcome.status === "failed" && outcome.retry) return pauseWorker(active, target, outcome.retry, true);
			const fulfilled = outcome.status === "passed" || outcome.status === "stopped";
			active.settle(target, (current) => ({
				worker: transition.landed(fulfilled ? transition.fulfilled(current) : current),
				outcome: reviewOutcomeRow(outcome),
				event: masterEvent.review(target.name, outcome, textOf(lastAssistant<{ role: string; content?: unknown }>(session.messages)?.content)),
			}));
		}),
		(error) => active.detached(target.name, () => {
			if (!mine()) return;
			active.settle(target, (current) => ({
				worker: transition.landed(current),
				outcome: { kind: "failed", note: msg.run.reviewIncomplete },
				event: masterEvent.reviewIncomplete(target.name, String(error)),
			}));
		}),
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
export const RESUME_CHECK_PROMPT = wrapEnvelope("firecode_master_event", msg.run.resumeCheck);
