/**
 * subagents 七个命令动作：每个动作是一个带类型的命令（名字加它真正用到的输入），工具处理表只把参数解析成命令输入再包成工具结果。
 * 全过程视图直接调 send 与 interrupt，不经工具参数。
 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../config.js";
import { CANCEL_REVIEW_COMMAND } from "../review/outcome.js";
import { compactWorker } from "./list-view.js";
import { msg } from "./messages.js";
import { openWorkerSession, prepare, resumeCheckPrompt, returnSession, runWorker, spawnWorker, startReview } from "./run.js";
import type { MasterRuntime, RunOrigin } from "./runtime.js";
import { transition, WORKER_NAME, type WorkerRef } from "./state.js";
import { workerTrace } from "./trace.js";

export const ACTIONS = ["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const;
export type Action = (typeof ACTIONS)[number];
type Params = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

/** 工具参数里 start/send 用的可选字段（去首尾空白，空串当没给）；必填与取值由各命令按自己的顺序校验。 */
export interface ActionInput {
	worker?: string;
	prompt?: string;
	role?: string;
	thinking?: string;
	cwd?: string;
	review?: boolean;
}

/** 同时 working/reviewing 的 Worker 上限；指挥官开新运行（start、对空闲票 send/review）超出直接拒绝，不排队。 */
const MAX_IN_FLIGHT = 15;

/** 工具入口：调用方身份（origin）不是模型能填的参数，工具发起的一律是指挥官。 */
export const ACTION_HANDLERS: Record<Action, (active: MasterRuntime, params: Params) => Promise<ToolResult>> = {
	start: async (active, params) => toolResult(await start(active, inputOf(params))),
	send: async (active, params) => toolResult(await send(active, nameOf(params), inputOf(params), "master")),
	interrupt: async (active, params) => toolResult(await interrupt(active, nameOf(params))),
	review: async (active, params) => toolResult(await review(active, nameOf(params))),
	tail: async (active, params) => ({ content: [{ type: "text", text: tail(active, nameOf(params)) }], details: undefined }),
	ack: async (active, params) => toolResult(ack(active, nameOf(params))),
	kill: async (active, params) => toolResult(await kill(active, nameOf(params))),
};

/** 为新子代理在主会话目录下的 subagents/ 预分配会话文件路径（不会出现在 /resume）；路径是档案身份的唯一事实源。 */
function preallocateWorkerSession(mainSessionPath: string, cwd: string): string {
	const sessionPath = SessionManager.create(cwd, `${dirname(mainSessionPath)}/subagents`).getSessionFile();
	if (!sessionPath) throw new Error(msg.action.noSessionPath);
	return sessionPath;
}

async function kill(active: MasterRuntime, name: string) {
	const target = active.store.require(name);
	// 同步段内删档案与运行时事实，迟到的异步写回据此全部作废；随后等 session_shutdown 收口释放热会话。
	active.remove(target.name);
	await active.setup.pool.dispose(target.sessionPath);
	return { killed: true };
}

function tail(active: MasterRuntime, name: string): string {
	const target = active.store.require(name);
	return workerTrace(target, active.setup.pool.getSession(target.sessionPath));
}

/** 动作名按模型先验取：曾叫 hold，被读成“暂停”而假成功。名字治误读，非 idle 报错治假成功。 */
function ack(active: MasterRuntime, name: string) {
	const target = active.store.require(name);
	if (target.reviewNeeded) throw new Error(msg.action.ackObligation(target.name));
	if (target.status !== "idle") throw new Error(msg.action.ackStatus(target.name, target.status));
	// ack 清掉失败与被中断的行，并取消还没发出的续跑提醒与暂停后的自动续跑；完成的留在“✓ 已完成”里直到 kill。
	// 先落档：写盘失败时报错，运行时事实也不动。
	if (target.resume || target.reloadInterrupted) active.store.upsert(transition.acked(target));
	const live = active.live.get(target.name);
	if (live) {
		active.cancelTimers(live);
		if (live.outcome && live.outcome.kind !== "done") live.outcome = undefined;
	}
	active.render();
	return { acked: true };
}

async function review(active: MasterRuntime, name: string) {
	if (active.setup.reviewGate) throw new Error(active.setup.reviewGate);
	const target = active.store.require(name);
	const live = active.liveOf(target.name);
	if (target.status !== "idle" || live.transitioning) throw new Error(msg.action.reviewBusy(target.name));
	admit(active);
	await prepare(active, target, () => startReview(active, target));
	return { reviewing: true };
}

/** 与 send 同为全过程视图直接调用的命令。 */
export async function interrupt(active: MasterRuntime, name: string) {
	const target = active.store.require(name);
	if (target.status === "reviewing") return interruptReview(active, target);
	if (target.status === "idle" && target.resume) return interruptPause(active, target);
	if (target.status !== "working") throw new Error(msg.action.interruptStatus(target.name, target.status));
	// 先记意图、等回合真正在飞再中止：开会话与宿主前置阶段里的 abort 会被丢弃；没开成的回合按意图直接落定为中断。
	const turn = active.liveOf(target.name).turn!;
	turn.interrupted = true;
	try {
		await (await turn.running)?.abort();
		active.assertOpen();
		return { interrupted: true };
	} catch (error) {
		turn.interrupted = undefined;
		throw error;
	}
}

