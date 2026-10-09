/** subagents 七个命令动作：每个动作一个处理函数，表驱动分发。 */
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type MasterRole } from "../config.js";
import { textOf } from "../format.js";
import { readReviewOutcome } from "../review/outcome.js";
import { compactWorker } from "./list-view.js";
import { msg } from "./messages.js";
import {
	monitorAndSettleReview, observeWorker, openWorkerSession, resumeCheckPrompt, reviewRunId, runWorker, spawnWorker,
} from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import { WORKER_NAME, type WorkerRef } from "./state.js";

export const ACTIONS = ["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const;
export type Action = (typeof ACTIONS)[number];
type Params = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
type Handler = (active: MasterRuntime, params: Params, ctx: ExtensionContext) => Promise<ToolResult>;

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
	return { content: [{ type: "text", text: await readWorkerTrace(target) }], details: undefined };
}

/** 动作名按模型先验取：曾叫 hold，被读成“暂停”而假成功。名字治误读，非 idle 报错治假成功。 */
async function ack(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
	if (target.reviewNeeded) throw new Error(msg.action.ackObligation(target.name));
	if (target.status !== "idle") throw new Error(msg.action.ackStatus(target.name, target.status));
	if (target.disposition) {
		const { disposition: _disposition, ...rest } = target;
		active.store.upsert(rest);
	}
	// ack 发落失败与被中断的行；完成的留在“✓ N 个已完成”里直到 kill。
	const live = active.live.get(target.name);
	if (live?.outcome && live.outcome.kind !== "done") live.outcome = undefined;
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
		observeWorker(active, target, session);
		const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
		active.commit(target, ({ disposition: _disposition, interruptedAt: _interruptedAt, ...rest }) => ({ ...rest, status: "reviewing" }));
		active.beginRun(target.name);
		monitorAndSettleReview(active, target, session, previousRunId);
		return toolResult({ reviewing: true });
	} finally {
		live.transitioning = undefined;
	}
}

async function interrupt(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = targetOf(active, params);
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

async function send(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const { reviewGate, pool, roster } = active.setup;
	if (params.review === true && reviewGate) throw new Error(reviewGate);
	const target = targetOf(active, params);
	const live = active.liveOf(target.name);
	if (live.transitioning) throw new Error(msg.action.switching(target.name));
	const requestedRole = optionalString(params.role);
	const requestedThinking = optionalString(params.thinking);
	const requestedCwd = optionalString(params.cwd);
	const prompt = requiredString(params.prompt, "prompt");
	validateDelegationText(prompt);
	// 子代理全过程视图的补话走同一入口，只多一个来源标记：视图起的运行指挥官不在等（见 RunOrigin），
	// 落定事件注明是用户在视图里直接派的；视图补进别人起的运行只记原话，不改来源。
	const fromView = params.origin === "view";
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
	const selection = requestedRole ? resolveRole(roster, requestedRole) : undefined;
	const thinkingOverride = validThinking(requestedThinking);
	live.transitioning = true;
	try {
		const cwd = await resolveSendCwd(target, requestedCwd);
		if (cwd !== target.cwd) await pool.dispose(target.sessionPath);
		const nextModel = selection ? await pool.resolveModel(selection.model) : undefined;
		active.assertOpen();
		const session = await openWorkerSession(active, { ...target, cwd });
		await session.waitForIdle();
		active.assertOpen();
		let { role, model, thinking } = target;
		if (selection && nextModel) {
			await session.setModel(nextModel);
			active.assertOpen();
			({ role, model, thinking } = selection);
		}
		if (selection || thinkingOverride) {
			thinking = thinkingOverride ?? thinking;
			session.setThinkingLevel(thinking);
		}
		const interruptedAt = active.current(target).interruptedAt;
		const working = active.commit(target, ({ disposition: _disposition, interruptedAt: _interrupted, ...rest }) => ({
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
	validateDelegationText(prompt);
	const requestedRole = optionalString(params.role);
	if (!requestedRole) throw new Error(msg.action.needRole);
	const selectedRole = resolveRole(roster, requestedRole);
	const thinking = validThinking(optionalString(params.thinking)) ?? selectedRole.thinking;
	const { live, launch } = active.reserve(name);
	try {
		const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
		active.assertOpen();
		const mainSessionPath = ctx.sessionManager.getSessionFile();
		if (!mainSessionPath) throw new Error(msg.action.mainNotSaved);
		const worker: WorkerRef = {
			name,
			role: selectedRole.role,
			model: selectedRole.model,
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
		const session = await spawnWorker(active, worker, false);
		await runWorker(active, worker, session, prompt);
		return toolResult({ started: true, worker: compactWorker(worker) });
	} catch (error) {
		// 只撤自己这一票：kill 后同名重开的新票不受影响。
		if (!active.closed && active.live.get(name) === live) active.remove(name, live);
		throw error;
	}
}

async function readWorkerTrace(worker: WorkerRef): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(worker.sessionPath, "utf8");
	} catch (error) {
		throw new Error(msg.action.traceUnreadable(worker.name, error instanceof Error ? error.message : String(error)));
	}
	const lines: string[] = [];
	for (const line of raw.split(/\r?\n/u)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry.type !== "message" || !entry.message?.role) continue;
			const text = textOf(entry.message.content);
			if (text) lines.push(`${entry.message.role}: ${text}`);
		} catch {
			// 正在追加的尾行可暂时不完整；近况保留此前完整记录。
		}
	}
	return `${msg.action.traceHeader(worker.name, worker.status)}\n${lines.join("\n").slice(-4_000)}`;
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

/** 宿主已按 schema 枚举校验过 role，这里只查表。 */
function resolveRole(roles: MasterRole[], role: string): MasterRole {
	return roles.find((candidate) => candidate.role === role)!;
}

function validateWorkerName(name: string): void {
	if (!WORKER_NAME.test(name)) throw new Error(msg.action.badName);
}

function validateDelegationText(prompt: string): void {
	const text = prompt.trimStart();
	if (/^\/skills?:/u.test(text) && !text.startsWith("/skill:tdd ")) throw new Error(msg.action.delegationSkill);
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
