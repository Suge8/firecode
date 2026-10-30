/** subagents 七个命令动作：每个动作一个处理函数，表驱动分发。 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type MasterRole, type ModelAtom, type ThinkingLevelValue } from "../config.js";
import { CANCEL_REVIEW_COMMAND, readReviewOutcome } from "../review/outcome.js";
import { compactWorker } from "./list-view.js";
import { msg } from "./messages.js";
import {
	monitorAndSettleReview, observeWorker, openWorkerSession, resumeCheckPrompt, reviewRunId, runWorker, spawnWorker,
} from "./run.js";
import type { MasterRuntime, RunOrigin } from "./runtime.js";
import { WORKER_NAME, type WorkerRef } from "./state.js";
import { workerTrace } from "./trace.js";

export const ACTIONS = ["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const;
export type Action = (typeof ACTIONS)[number];
type Params = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
/** origin 是调用方（指挥官的工具 / 全过程视图）的身份，不是模型能填的参数，所以不进 params。 */
type Handler = (active: MasterRuntime, params: Params, ctx: ExtensionContext, origin: RunOrigin) => Promise<ToolResult>;

/** 同时 working/reviewing 的 Worker 上限；超出直接拒绝，不排队。 */
const MAX_IN_FLIGHT = 15;

export const ACTION_HANDLERS: Record<Action, Handler> = { start, send, interrupt, review, tail, ack, kill };

/** 为新子代理在主会话目录下的 subagents/ 预分配会话文件路径（不会出现在 /resume）；路径是档案身份的唯一事实源。 */
function preallocateWorkerSession(mainSessionPath: string, cwd: string): string {
	const sessionPath = SessionManager.create(cwd, `${dirname(mainSessionPath)}/subagents`).getSessionFile();
	if (!sessionPath) throw new Error(msg.action.noSessionPath);
	return sessionPath;
}

async function kill(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
	// 同步段内删档案与运行时事实，迟到的异步写回据此全部作废；随后等 session_shutdown 收口释放热会话。
	active.remove(target.name);
	await active.setup.pool.dispose(target.sessionPath);
	return toolResult({ killed: true });
}

async function tail(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
	return { content: [{ type: "text", text: workerTrace(target, active.setup.pool.getSession(target.sessionPath)) }], details: undefined };
}

/** 动作名按模型先验取：曾叫 hold，被读成“暂停”而假成功。名字治误读，非 idle 报错治假成功。 */
async function ack(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
	if (target.reviewNeeded) throw new Error(msg.action.ackObligation(target.name));
	if (target.status !== "idle") throw new Error(msg.action.ackStatus(target.name, target.status));
	// ack 清掉失败与被中断的行，并取消还没发出的续跑提醒；完成的留在“✓ N 个已完成”里直到 kill。
	const live = active.live.get(target.name);
	if (live) {
		clearTimeout(live.interruptTimer);
		live.interruptTimer = undefined;
		if (live.outcome && live.outcome.kind !== "done") live.outcome = undefined;
	}
	active.render();
	return toolResult({ acked: true });
}

async function review(active: MasterRuntime, params: Params): Promise<ToolResult> {
	if (active.setup.reviewGate) throw new Error(active.setup.reviewGate);
	const target = targetOf(active, params);
	const live = active.liveOf(target.name);
	if (target.status !== "idle" || live.transitioning) throw new Error(msg.action.reviewBusy(target.name));
	live.transitioning = true;
	try {
		const session = await openWorkerSession(active, target);
		await session.waitForIdle();
		active.assertOpen();
		const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
		// 先写档案再挂订阅：kill 或会话关闭时 commit 抛错，不会给已删的票留下订阅。
		active.commit(target, ({ interruptedAt: _interruptedAt, ...rest }) => ({ ...rest, status: "reviewing" }));
		observeWorker(active, target, session);
		active.beginRun(target.name);
		monitorAndSettleReview(active, target, session, previousRunId);
		return toolResult({ reviewing: true });
	} catch (error) {
		rearmRelease(active, target);
		throw error;
	} finally {
		live.transitioning = undefined;
	}
}