/** 暂停中的子代理：取消自动续跑，按被中断落定（会话与审查义务保留，等指挥官续派或收口）。 */
async function interruptPause(active: MasterRuntime, target: WorkerRef) {
	if (active.live.get(target.name)?.transitioning) throw new Error(msg.action.switching(target.name));
	active.cancelTimers(active.liveOf(target.name));
	const at = Date.now();
	active.settle(target, (current) => ({ worker: transition.interrupted(current, at), outcome: { kind: "interrupted" }, at }));
	return { interrupted: true };
}

/**
 * 审查中的子代理：先在它的会话里取消审查（review/outcome.ts 的 CANCEL_REVIEW_COMMAND，与 esc 取消同一路径，终态 checkpoint 照写），
 * 再中止会话里可能在跑的修复/总结回合。落定由审查监视（run.ts）看到取消的终态后按中断处理：回到 idle、带中断标记、审查义务保留。
 */
async function interruptReview(active: MasterRuntime, target: WorkerRef) {
	const turn = active.liveOf(target.name).turn!;
	const session = (await turn.running)!;
	turn.interrupted = true;
	try {
		await session.prompt(CANCEL_REVIEW_COMMAND);
		if (session.isStreaming) await session.abort();
		active.assertOpen();
		return { interrupted: true };
	} catch (error) {
		turn.interrupted = undefined;
		throw error;
	}
}

/** origin 是调用方（指挥官的工具 / 全过程视图）的身份，不是模型能填的参数。 */
export async function send(active: MasterRuntime, name: string, input: ActionInput, origin: RunOrigin) {
	const { reviewGate, pool } = active.setup;
	const { roles } = active;
	if (input.review && reviewGate) throw new Error(reviewGate);
	const target = active.store.require(name);
	const live = active.liveOf(target.name);
	if (live.transitioning) throw new Error(msg.action.switching(target.name));
	const { role: requestedRole, thinking: requestedThinking, cwd: requestedCwd } = input;
	const prompt = requiredString(input.prompt, "prompt");
	const selection = requestedRole ? roles.require(requestedRole) : undefined;
	// 子代理全过程视图的补话走同一入口，只多一个来源标记：视图起的运行指挥官不在等（见 RunOrigin），
	// 落定事件注明是用户在视图里直接派的；视图补进别人起的运行只记原话，不改来源。
	const fromView = origin === "view";
	if (target.status === "working" && !requestedRole && !requestedThinking && !requestedCwd) {
		const result = await steer(active, target, prompt, input.review === true);
		if (fromView) live.viewPrompts.push(prompt);
		else if (live.origin !== "master") {
			live.origin = "master";
			active.render();
		}
		return result;
	}
	if (target.status === "working") throw new Error(msg.action.workingSwitch(target.name));
	if (target.status !== "idle") throw new Error(msg.action.reviewingSend(target.name));
	const thinkingOverride = validThinking(requestedThinking);
	admit(active);
	return prepare(active, target, async () => {
		const cwd = await resolveSendCwd(target, requestedCwd);
		if (cwd !== target.cwd) await pool.dispose(target.sessionPath);
		const selectedRole = selection ?? roles.require(target.role);
		// 只核对角色此刻可用：档案的模型原子等路由选定后由 onModelChange 写（run.ts）。
		await roles.resolve(selectedRole, thinkingOverride);
		// 上面的 await 期间票可能已被 kill：先核对当前档案，再开会话，不为已删的票起热会话。
		active.current(target);
		const role = selectedRole.role;
		const session = await openWorkerSession(active, { ...target, cwd, role }, thinkingOverride);
		await session.waitForIdle();
		active.assertOpen();
		pool.configureRoute(target.sessionPath, selectedRole.models, thinkingOverride);
		// 被中断或暂停中（回合断在半路）的票，首次续派前置现场核对。
		const latest = active.current(target);
		const cutOff = latest.interruptedAt !== undefined || latest.resume !== undefined;
		const working = active.commit(target, (current) => ({
			...transition.takeOver(current, "working"),
			role,
			cwd,
			...(input.review ? { reviewNeeded: true } : {}),
		}));
		active.beginRun(target.name, fromView ? "view" : "master", prompt);
		if (fromView) live.viewPrompts.push(prompt);
		await runWorker(active, working, session, cutOff ? `${resumeCheckPrompt()}\n\n${prompt}` : prompt);
		return { sent: true };
	});
}

