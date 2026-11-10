/**
 * subagents 七个命令动作：每个动作是一个带类型的命令（名字加它真正用到的输入），只经 commands 调用；工具处理表只把参数解析成
 * 命令输入再包成工具结果，全过程视图直接调 commands.send 与 commands.interrupt，不经工具参数。
 *
 * 动作不无界阻塞：返回路径上不 await 宿主或扩展的回调（开会话、input/agent_settled/session_shutdown 处理器、供应商鉴权都没有时限）。
 * 校验与写档在同一同步段里做完就返回（只碰本地文件系统的同步调用），开会话、开回合、释放会话都在后台，结局经落定事件告知。
 * 同一同步段也让同一 Worker 上的并发动作不必另设单飞：后到的动作看到的已是写好的档案。
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../config.js";
import { msg } from "./messages.js";
import { interruptTurn, reopen, RESUME_CHECK_PROMPT, runWorker, spawnWorker, startReview, steerTurn } from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import { compactWorker, type RunOrigin, transition, WORKER_NAME, type WorkerRef } from "./state.js";
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
	start: async (active, params) => toolResult(await commands.start(active, inputOf(params))),
	send: async (active, params) => toolResult(await commands.send(active, nameOf(params), inputOf(params), "master")),
	interrupt: async (active, params) => toolResult(await commands.interrupt(active, nameOf(params))),
	review: async (active, params) => toolResult(await commands.review(active, nameOf(params))),
	tail: async (active, params) => ({ content: [{ type: "text", text: await commands.tail(active, nameOf(params)) }], details: undefined }),
	ack: async (active, params) => toolResult(await commands.ack(active, nameOf(params))),
	kill: async (active, params) => toolResult(await commands.kill(active, nameOf(params))),
};

/** 为新子代理在主会话目录下的 subagents/ 预分配会话文件路径（不会出现在 /resume）；路径是档案身份的唯一事实源。 */
function preallocateWorkerSession(mainSessionPath: string, cwd: string): string {
	const sessionPath = SessionManager.create(cwd, `${dirname(mainSessionPath)}/subagents`).getSessionFile();
	if (!sessionPath) throw new Error(msg.action.noSessionPath);
	return sessionPath;
}

async function kill(active: MasterRuntime, name: string) {
	const target = active.store.require(name);
	// 同步段内删档案与运行时事实，迟到的异步写回据此全部作废；热会话在后台先发 session_shutdown 让扩展收口再释放
	// （处理器没有时限，kill 不等；同一路径不会再被开，收口失败报给用户）。
	active.remove(target.name);
	active.detached(target.name, () => active.setup.pool.dispose(target.sessionPath).then(() => undefined));
	return { killed: true };
}

async function tail(active: MasterRuntime, name: string): Promise<string> {
	const target = active.store.require(name);
	return workerTrace(target, active.setup.pool.getSession(target.sessionPath));
}