async function interrupt(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
	if (target.status === "reviewing") return interruptReview(active, target);
	if (target.status !== "working") throw new Error(msg.action.interruptStatus(target.name, target.status));
	const session = active.setup.pool.getSession(target.sessionPath);
	if (!session) throw new Error(msg.action.sessionReleased(target.name));
	const live = active.liveOf(target.name);
	const run = live.run;
	if (!run) throw new Error(msg.action.noRun(target.name));
	live.interruptedRun = run;
	try {
		await session.abort();
		active.assertOpen();
		return toolResult({ interrupted: true });
	} catch (error) {
		if (live.interruptedRun === run) live.interruptedRun = undefined;
		throw error;
	}
}

/**
 * 审查中的子代理：先在它的会话里取消审查（review/outcome.ts 的 CANCEL_REVIEW_COMMAND，与 esc 取消同一路径，终态 checkpoint 照写），
 * 再中止会话里可能在跑的修复/总结回合。落定由审查监视（run.ts）看到取消的终态后按中断处理：回到 idle、带中断标记、审查义务保留。
 */
async function interruptReview(active: MasterRuntime, target: WorkerRef): Promise<ToolResult> {
	const session = active.setup.pool.getSession(target.sessionPath);
	if (!session) throw new Error(msg.action.sessionReleased(target.name));
	const live = active.liveOf(target.name);
	live.interruptedReview = true;
	try {
		await session.prompt(CANCEL_REVIEW_COMMAND);
		if (session.isStreaming) await session.abort();
		active.assertOpen();
		return toolResult({ interrupted: true });
	} catch (error) {
		live.interruptedReview = undefined;
		throw error;
	}
}

async function send(active: MasterRuntime, params: Params, _ctx: ExtensionContext, origin: RunOrigin): Promise<ToolResult> {
	const { reviewGate, pool, roster } = active.setup;
	if (params.review === true && reviewGate) throw new Error(reviewGate);
	const target = targetOf(active, params);
	const live = active.liveOf(target.name);
	if (live.transitioning) throw new Error(msg.action.switching(target.name));
	const requestedRole = optionalString(params.role);
	const requestedThinking = optionalString(params.thinking);
	const requestedCwd = optionalString(params.cwd);
	const prompt = requiredString(params.prompt, "prompt");
	const selection = requestedRole ? resolveRole(roster, requestedRole) : undefined;
	// 子代理全过程视图的补话走同一入口，只多一个来源标记：视图起的运行指挥官不在等（见 RunOrigin），
	// 落定事件注明是用户在视图里直接派的；视图补进别人起的运行只记原话，不改来源。
	const fromView = origin === "view";
	if (target.status === "working" && !requestedRole && !requestedThinking && !requestedCwd) {
		const result = await steer(active, target, prompt, params.review === true);
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
	live.transitioning = true;
	try {
		const cwd = await resolveSendCwd(target, requestedCwd);
		if (cwd !== target.cwd) await pool.dispose(target.sessionPath);
		const selectedRole = selection ?? resolveRole(roster, target.role);
		const selected = await resolveRoleModel(active, selectedRole, thinkingOverride);
		// 上面的 await 期间票可能已被 kill：先核对当前档案，再开会话，不为已删的票起热会话。
		active.current(target);
		const session = await openWorkerSession(active, { ...target, cwd, role: selectedRole.role, ...selected }, thinkingOverride);
		await session.waitForIdle();
		active.assertOpen();
		pool.configureRoute(target.sessionPath, selectedRole.models, thinkingOverride);
		const role = selectedRole.role;
		const model = target.model;
		const thinking = target.thinking;
		const interruptedAt = active.current(target).interruptedAt;
		const working = active.commit(target, ({ interruptedAt: _interrupted, ...rest }) => ({
			...rest,
			role,
			model,
			thinking,
			cwd,
			status: "working",
			...(params.review === true || rest.reviewNeeded ? { reviewNeeded: true } : {}),
		}));
		active.beginRun(target.name, fromView ? "view" : "master");
		if (fromView) live.viewPrompts.push(prompt);
		await runWorker(active, working, session, interruptedAt ? `${resumeCheckPrompt()}\n\n${prompt}` : prompt);
		return toolResult({ sent: true });
	} catch (error) {
		rearmRelease(active, target);
		throw error;
	} finally {
		live.transitioning = undefined;
	}
}

/**
 * working Worker 的普通 send 经宿主 steer 在句缝送达，不打断。steer 会 await 子会话的 input 处理器：
 * 期间可能落定或被 kill，写回只认重读后的档案；回合已结束时清掉滞留队列并报未送达。
 */
async function steer(active: MasterRuntime, target: WorkerRef, prompt: string, review: boolean): Promise<ToolResult> {
	const session = active.setup.pool.getSession(target.sessionPath);
	if (!session?.isStreaming) throw new Error(msg.action.finishing(target.name));
	await session.steer(prompt);
	if (active.current(target).status !== "working") {
		session.clearQueue();
		throw new Error(msg.action.notDelivered(target.name));
	}
	if (review) active.commit(target, (latest) => ({ ...latest, reviewNeeded: true }));
	return toolResult({ steered: true });
}

async function start(active: MasterRuntime, params: Params, ctx: ExtensionContext): Promise<ToolResult> {
	const { reviewGate, roster } = active.setup;
	if (params.review === true && reviewGate) throw new Error(reviewGate);
	if (typeof params.worker !== "string" || !params.worker.trim())
		throw new Error(msg.action.needWorker);
	const name = params.worker.trim();
	validateWorkerName(name);
	const starting = [...active.live].flatMap(([candidate, live]) => (live.starting ? [candidate] : []));
	if (active.store.find(name) || starting.includes(name))
		throw new Error(msg.action.exists(name));
	const inFlight = active.store.workers.filter((worker) => worker.status === "working" || worker.status === "reviewing");
	if (inFlight.length + starting.length >= MAX_IN_FLIGHT)
		throw new Error(msg.action.limit(MAX_IN_FLIGHT, [...inFlight.map((worker) => worker.name), ...starting]));
	const prompt = requiredString(params.prompt, "prompt");
	const requestedRole = optionalString(params.role);
	if (!requestedRole) throw new Error(msg.action.needRole);
	const selectedRole = resolveRole(roster, requestedRole);
	const override = validThinking(optionalString(params.thinking));
	const { live, launch } = active.reserve(name);
	try {
		const selected = await resolveRoleModel(active, selectedRole, override);
		const thinking = selected.thinking;
		const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
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
			...(params.review === true ? { reviewNeeded: true } : {}),
		};
		active.store.upsert(worker);
		live.starting = undefined;
		active.beginRun(name);
		const session = await spawnWorker(active, worker, false, override);
		await runWorker(active, worker, session, prompt);
		return toolResult({ started: true, worker: compactWorker(worker) });
	} catch (error) {
		// 只撤自己这一票：kill 后同名重开的新票不受影响。
		if (!active.closed && active.live.get(name) === live) active.remove(name, live);
		throw error;
	}
}

