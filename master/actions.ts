/** subagents 七个命令动作：每个动作一个处理函数，表驱动分发。 */
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MasterRole } from "../config.js";
import { textOf } from "../format.js";
import { readReviewOutcome } from "../review/outcome.js";
import { compactWorker } from "./list-view.js";
import {
	monitorAndSettleReview, observeWorker, openWorkerSession, resumeCheckPrompt, reviewRunId, runWorker, spawnWorker,
} from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import { preallocateWorkerSession } from "./spawn.js";
import { requireWorker, THINKING_LEVELS, type WorkerRef } from "./state.js";

export const ACTIONS = ["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const;
export type Action = (typeof ACTIONS)[number];
type Params = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
type Handler = (active: MasterRuntime, params: Params, ctx: ExtensionContext) => Promise<ToolResult>;

/** 同时 working/reviewing 的 Worker 上限；超出直接拒绝，不排队。 */
const MAX_IN_FLIGHT = 15;

export const ACTION_HANDLERS: Record<Action, Handler> = { start, send, interrupt, review, tail, ack, kill };

async function kill(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	// 同步段内删档案与运行时事实，迟到的异步写回据此全部作废；随后等 session_shutdown 收口释放热会话。
	active.remove(target.name);
	await active.setup.pool.dispose(target.sessionPath);
	return toolResult({ killed: true });
}

async function tail(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	return { content: [{ type: "text", text: await readWorkerTrace(target) }], details: undefined };
}

/** 动作名按模型先验取：曾叫 hold，被读成“暂停”而假成功。名字治误读，非 idle 报错治假成功。 */
async function ack(active: MasterRuntime, params: Params): Promise<ToolResult> {
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	if (target.reviewNeeded) throw new Error(`${target.name} 此票有审查义务，完成 review 后才能 ack`);
	if (target.status !== "idle") throw new Error(`${target.name} 正在 ${target.status}，不能 ack`);
	if (target.disposition) {
		const { disposition: _disposition, ...rest } = target;
		active.store.dispatch({ type: "UPSERT_WORKER", worker: rest });
	}
	// ack 发落失败与被中断的行；完成的留在“✓ N 个已完成”里直到 kill。
	const live = active.live.get(target.name);
	if (live?.outcome && live.outcome.kind !== "done") live.outcome = undefined;
	active.render();
	return toolResult({ acked: true });
}

async function review(active: MasterRuntime, params: Params): Promise<ToolResult> {
	if (active.setup.reviewGate) throw new Error(active.setup.reviewGate);
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	const live = active.liveOf(target.name);
	if (target.status !== "idle" || live.transitioning) throw new Error(`${target.name} 正在处理其他动作，不能 review`);
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
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	if (target.status !== "working") throw new Error(`${target.name} 当前是 ${target.status}，不能 interrupt`);
	const session = active.setup.pool.getSession(target.sessionPath);
	if (!session) throw new Error(`${target.name} 的进程内会话已释放，无法 interrupt`);
	const live = active.liveOf(target.name);
	const run = live.run;
	if (!run) throw new Error(`${target.name} 当前没有可中断的回合`);
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
	const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
	const live = active.liveOf(target.name);
	if (live.transitioning) throw new Error(`${target.name} 正在切换，稍后再 send`);
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
	if (target.status === "working") throw new Error(`${target.name} 正在工作；切换 role/thinking/cwd 需先 interrupt`);
	if (target.status !== "idle") throw new Error(`${target.name} 正在审查，等落定再 send`);
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
	if (!session?.isStreaming) throw new Error(`${target.name} 回合正在收尾，稍后再 send`);
	await session.steer(prompt);
	if (active.current(target).status !== "working") {
		session.clearQueue();
		throw new Error(`${target.name} 的回合已结束，补充说明未送达，请重新 send`);
	}
	if (review) active.commit(target, (latest) => ({ ...latest, reviewNeeded: true }));
	return toolResult({ steered: true });
}

async function start(active: MasterRuntime, params: Params, ctx: ExtensionContext): Promise<ToolResult> {
	const { reviewGate, roster } = active.setup;
	if (params.review === true && reviewGate) throw new Error(reviewGate);
	if (typeof params.worker !== "string" || !params.worker.trim())
		throw new Error("start 需要 worker：给子代理起个简短任务名（如 fix-auth、repo-scan）");
	const name = params.worker.trim();
	validateWorkerName(name);
	const starting = [...active.live].flatMap(([candidate, live]) => (live.starting ? [candidate] : []));
	if (active.store.state.workers.some((worker) => worker.name === name) || starting.includes(name))
		throw new Error(`子代理已存在：${name}`);
	const inFlight = active.store.state.workers.filter((worker) => worker.status === "working" || worker.status === "reviewing");
	if (inFlight.length + starting.length >= MAX_IN_FLIGHT)
		throw new Error(`Worker 并发上限 ${MAX_IN_FLIGHT}，当前在飞：${[...inFlight.map((worker) => worker.name), ...starting].join("、")}`);
	const prompt = requiredString(params.prompt, "prompt");
	validateDelegationText(prompt);
	const selectedRole = resolveRole(roster, requiredString(params.role, "start 必须指定 role"));
	const thinking = validThinking(optionalString(params.thinking)) ?? selectedRole.thinking;
	const { live, launch } = active.reserve(name);
	try {
		const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
		active.assertOpen();
		const mainSessionPath = ctx.sessionManager.getSessionFile();
		if (!mainSessionPath) throw new Error("主会话尚未落盘，无法创建子代理会话目录");
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
		active.store.dispatch({ type: "UPSERT_WORKER", worker });
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
		throw new Error(`无法读取子代理 ${worker.name} 会话：${error instanceof Error ? error.message : String(error)}`);
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
	return `子代理 ${worker.name} 近况（${worker.status}）\n${lines.join("\n").slice(-4_000)}`;
}

function toolResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validThinking(value: string | undefined): WorkerRef["thinking"] | undefined {
	if (value && !THINKING_LEVELS.includes(value as WorkerRef["thinking"])) throw new Error(`thinking 值无效：${value}`);
	return value as WorkerRef["thinking"] | undefined;
}

/** 宿主已按 schema 枚举校验过 role，这里只查表。 */
function resolveRole(roles: MasterRole[], role: string): MasterRole {
	return roles.find((candidate) => candidate.role === role)!;
}

function validateWorkerName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new Error("Worker name 必须匹配 [a-z][a-z0-9_-]{0,31}");
}

function validateDelegationText(prompt: string): void {
	const text = prompt.trimStart();
	if (/^\/skills?:/u.test(text) && !text.startsWith("/skill:tdd ")) throw new Error("委派文本只允许 /skill:tdd 技能前缀");
}

async function resolveWorkerCwd(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error("cwd 必须是已存在的绝对目录");
	try {
		return await realpath(path);
	} catch {
		throw new Error(`cwd 不存在：${path}`);
	}
}

async function resolveSendCwd(worker: WorkerRef, requested: string | undefined): Promise<string | undefined> {
	if (requested) return resolveWorkerCwd(requested);
	if (worker.cwd && !existsSync(worker.cwd))
		throw new Error(`${worker.name} 的 cwd 已不存在：${worker.cwd}；send 请带 cwd 指向新检出`);
	return worker.cwd;
}