/** 动作名按模型先验取：曾叫 hold，被读成“暂停”而假成功。名字治误读，非 idle 报错治假成功。 */
async function ack(active: MasterRuntime, name: string) {
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

/** 写档进 reviewing 就返回；开会话与起审在后台，结局经审查落定事件告知。 */
async function review(active: MasterRuntime, name: string) {
	if (active.setup.reviewGate) throw new Error(active.setup.reviewGate);
	const target = active.store.require(name);
	if (target.status !== "idle") throw new Error(msg.action.reviewBusy(target.name));
	admit(active);
	startReview(active, target);
	return { reviewing: true };
}

/**
 * 暂停中的票当场按被中断落定（{ interrupted: true }）；在跑与审查中的票只记下意图就返回
 * （{ interrupting: true }），中止由 run.ts 的 interruptTurn 在回合真正在飞后做，结局经落定事件告知。
 */
async function interrupt(active: MasterRuntime, name: string) {
	const target = active.store.require(name);
	if (target.status === "idle" && target.resume) return interruptPause(active, target);
	if (target.status === "idle") throw new Error(msg.action.interruptStatus(target.name, target.status));
	interruptTurn(active, target);
	return { interrupting: true };
}

/** 暂停中的子代理：取消自动续跑，按被中断落定（会话与审查义务保留，等指挥官续派或收口）。 */
async function interruptPause(active: MasterRuntime, target: WorkerRef) {
	active.cancelTimers(active.liveOf(target.name));
	const at = Date.now();
	active.settle(target, (current) => ({ worker: transition.interrupted(current, at), outcome: { kind: "interrupted" }, at }));
	return { interrupted: true };
}

/**
 * 在跑的票：补话交给回合，立即返回 { queued: true }。空闲的票：写档进 working 就返回 { sent: true }，开会话（换 cwd 时先释放旧会话）、
 * 等子会话真正空闲、重配路由与开回合都在后台。origin 是调用方（指挥官的工具 / 全过程视图）的身份，不是模型能填的参数。
 */
async function send(active: MasterRuntime, name: string, input: ActionInput, origin: RunOrigin) {
	const { reviewGate, pool } = active.setup;
	const { roles } = active;
	if (input.review && reviewGate) throw new Error(reviewGate);
	const target = active.store.require(name);
	const live = active.liveOf(target.name);
	const { role: requestedRole, thinking: requestedThinking, cwd: requestedCwd } = input;
	const prompt = requiredString(input.prompt, "prompt");
	const selection = requestedRole ? roles.require(requestedRole) : undefined;
	// 子代理全过程视图的补话走同一入口，只多一个来源标记：视图起的运行指挥官不在等（见 RunOrigin），
	// 落定事件注明是用户在视图里直接派的；视图补进别人起的运行只记原话，不改来源。
	const fromView = origin === "view";
	if (target.status === "working" && !requestedRole && !requestedThinking && !requestedCwd) {
		if (live.turn.interrupted) throw new Error(msg.action.interrupting(target.name));
		// 指挥官补进视图起的运行：它从此在等结果（没送达的补话也经事件回报给它）。
		if (!fromView && target.origin === "view") active.store.upsert(transition.awaitedByMaster(target));
		steerTurn(active, target, prompt, () => {
			if (!fromView && !input.review) return;
			active.commit(target, (latest) => {
				const said = fromView ? transition.viewSaid(latest, prompt) : latest;
				return input.review ? { ...said, reviewNeeded: true } : said;
			});
		});
		return { queued: true };
	}
	if (target.status === "working") throw new Error(msg.action.workingSwitch(target.name));
	if (target.status !== "idle") throw new Error(msg.action.reviewingSend(target.name));
	const thinkingOverride = validThinking(requestedThinking);
	admit(active);
	const cwd = resolveSendCwd(target, requestedCwd);
	const selectedRole = selection ?? roles.require(target.role);
	// 只核对角色按最近取到的可用模型可解析：档案的模型原子等路由选定后由 onModelChange 写（run.ts）。
	roles.resolve(selectedRole, thinkingOverride);
	// 被中断或暂停中（回合断在半路）的票，首次续派前置现场核对。
	const cutOff = target.interruptedAt !== undefined || target.resume !== undefined;
	// 接手后的档案（角色、目录、思考档）：开会话与路由都从它取。
	const { thinkingOverride: _previous, ...taken } = transition.takeOver(target, "working", fromView ? prompt : undefined);
	const working = { ...taken, role: selectedRole.role, cwd, ...(thinkingOverride ? { thinkingOverride } : {}), ...(input.review ? { reviewNeeded: true } : {}) };
	active.store.upsert(working);
	active.beginRun(target.name, prompt);
	runWorker(active, working, async () => {
		if (cwd !== target.cwd) await pool.dispose(target.sessionPath);
		const session = await reopen(active, working);
		pool.configureRoute(target.sessionPath, selectedRole.models, working.thinkingOverride);
		return session;
	}, cutOff ? `${RESUME_CHECK_PROMPT}\n\n${prompt}` : prompt);
	return { sent: true };
}

/**
 * 校验后写档进 working 就返回 { started, worker }；新会话在后台开、回合在后台开，开不成（鉴权、路由、扩展加载）按失败落定。
 * 档案里的模型原子先按最近取到的可用模型解析，开会话时路由选定后由 onModelChange 改写。
 */
async function start(active: MasterRuntime, input: ActionInput) {
	const { reviewGate } = active.setup;
	const { ctx } = active;
	if (input.review && reviewGate) throw new Error(reviewGate);
	const name = input.worker;
	if (!name) throw new Error(msg.action.needWorker);
	validateWorkerName(name);
	if (active.store.find(name)) throw new Error(msg.action.exists(name));
	admit(active);
	const prompt = requiredString(input.prompt, "prompt");
	const requestedRole = input.role;
	if (!requestedRole) throw new Error(msg.action.needRole);
	const selectedRole = active.roles.require(requestedRole);
	const override = validThinking(input.thinking);
	const selected = active.roles.resolve(selectedRole, override);
	const cwd = resolveWorkerCwd(input.cwd ?? ctx.cwd);
	const mainSessionPath = ctx.sessionManager.getSessionFile();
	if (!mainSessionPath) throw new Error(msg.action.mainNotSaved);
	const worker: WorkerRef = {
		name,
		role: selectedRole.role,
		model: selected.model,
		thinking: selected.thinking,
		status: "working",
		sessionPath: preallocateWorkerSession(mainSessionPath, cwd),
		cwd,
		launch: active.nextLaunch(),
		...(override ? { thinkingOverride: override } : {}),
		...(input.review ? { reviewNeeded: true } : {}),
	};
	active.store.upsert(worker);
	active.beginRun(name, prompt);
	runWorker(active, worker, () => spawnWorker(active, worker, false), prompt);
	return { started: true, worker: compactWorker(worker) };
}

/** 在飞上限：数 working/reviewing 的票。暂停后的自动续跑是已放行的那次运行接着跑，不经这里，可能短暂越过上限。 */
function admit(active: MasterRuntime): void {
	const busy = active.store.workers.flatMap((worker) => (worker.status !== "idle" ? [worker.name] : []));
	if (busy.length >= MAX_IN_FLIGHT) throw new Error(msg.action.limit(MAX_IN_FLIGHT, busy));
}

function toolResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function nameOf(params: Params): string {
	return requiredString(params.worker, "worker");
}

export function inputOf(params: Params): ActionInput {
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

function resolveWorkerCwd(path: string): string {
	if (!isAbsolute(path)) throw new Error(msg.action.cwdAbsolute);
	try {
		return realpathSync(path);
	} catch {
		throw new Error(msg.action.cwdMissing(path));
	}
}

function resolveSendCwd(worker: WorkerRef, requested: string | undefined): string {
	if (requested) return resolveWorkerCwd(requested);
	if (worker.cwd && !existsSync(worker.cwd))
		throw new Error(msg.action.cwdGone(worker.name, worker.cwd));
	return worker.cwd;
}

/**
 * 七个命令的唯一入口：已关闭的运行时（指挥官已关、会话已替换或 reload）一律拒绝。全过程视图可能在关闭后还握着旧运行时，
 * 它的运行时事实已清空，放进去只会撞上半拆的状态。
 */
export const commands = guarded({ start, send, interrupt, review, tail, ack, kill });

function guarded<T extends Record<string, (active: MasterRuntime, ...args: never[]) => Promise<unknown>>>(table: T): T {
	return Object.fromEntries(Object.entries(table).map(([name, run]) => [name, async (active: MasterRuntime, ...args: never[]) => {
		active.assertOpen();
		return run(active, ...args);
	}])) as T;
}