/** 准备段失败而票仍是 idle：openWorkerSession 取消了池的释放计时，这里补回，否则这个热会话再也不会被释放。 */
function rearmRelease(active: MasterRuntime, target: WorkerRef): void {
	if (active.find(target)?.status === "idle") active.setup.pool.markIdle(target.sessionPath);
}

function toolResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function targetOf(active: MasterRuntime, params: Params): WorkerRef {
	return active.store.require(requiredString(params.worker, "worker"));
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(msg.action.empty(field));
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validThinking(value: string | undefined): WorkerRef["thinking"] | undefined {
	if (value && !THINKING_LEVELS.includes(value as WorkerRef["thinking"])) throw new Error(msg.action.badThinking(value));
	return value as WorkerRef["thinking"] | undefined;
}

async function resolveRoleModel(active: MasterRuntime, role: MasterRole, override?: ThinkingLevelValue): Promise<ModelAtom> {
	const { pool, roster } = active.setup;
	const selected = await pool.resolveChain(role.models, override);
	if (selected) return selected;
	const checks = await Promise.all(roster.map(async (candidate) => !!(await pool.resolveChain(candidate.models))));
	const available = roster.filter((_candidate, index) => checks[index]).map((candidate) => candidate.role).join(", ");
	throw new Error(msg.run.roleGone(role.role, available));
}

/** 宿主已按 schema 枚举校验过 role，这里只查表。 */
function resolveRole(roles: MasterRole[], role: string): MasterRole {
	const found = roles.find((candidate) => candidate.role === role);
	if (!found) throw new Error(msg.run.roleGone(role, roles.map((candidate) => candidate.role).join(", ")));
	return found;
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