/**
 * working Worker 的普通 send 经宿主 steer 在句缝送达，不打断。回合还在开会话或宿主前置阶段时先等它在飞；没开成就报未送达。
 * steer 会 await 子会话的 input 处理器：期间可能落定或被 kill，写回只认重读后的档案；回合已结束时清掉滞留队列并报未送达。
 */
async function steer(active: MasterRuntime, target: WorkerRef, prompt: string, review: boolean) {
	const session = await active.liveOf(target.name).turn!.running;
	active.current(target);
	if (!session) throw new Error(msg.action.notDelivered(target.name));
	if (!session.isStreaming) throw new Error(msg.action.finishing(target.name));
	await session.steer(prompt);
	if (active.current(target).status !== "working") {
		session.clearQueue();
		throw new Error(msg.action.notDelivered(target.name));
	}
	if (review) active.commit(target, (latest) => ({ ...latest, reviewNeeded: true }));
	return { steered: true };
}

async function start(active: MasterRuntime, input: ActionInput) {
	const { reviewGate } = active.setup;
	const { ctx } = active;
	if (input.review && reviewGate) throw new Error(reviewGate);
	const name = input.worker;
	if (!name) throw new Error(msg.action.needWorker);
	validateWorkerName(name);
	if (active.store.find(name) || active.live.get(name)?.starting)
		throw new Error(msg.action.exists(name));
	admit(active);
	const prompt = requiredString(input.prompt, "prompt");
	const requestedRole = input.role;
	if (!requestedRole) throw new Error(msg.action.needRole);
	const selectedRole = active.roles.require(requestedRole);
	const override = validThinking(input.thinking);
	const { live, launch } = active.reserve(name);
	try {
		const selected = await active.roles.resolve(selectedRole, override);
		const thinking = selected.thinking;
		const cwd = await resolveWorkerCwd(input.cwd ?? ctx.cwd);
		active.assertOpen();
		const mainSessionPath = ctx.sessionManager.getSessionFile();
		if (!mainSessionPath) throw new Error(msg.action.mainNotSaved);
		const worker: WorkerRef = {
			name,
			role: selectedRole.role,
			model: selected.model,
			thinking,
			status: "working",
			sessionPath: preallocateWorkerSession(mainSessionPath, cwd),
			cwd,
			launch,
			...(input.review ? { reviewNeeded: true } : {}),
		};
		active.store.upsert(worker);
		live.starting = undefined;
		active.beginRun(name, "master", prompt);
		try {
			await runWorker(active, worker, spawnWorker(active, worker, false, override), prompt);
		} finally {
			// 开会话期间被 kill：新开的会话没人要了，在这里释放。
			returnSession(active, worker);
		}
		return { started: true, worker: compactWorker(worker) };
	} catch (error) {
		// 只撤自己这一票：kill 后同名重开的新票不受影响。
		if (!active.closed && active.live.get(name) === live) active.remove(name, live);
		throw error;
	}
}

/**
 * 在飞上限：数 working/reviewing 的票、还没落档的 start，以及正在准备 send/review 的票（越过准备段的 await 后才写 working，
 * 不算进去的话并行 send 能一起越过上限）。暂停后的自动续跑是已放行的那次运行接着跑，不经这里，可能短暂越过上限。
 */
function admit(active: MasterRuntime): void {
	const busy = active.store.workers.flatMap((worker) =>
		worker.status !== "idle" || active.live.get(worker.name)?.transitioning ? [worker.name] : []);
	const starting = [...active.live].flatMap(([name, live]) => (live.starting ? [name] : []));
	if (busy.length + starting.length >= MAX_IN_FLIGHT)
		throw new Error(msg.action.limit(MAX_IN_FLIGHT, [...busy, ...starting]));
}

function toolResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function nameOf(params: Params): string {
	return requiredString(params.worker, "worker");
}

function inputOf(params: Params): ActionInput {
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	return {
		worker: text(params.worker), prompt: text(params.prompt), role: text(params.role), thinking: text(params.thinking), cwd: text(params.cwd),
		review: params.review === true,
	};
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(msg.action.empty(field));
	return value.trim();
}

function validThinking(value: string | undefined): WorkerRef["thinking"] | undefined {
	if (value && !THINKING_LEVELS.includes(value as WorkerRef["thinking"])) throw new Error(msg.action.badThinking(value));
	return value as WorkerRef["thinking"] | undefined;
}

function validateWorkerName(name: string): void {
	if (!WORKER_NAME.test(name)) throw new Error(msg.action.badName);
}

async function resolveWorkerCwd(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error(msg.action.cwdAbsolute);
	try {
		return await realpath(path);
	} catch {
		throw new Error(msg.action.cwdMissing(path));
	}
}

async function resolveSendCwd(worker: WorkerRef, requested: string | undefined): Promise<string | undefined> {
	if (requested) return resolveWorkerCwd(requested);
	if (worker.cwd && !existsSync(worker.cwd))
		throw new Error(msg.action.cwdGone(worker.name, worker.cwd));
	return worker.cwd;
}
