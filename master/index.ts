import { existsSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	isToolCallEventType,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ModelAtom, type MasterRole } from "../config.js";
import {
	HERDR_WORKING_CHANNEL, HERDR_WORKING_LABEL, WORKERS_CHANNEL, type HerdrWorkingPayload, type WorkersPayload,
} from "../busy.js";
import { deliver, wrapEnvelope } from "../deliver.js";
import { clip, formatDuration, textOf } from "../format.js";
import { HEAT_COLORS, paint } from "../flame.js";
import { outcomeOfEntry, readReviewOutcome, reviewProgressOf, type ReviewOutcome, type ReviewProgress } from "../review/outcome.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { ActivityList, visibleRows, type SettledFact } from "./activity-list.js";
import { MASTER_EVENT_TYPE, masterEvent, withElapsed, type MasterEvent } from "./event-format.js";
import { assembleMasterPrompt, assembleWorkerPrompt, readMasterPrompt } from "./prompt.js";
import { InProcessSessionPool, preallocateWorkerSession } from "./spawn.js";
import {
	MasterStore,
	THINKING_LEVELS,
	recoverMasterState,
	loadMasterState,
	masterStatePath,
	requireWorker,
	type MasterState,
	type WorkerRef,
	type WorkerStatus,
} from "./state.js";

const MASTER_TOOL = "subagents";
const MASTER_LIST_TOOL = "subagents_list";
const MASTER_TOOLS = [MASTER_TOOL, MASTER_LIST_TOOL];
const WORKER_TOOLS = ["read", "bash", "edit", "write"];
const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";
const EVENT_RETRY_MS = 5_000;
const FAULT_SUMMARY_WIDTH = 80;
/** 算作“有输出”的子会话事件：模型 token 流与工具执行；活动列表据此判卡住。 */
const OUTPUT_EVENTS = new Set<AgentSessionEvent["type"]>(["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface PendingMasterEvent {
	id: string;
	content: string;
	worker?: string;
}

interface MasterDependencies {
	pool?: InProcessSessionPool;
	interruptResumeMs?: number;
}

interface CurrentTool {
	tool: string;
	args: unknown;
	startedAt: number;
}

interface WorkerTerminal {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface ObservedSession {
	session: AgentSession;
	unsubscribe: () => void;
}

interface MasterRuntime {
	ctx: ExtensionContext;
	store: MasterStore;
	pool: InProcessSessionPool;
	events: PendingMasterEvent[];
	/** 已交给 deliver、尚未确认送达的事件：投递完成前对应子代理仍算在飞。 */
	delivering: Set<PendingMasterEvent>;
	currentTools: Map<string, Map<string, CurrentTool>>;
	idleSince: Map<string, number>;
	/** Worker 本次回合（start/send/review 投递）的起点，耗时信号的唯一来源。 */
	runStartedAt: Map<string, number>;
	/** 最近一条真实用户输入的时刻；Master 事件（source extension）不算。 */
	taskStartedAt?: number;
	reviewProgress: Map<string, ReviewProgress>;
	/** Worker 最近一次输出（工具事件或模型 token）的时刻，活动列表据此判卡住。 */
	lastOutputAt: Map<string, number>;
	/** 本次运行的落定事实（时刻、成败与说明）：失败行留到 ack 或 kill，完成留到 kill。 */
	settled: Map<string, SettledFact>;
	/** 名字 → start 到达序号，活动列表的唯一排序依据。 */
	launchOrder: Map<string, number>;
	launchSeq: number;
	list?: ActivityList;
	observedSessions: Map<string, ObservedSession>;
	flushTimer?: NodeJS.Timeout;
}

export function registerMaster(
	pi: ExtensionAPI,
	dependencies: MasterDependencies = {},
	worker = false,
): void {
	if (worker) {
		pi.on("tool_call", async (event, ctx) => {
			if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
			const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
			if (reason) return { block: true, reason };
		});
		return;
	}
	let runtime: MasterRuntime | undefined;
	const loaded = loadConfig().master;
	const prompts = loadMasterPrompts();
	const startupError = "error" in loaded ? loaded.error : "error" in prompts ? prompts.error : undefined;
	const roster = "error" in loaded ? [] : loaded.config.roles;
	const exclusions = "error" in loaded ? [] : loaded.config.workerExcludeExtensions;
	const autoActivate = "error" in loaded ? false : loaded.config.autoActivate;
	const requirePrompts = () => {
		if ("error" in prompts) throw new Error(prompts.error);
		return prompts;
	};
	const reviewGate = reviewGateError();
	const pool = dependencies.pool ?? new InProcessSessionPool();
	const activeRuns = new Map<string, symbol>();
	const interruptedRuns = new Map<string, symbol>();
	const startingNames = new Set<string>();
	const transitioningNames = new Set<string>();
	const interruptTimers = new Map<string, NodeJS.Timeout>();
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => !MASTER_TOOLS.includes(name));
		pi.setActiveTools(active ? [...tools, ...MASTER_TOOLS] : tools);
	};
	const ownsRuntime = (active: MasterRuntime): boolean => runtime === active;
	const requireRuntimeOwner = (active: MasterRuntime): void => {
		if (!ownsRuntime(active)) throw new Error("Master 会话已替换，取消旧会话动作");
	};
	// 在飞子代理数的唯一发布者；herdr:working 只在 0↔正数跃迁时发布，active 按计数配对。
	let publishedInFlight = 0;
	const publishInFlight = (count: number, teardown = false) => {
		if (count === publishedInFlight) return;
		const wasBusy = publishedInFlight > 0;
		publishedInFlight = count;
		pi.events.emit(WORKERS_CHANNEL, { inFlight: count, ...(teardown ? { teardown: true as const } : {}) } satisfies WorkersPayload);
		if (wasBusy !== count > 0)
			pi.events.emit(HERDR_WORKING_CHANNEL, { active: count > 0, label: HERDR_WORKING_LABEL } satisfies HerdrWorkingPayload);
	};
	/**
	 * 在飞 = working/reviewing + 已落定但结果事件还在队列或投递中（投递失败重试期间也算）：
	 * 归零只发生在事件已交给指挥官之后，忙时 steer 由指挥官回合覆盖，闲时前门唤醒由 agent 回合覆盖。
	 */
	let syncScheduled = false;
	const syncInFlight = () => {
		// 落定先改 store、随后才入队事件：同一同步段内合并成一次计算，避免中间闪出一次归零。
		if (syncScheduled) return;
		syncScheduled = true;
		queueMicrotask(() => {
			syncScheduled = false;
			if (!runtime) return;
			const names = new Set<string>();
			for (const worker of runtime.store.state.workers)
				if (worker.status === "working" || worker.status === "reviewing") names.add(worker.name);
			for (const event of [...runtime.events, ...runtime.delivering]) if (event.worker) names.add(event.worker);
			publishInFlight(names.size);
		});
	};
	const renderStatus = () => {
		if (!runtime) return;
		syncInFlight();
		runtime.ctx.ui.setStatus("master", MASTER_IDENTITY);
		runtime.list?.sync();
	};
	const activate = (ctx: ExtensionContext, restored?: MasterState): MasterRuntime => {
		if (startupError) throw new Error(startupError);
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		let active!: MasterRuntime;
		const store = new MasterStore(masterStatePath(ctx.sessionManager.getSessionId()), restored, () => {
			if (ownsRuntime(active)) renderStatus();
		});
		active = {
			ctx,
			store,
			pool,
			events: [],
			delivering: new Set(),
			currentTools: new Map(),
			idleSince: new Map(),
			runStartedAt: new Map(),
			reviewProgress: new Map(),
			lastOutputAt: new Map(),
			settled: new Map(),
			launchOrder: new Map(),
			launchSeq: 0,
			observedSessions: new Map(),
		};
		runtime = active;
		ctx.ui.setWidget(
			LIST_WIDGET_KEY,
			(tui, theme) => {
				active.list = new ActivityList(tui, theme, () => ({
					workers: active.store.state.workers,
					currentTools: active.currentTools,
					reviewProgress: active.reviewProgress,
					runStartedAt: active.runStartedAt,
					lastOutputAt: active.lastOutputAt,
					settled: active.settled,
					launchOrder: active.launchOrder,
				}), () => visibleRows(tui.terminal?.rows, ctx.ui.getToolsExpanded()));
				return active.list;
			},
			{ placement: "aboveEditor" },
		);
		setTools(true);
		if (store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(`旧版 v${store.discardedLegacyVersion} 子代理池已丢弃并从空池重建；旧运行时进程不会纳入新池，请手动清理`, "warning");
		// store 创建时 runtime 尚未就位，激活完成后只补这一次首绘。
		renderStatus();
		return active;
	};
	const deactivate = async () => {
		const active = runtime;
		runtime = undefined;
		// 遗弃在飞子代理不是歇下：带 teardown 归零，busy.ts 只结束本段。
		publishInFlight(0, true);
		await pool.disposeAll();
		for (const timer of interruptTimers.values()) clearTimeout(timer);
		interruptTimers.clear();
		activeRuns.clear();
		interruptedRuns.clear();
		startingNames.clear();
		transitioningNames.clear();
		if (active?.flushTimer) clearTimeout(active.flushTimer);
		for (const observed of active?.observedSessions.values() ?? []) observed.unsubscribe();
		active?.list?.dispose();
		active?.ctx.ui.setWidget(LIST_WIDGET_KEY, undefined);
		active?.ctx.ui.setStatus("master", undefined);
		setTools(false);
	};
	const flushEvents = (active: MasterRuntime) => {
		if (!ownsRuntime(active)) return;
		active.flushTimer = undefined;
		if (!active.events.length) return;
		const batch = active.events.splice(0);
		for (const event of batch) active.delivering.add(event);
		deliver(pi, active.ctx, {
			customType: MASTER_EVENT_TYPE,
			content: batch.map((event) => masterEventEnvelope(event.content)).join("\n\n"),
		}).then(() => {
			if (!ownsRuntime(active)) return;
			for (const event of batch) active.delivering.delete(event);
			try {
				pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
			} catch (error) {
				active.ctx.ui.notify(`子代理结果确认写入失败，reload 后可能重复投递：${String(error)}`, "warning");
			}
			for (const event of batch) {
				if (!event.worker) continue;
				const worker = active.store.state.workers.find((candidate) => candidate.name === event.worker);
				if (worker?.status === "idle" && worker.disposition !== "reminded")
					active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker, disposition: "pending" } });
			}
			syncInFlight();
		}, (error) => {
			if (!ownsRuntime(active)) return;
			for (const event of batch) active.delivering.delete(event);
			active.events.unshift(...batch);
			active.ctx.ui.notify(`子代理结果投递失败，将自动重试：${String(error)}`, "warning");
			active.flushTimer = setTimeout(() => flushEvents(active), EVENT_RETRY_MS);
			active.flushTimer.unref?.();
		});
	};
	const enqueueEvent = (
		active: MasterRuntime,
		produced: MasterEvent | { replay: PendingMasterEvent },
		worker?: string,
	) => {
		if (!ownsRuntime(active)) return;
		// 重放的 pending 事件正文已带落定当时的耗时，原样再投。
		const replay = "replay" in produced;
		const sessionPath = active.store.state.workers.find((candidate) => candidate.name === worker)?.sessionPath;
		const event: PendingMasterEvent = replay
			? produced.replay
			: { id: crypto.randomUUID(), content: withElapsedOf(active, produced, sessionPath), ...(worker ? { worker } : {}) };
		if (!replay) {
			try {
				pi.appendEntry(PENDING_EVENT_TYPE, event);
			} catch (error) {
				active.ctx.ui.notify(`子代理结果持久化失败，crash 时可能丢失：${String(error)}`, "warning");
			}
		}
		active.events.push(event);
		syncInFlight();
		if (!active.flushTimer) {
			active.flushTimer = setTimeout(() => flushEvents(active), 0);
			active.flushTimer.unref?.();
		}
	};
	const clearInterruptTimer = (name: string) => {
		const timer = interruptTimers.get(name);
		if (timer) clearTimeout(timer);
		interruptTimers.delete(name);
	};
	const armInterruptReminder = (active: MasterRuntime, worker: WorkerRef) => {
		if (!ownsRuntime(active)) return;
		clearInterruptTimer(worker.name);
		const duration = dependencies.interruptResumeMs ?? 5 * 60_000;
		const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + duration - Date.now());
		const timer = setTimeout(() => {
			if (!ownsRuntime(active)) return;
			interruptTimers.delete(worker.name);
			const current = active.store.state.workers.find((candidate) => candidate.name === worker.name);
			if (!current?.interruptedAt || current.interruptedAt !== worker.interruptedAt) return;
			active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, disposition: "reminded" } });
			enqueueEvent(active, masterEvent.resumeReminder(worker.name), worker.name);
		}, delay);
		timer.unref?.();
		interruptTimers.set(worker.name, timer);
	};
	const activateSession = (ctx: ExtensionContext): MasterRuntime => {
		if (runtime) return activate(ctx);
		let restored: MasterState | undefined;
		try {
			restored = loadMasterState(masterStatePath(ctx.sessionManager.getSessionId()));
		} catch {
			return activate(ctx);
		}
		const active = activate(ctx, restored);
		if (restored) {
			const recovered = recoverMasterState(restored);
			for (const worker of recovered.workers) {
				if (worker !== restored.workers.find((candidate) => candidate.name === worker.name))
					active.store.dispatch({ type: "UPSERT_WORKER", worker });
				if (worker.interruptedAt) armInterruptReminder(active, worker);
			}
		}
		for (const event of unackedEvents(ctx))
			enqueueEvent(active, { replay: event }, event.worker);
		return active;
	};
	/** await 之后的唯一重读点：档案已被 kill（或同名换票）就释放热会话并放弃本次动作。 */
	const currentWorker = (active: MasterRuntime, identity: WorkerRef) => {
		requireRuntimeOwner(active);
		const current = active.store.state.workers.find((worker) => worker.name === identity.name);
		if (current?.sessionPath === identity.sessionPath) return current;
		void active.pool.dispose(identity.sessionPath);
		throw new Error(`${identity.name} 已被 kill，取消本次动作`);
	};
	/** await 之后的写回只经这里：基于重读的最新档案做函数式更新，不拿 await 前的快照覆盖。 */
	const commit = (active: MasterRuntime, identity: WorkerRef, update: (current: WorkerRef) => WorkerRef): WorkerRef => {
		const next = update(currentWorker(active, identity));
		active.store.dispatch({ type: "UPSERT_WORKER", worker: next });
		return next;
	};
	const openWorkerSession = async (active: MasterRuntime, worker: WorkerRef) => {
		requireRuntimeOwner(active);
		const hot = active.pool.getSession(worker.sessionPath);
		if (hot) return hot;
		const model = await active.pool.resolveModel(worker.model);
		requireRuntimeOwner(active);
		const spawned = await active.pool.spawn({
			cwd: worker.cwd ?? process.cwd(),
			role: "worker",
			model,
			thinking: worker.thinking,
			tools: WORKER_TOOLS,
			excludeExtensions: exclusions,
			systemPrompt: { mode: "append", text: assembleWorkerPrompt(requirePrompts().worker, worker.name) },
			contextFiles: true,
			persistence: { type: "file", sessionPath: worker.sessionPath, resume: true },
		});
		if (!ownsRuntime(active)) {
			spawned.dispose();
			requireRuntimeOwner(active);
		}
		return spawned.session;
	};
	const observeWorker = (active: MasterRuntime, sessionPath: string, session: AgentSession) => {
		requireRuntimeOwner(active);
		const previous = active.observedSessions.get(sessionPath);
		if (previous?.session === session) return;
		previous?.unsubscribe();
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (!ownsRuntime(active)) return;
			if (OUTPUT_EVENTS.has(event.type)) active.lastOutputAt.set(sessionPath, Date.now());
			if (event.type === "tool_execution_start") {
				const tools = active.currentTools.get(sessionPath) ?? new Map<string, CurrentTool>();
				tools.set(event.toolCallId, { tool: event.toolName, args: event.args, startedAt: Date.now() });
				active.currentTools.set(sessionPath, tools);
			}
			if (event.type === "tool_execution_end") {
				const tools = active.currentTools.get(sessionPath);
				tools?.delete(event.toolCallId);
				if (!tools?.size) active.currentTools.delete(sessionPath);
			}
			if (event.type === "entry_appended") {
				const progress = reviewProgressOf(event.entry);
				if (progress) active.reviewProgress.set(sessionPath, progress);
			}
		});
		active.observedSessions.set(sessionPath, { session, unsubscribe });
	};
	/** resolve 即回合已在飞：宿主 prompt 的前置阶段仍报空闲，期间 abort 会被丢弃，interrupt 必须晚于 preflight。 */
	const runWorker = async (active: MasterRuntime, worker: WorkerRef, session: Awaited<ReturnType<typeof openWorkerSession>>, prompt: string) => {
		// 启动回合的路径都经这里：准备期间被 kill 的不调模型、不留热会话。
		currentWorker(active, worker);
		observeWorker(active, worker.sessionPath, session);
		const run = Symbol(worker.name);
		let terminal: WorkerTerminal | undefined;
		activeRuns.set(worker.sessionPath, run);
		const unsubscribeTerminal = session.subscribe((event) => {
			if (!ownsRuntime(active) || activeRuns.get(worker.sessionPath) !== run || event.type !== "agent_end") return;
			terminal = captureWorkerTerminal(event.messages);
		});
		const settled = async (error?: unknown) => {
			unsubscribeTerminal();
			if (!ownsRuntime(active) || activeRuns.get(worker.sessionPath) !== run) return;
			const stranded = session.clearQueue().steering;
			if (stranded.length)
				enqueueEvent(active, masterEvent.stranded(worker.name, stranded), worker.name);
			activeRuns.delete(worker.sessionPath);
			if (interruptedRuns.get(worker.sessionPath) === run) {
				interruptedRuns.delete(worker.sessionPath);
				const current = active.store.state.workers.find((candidate) => candidate.name === worker.name);
				if (!current || current.sessionPath !== worker.sessionPath) return;
				const interrupted: WorkerRef = { ...current, status: "idle", interruptedAt: Date.now() };
				active.settled.set(worker.sessionPath, { at: interrupted.interruptedAt!, kind: "interrupted" });
				active.store.dispatch({ type: "UPSERT_WORKER", worker: interrupted });
				active.currentTools.delete(worker.sessionPath);
				markWorkerIdle(active, worker.sessionPath);
				enqueueEvent(active, masterEvent.interrupted(worker.name), worker.name);
				armInterruptReminder(active, interrupted);
				return;
			}
			if (terminal?.stopReason === "error" && error === undefined) {
				await resumeWithFallback(active, worker, session, terminal, faultSummary(terminal));
				return;
			}
			const content = settleWorker(active, worker, terminal, error);
			if (content) enqueueEvent(active, content, worker.name);
		};
		const inflight = Promise.withResolvers<void>();
		void session.prompt(prompt, { preflightResult: () => inflight.resolve() })
			.then(() => settled(), settled)
			.finally(() => inflight.resolve());
		await inflight.promise;
	};
	const resumeWithFallback = async (
		active: MasterRuntime,
		identity: WorkerRef,
		session: Awaited<ReturnType<typeof openWorkerSession>>,
		terminal: WorkerTerminal,
		reason: string,
	) => {
		const current = currentWorker(active, identity);
		const configuredRole = roster.find((entry) => entry.role === current.role);
		if (!configuredRole) {
			const failure = `${terminalFailure(terminal)}\n角色 ${current.role} 已不在角色表，无法 fallback`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
			return;
		}
		const fallback = nextFallback(configuredRole, current);
		if (!fallback) {
			const failure = `${terminalFailure(terminal)}\n角色 ${current.role} 的 fallback 链已用尽`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
			return;
		}
		try {
			const model = await active.pool.resolveModel(fallback.model);
			requireRuntimeOwner(active);
			await session.setModel(model);
			requireRuntimeOwner(active);
			session.setThinkingLevel(fallback.thinking);
			const switched = commit(active, current, (latest) => ({ ...latest, ...fallback, status: "working" }));
			const from = modelAtomText(current);
			const to = modelAtomText(fallback);
			enqueueEvent(active, masterEvent.modelSwitched(current.name, from, to, reason), current.name);
			await runWorker(active, switched, session, fallbackResumePrompt(from, to, reason));
		} catch (error) {
			const failure = `${terminalFailure(terminal)}\nfallback 切换失败：${error instanceof Error ? error.message : String(error)}`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
		}
	};

	pi.registerCommand("fire-master", {
		description: "翻转当前会话的指挥官模式；status 查看状态",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				ctx.ui.notify(runtime ? statusText(runtime.store.state.workers) : "指挥官模式未启动", "info");
				return;
			}
			if (input) {
				ctx.ui.notify("/fire-master 只接受 status；裸命令翻转开关", "error");
				return;
			}
			if (runtime) {
				await deactivate();
				ctx.ui.notify("指挥官模式已关闭", "info");
				return;
			}
			try {
				activateSession(ctx);
				ctx.ui.notify("指挥官模式已启动", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("input", (event) => {
		if (runtime && event.source !== "extension") runtime.taskStartedAt = Date.now();
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime || !pi.getActiveTools().includes(MASTER_TOOL)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${assembleMasterPrompt(requirePrompts().master, rosterText(roster))}`,
		};
	});

	pi.registerTool({
		name: MASTER_LIST_TOOL,
		label: "子代理",
		description: "查看子代理池快照",
		renderShell: "self",
		renderCall: (_args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts({ action: "list" }), clip: "end", theme, ctx }),
		renderResult: (result, options, theme, context) => {
			const details = result.details as { workers?: unknown } | undefined;
			context.state.meta = !context.isError && Array.isArray(details?.workers) ? listMeta(details.workers) : undefined;
			if (options.expanded && Array.isArray(details?.workers))
				return expandedWorkerList(details.workers, theme, context);
			return renderSubagentsResult(result, options, theme, context);
		},
		parameters: Type.Object({}),
		async execute() {
			const active = runtime;
			if (!active) throw new Error("subagents_list 只在 Master 中可用");
			const workers = active.store.state.workers.map(compactWorker);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ workers }) }],
				details: {
					workers: workers.map((worker) => ({
						...worker,
						currentAction: currentWorkerAction(active, worker),
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: MASTER_TOOL,
		label: "子代理",
		description: "指挥官的七动作子代理接口：start 按角色新建，send 续派或切换角色，interrupt 中断，review 显式审查，tail 读轨迹，ack 确认落定，kill 收口移除；无 sleep/session。",
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts(args as Record<string, unknown>), clip: "end", theme, ctx }),
		renderResult: renderSubagentsResult,
		parameters: Type.Object({
			action: StringEnum(["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const, {
				description: "七动作之一；等待状态变化，不要用 sleep 轮询。",
			}),
			worker: Type.String({ description: "start 起简短任务名；其余动作填目标 Worker。" }),
			prompt: Type.Optional(Type.String({ description: "start/send 必填自包含任务说明，包括交付物、限制与验证要求。" })),
			role: Type.Optional(StringEnum(roster.map((entry) => entry.role), { description: "start 必填角色表中的角色；send 可选，传入时切换角色，省略则沿用。" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "可选思考档覆盖；省略时使用角色原子档或当前档。" })),
			cwd: Type.Optional(Type.String({ description: "Worker 工作目录的绝对路径；start 默认当前目录，send 给空闲 Worker 换检出时带上（同一会话重开）。" })),
			review: Type.Optional(Type.Boolean({ description: "按审查纪律为 start/send 记录义务；true 不自动开审。" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (!active) throw new Error("subagents 只在 Master 中可用");
			if (params.action === "kill") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				clearInterruptTimer(target.name);
				activeRuns.delete(target.sessionPath);
				interruptedRuns.delete(target.sessionPath);
				active.currentTools.delete(target.sessionPath);
				active.idleSince.delete(target.sessionPath);
				active.runStartedAt.delete(target.sessionPath);
				active.reviewProgress.delete(target.sessionPath);
				active.lastOutputAt.delete(target.sessionPath);
				active.settled.delete(target.sessionPath);
				active.launchOrder.delete(target.name);
				active.observedSessions.get(target.sessionPath)?.unsubscribe();
				active.observedSessions.delete(target.sessionPath);
				active.store.dispatch({ type: "REMOVE_WORKER", name: target.name });
				await active.pool.dispose(target.sessionPath);
				return toolResult({ killed: true });
			}
			if (params.action === "tail") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				return { content: [{ type: "text" as const, text: await readWorkerTrace(target) }], details: undefined };
			}
			if (params.action === "ack") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.reviewNeeded) throw new Error(`${target.name} 此票有审查义务，完成 review 后才能 ack`);
				if (target.status !== "idle") throw new Error(`${target.name} 正在 ${target.status}，不能 ack`);
				if (target.disposition) {
					const { disposition: _disposition, ...rest } = target;
					active.store.dispatch({ type: "UPSERT_WORKER", worker: rest });
				}
				// ack 发落失败与被中断的行；完成的留在“✓ N 个已完成”里直到 kill。
				if (active.settled.get(target.sessionPath)?.kind !== "done") active.settled.delete(target.sessionPath);
				renderStatus();
				return toolResult({ acked: true });
			}
			if (params.action === "review") {
				if (reviewGate) throw new Error(reviewGate);
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "idle" || transitioningNames.has(target.name))
					throw new Error(`${target.name} 正在处理其他动作，不能 review`);
				transitioningNames.add(target.name);
				try {
					const session = await openWorkerSession(active, target);
					await session.waitForIdle();
					requireRuntimeOwner(active);
					observeWorker(active, target.sessionPath, session);
					const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
					commit(active, target, ({ disposition: _disposition, interruptedAt: _interruptedAt, ...rest }) => ({ ...rest, status: "reviewing" }));
					clearInterruptTimer(target.name);
					active.idleSince.delete(target.sessionPath);
					active.runStartedAt.set(target.sessionPath, Date.now());
					void monitorReview(session, target.sessionPath, previousRunId).then(
						(outcome) => {
							if (!ownsRuntime(active)) return;
							const current = active.store.state.workers.find((worker) => worker.name === target.name);
							if (!current || current.sessionPath !== target.sessionPath || current.status !== "reviewing") return;
							const { reviewNeeded: _needed, ...fulfilled } = current;
							const worker = outcome.status === "passed" || outcome.status === "stopped"
								? fulfilled
								: current;
							active.settled.set(target.sessionPath, reviewSettledFact(outcome));
							active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker, status: "idle" } });
							active.reviewProgress.delete(target.sessionPath);
							markWorkerIdle(active, target.sessionPath);
							enqueueEvent(active, masterEvent.review(target.name, outcome, latestAssistantText(session.messages)), target.name);
						},
						(error) => {
							if (!ownsRuntime(active)) return;
							const current = active.store.state.workers.find((worker) => worker.name === target.name);
							if (!current || current.status !== "reviewing") return;
							active.settled.set(target.sessionPath, { at: Date.now(), kind: "failed", note: "审查未完成" });
							active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
							active.reviewProgress.delete(target.sessionPath);
							markWorkerIdle(active, target.sessionPath);
							enqueueEvent(active, masterEvent.reviewIncomplete(target.name, String(error)), target.name);
						},
					);
					return toolResult({ reviewing: true });
				} finally {
					if (ownsRuntime(active)) transitioningNames.delete(target.name);
				}
			}
			if (params.action === "interrupt") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "working") throw new Error(`${target.name} 当前是 ${target.status}，不能 interrupt`);
				const session = active.pool.getSession(target.sessionPath);
				if (!session) throw new Error(`${target.name} 的进程内会话已释放，无法 interrupt`);
				const run = activeRuns.get(target.sessionPath);
				if (!run) throw new Error(`${target.name} 当前没有可中断的回合`);
				interruptedRuns.set(target.sessionPath, run);
				try {
					await session.abort();
					requireRuntimeOwner(active);
					return toolResult({ interrupted: true });
				} catch (error) {
					if (ownsRuntime(active) && interruptedRuns.get(target.sessionPath) === run) interruptedRuns.delete(target.sessionPath);
					throw error;
				}
			}
			if (params.action === "send") {
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (transitioningNames.has(target.name)) throw new Error(`${target.name} 正在切换，稍后再 send`);
				const requestedRole = optionalString(params.role);
				const requestedThinking = optionalString(params.thinking);
				const requestedCwd = optionalString(params.cwd);
				const prompt = requiredString(params.prompt, "prompt");
				validateDelegationText(prompt);
				if (target.status === "working" && !requestedRole && !requestedThinking && !requestedCwd) {
					const session = active.pool.getSession(target.sessionPath);
					if (!session?.isStreaming) throw new Error(`${target.name} 回合正在收尾，稍后再 send`);
					await session.steer(prompt);
					// steer 会 await 子会话的 input 处理器：期间可能落定或被 kill，写回只认重读后的档案。
					const current = currentWorker(active, target);
					if (current.status !== "working") {
						session.clearQueue();
						throw new Error(`${target.name} 的回合已结束，补充说明未送达，请重新 send`);
					}
					if (params.review === true) commit(active, target, (latest) => ({ ...latest, reviewNeeded: true }));
					return toolResult({ steered: true });
				}
				if (target.status === "working")
					throw new Error(`${target.name} 正在工作；切换 role/thinking/cwd 需先 interrupt`);
				if (target.status !== "idle") throw new Error(`${target.name} 正在审查，等落定再 send`);
				const selection = requestedRole ? resolveRole(roster, requestedRole) : undefined;
				if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking as WorkerRef["thinking"]))
					throw new Error(`thinking 值无效：${requestedThinking}`);
				transitioningNames.add(target.name);
				try {
					const cwd = await resolveSendCwd(target, requestedCwd);
					if (cwd !== target.cwd) await active.pool.dispose(target.sessionPath);
					const nextModel = selection
						? await active.pool.resolveModel(selection.model)
						: undefined;
					requireRuntimeOwner(active);
					const session = await openWorkerSession(active, { ...target, cwd });
					await session.waitForIdle();
					requireRuntimeOwner(active);
					let role = target.role;
					let model = target.model;
					let thinking = target.thinking;
					if (selection && nextModel) {
						await session.setModel(nextModel);
						requireRuntimeOwner(active);
						role = selection.role;
						model = selection.model;
						thinking = selection.thinking;
					}
					if (selection || requestedThinking) {
						thinking = requestedThinking as WorkerRef["thinking"] | undefined ?? thinking;
						session.setThinkingLevel(thinking);
					}
					const interruptedAt = currentWorker(active, target).interruptedAt;
					const activeWorker = commit(active, target, ({ disposition: _disposition, interruptedAt: _interrupted, ...rest }) => ({
						...rest,
						role,
						model,
						thinking,
						cwd,
						status: "working",
						...(params.review === true || rest.reviewNeeded ? { reviewNeeded: true } : {}),
					}));
					clearInterruptTimer(target.name);
					active.idleSince.delete(target.sessionPath);
					active.runStartedAt.set(target.sessionPath, Date.now());
					const text = interruptedAt ? `${resumeCheckPrompt()}\n\n${prompt}` : prompt;
					await runWorker(active, activeWorker, session, text);
					return toolResult({ sent: true });
				} finally {
					if (ownsRuntime(active)) transitioningNames.delete(target.name);
				}
			}
			if (params.action !== "start") throw new Error(`未知 subagents action：${String(params.action)}`);
			if (params.review === true && reviewGate) throw new Error(reviewGate);
			if (typeof params.worker !== "string" || !params.worker.trim())
				throw new Error("start 需要 worker：给子代理起个简短任务名（如 fix-auth、repo-scan）");
			const name = params.worker.trim();
			validateWorkerName(name);
			if (active.store.state.workers.some((worker) => worker.name === name) || startingNames.has(name))
				throw new Error(`子代理已存在：${name}`);
			const inFlight = active.store.state.workers.filter((worker) => worker.status === "working" || worker.status === "reviewing");
			if (inFlight.length + startingNames.size >= 15)
				throw new Error(`Worker 并发上限 15，当前在飞：${[...inFlight.map((worker) => worker.name), ...startingNames].join("、")}`);
			const prompt = requiredString(params.prompt, "prompt");
			validateDelegationText(prompt);
			const selectedRole = resolveRole(roster, requiredString(params.role, "start 必须指定 role"));
			const requestedThinking = optionalString(params.thinking);
			if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking as WorkerRef["thinking"]))
				throw new Error(`thinking 值无效：${requestedThinking}`);
			const selection = {
				...selectedRole,
				thinking: requestedThinking as WorkerRef["thinking"] | undefined ?? selectedRole.thinking,
			};
			startingNames.add(name);
			// 同步登记：并发 start 越过后续 await 的先后不定，序号必须在此取。
			active.launchOrder.set(name, ++active.launchSeq);
			try {
				const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
				requireRuntimeOwner(active);
				const mainSessionPath = ctx.sessionManager.getSessionFile?.();
				if (!mainSessionPath) throw new Error("主会话尚未落盘，无法创建子代理会话目录");
				const sessionPath = preallocateWorkerSession(mainSessionPath, cwd);
				const worker: WorkerRef = {
					name,
					role: selection.role,
					model: selection.model,
					thinking: selection.thinking,
					status: "working",
					sessionPath,
					cwd,
					...(params.review === true ? { reviewNeeded: true } : {}),
				};
				active.store.dispatch({ type: "UPSERT_WORKER", worker });
				active.runStartedAt.set(sessionPath, Date.now());
				startingNames.delete(name);
				try {
					const model = await active.pool.resolveModel(selection.model);
					requireRuntimeOwner(active);
					const spawned = await active.pool.spawn({
						cwd,
						role: "worker",
						model,
						thinking: selection.thinking,
						tools: WORKER_TOOLS,
						excludeExtensions: exclusions,
						systemPrompt: { mode: "append", text: assembleWorkerPrompt(requirePrompts().worker, name) },
						contextFiles: true,
						persistence: { type: "file", sessionPath },
					});
					if (!ownsRuntime(active)) {
						await spawned.dispose();
						requireRuntimeOwner(active);
					}
					await runWorker(active, worker, spawned.session, prompt);
					return toolResult({ started: true, worker: compactWorker(worker) });
				} catch (error) {
					// 只撤自己这一票：kill 后同名重开的新票不受影响。
					if (ownsRuntime(active) && active.store.state.workers.some((candidate) => candidate.sessionPath === sessionPath)) {
						active.store.dispatch({ type: "REMOVE_WORKER", name });
						active.launchOrder.delete(name);
						active.runStartedAt.delete(sessionPath);
					}
					throw error;
				}
			} finally {
				if (ownsRuntime(active)) startingNames.delete(name);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await deactivate();
		if (!autoActivate) return;
		try {
			activateSession(ctx);
		} catch (error) {
			ctx.ui.notify(`指挥官模式恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", () => deactivate());
}

/** Worker 闲下来的唯一登记点：Master 记录时刻，池据此起释放计时。 */
function markWorkerIdle(active: MasterRuntime, sessionPath: string): void {
	active.idleSince.set(sessionPath, Date.now());
	active.pool.markIdle(sessionPath);
}

function settleWorker(
	active: MasterRuntime,
	identity: WorkerRef,
	terminal: WorkerTerminal | undefined,
	error?: unknown,
): MasterEvent | undefined {
	const current = active.store.state.workers.find((worker) => worker.name === identity.name);
	if (!current || current.sessionPath !== identity.sessionPath) return undefined;
	const failure = error instanceof Error ? error.message : error === undefined ? terminalFailure(terminal) : String(error);
	active.settled.set(identity.sessionPath, { at: Date.now(), kind: failure ? "failed" : "done" });
	active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
	active.currentTools.delete(identity.sessionPath);
	markWorkerIdle(active, identity.sessionPath);
	const obligation = current.reviewNeeded === true;
	return failure
		? masterEvent.failed(identity.name, failure, obligation)
		: masterEvent.returned(identity.name, terminal!.text, obligation);
}

/** 两个起点各只有运行时一处记录；reload 后缺失的部分省略。 */
function withElapsedOf(active: MasterRuntime, event: MasterEvent, sessionPath?: string): string {
	const now = Date.now();
	const runStartedAt = sessionPath ? active.runStartedAt.get(sessionPath) : undefined;
	return withElapsed(event, {
		...(runStartedAt === undefined ? {} : { run: now - runStartedAt }),
		...(active.taskStartedAt === undefined ? {} : { task: now - active.taskStartedAt }),
	});
}

function unackedEvents(ctx: ExtensionContext): PendingMasterEvent[] {
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	const pending = new Map<string, PendingMasterEvent>();
	const acked = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || !record.data || typeof record.data !== "object") continue;
		const data = record.data as Record<string, unknown>;
		if (record.customType === PENDING_EVENT_TYPE && typeof data.id === "string" && typeof data.content === "string")
			pending.set(data.id, { id: data.id, content: data.content, ...(typeof data.worker === "string" ? { worker: data.worker } : {}) });
		if (record.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending.values()].filter((event) => !acked.has(event.id));
}

function monitorReview(
	session: { subscribe: (listener: (event: { type: string; entry?: unknown }) => void) => () => void; prompt: (text: string) => Promise<void> },
	sessionPath: string,
	previousRunId: string | undefined,
): Promise<ReviewOutcome> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe = () => {};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(error);
		};
		const finish = (outcome: ReviewOutcome) => {
			if (settled) return;
			const runId = reviewRunId(outcome);
			if (outcome.status !== "error"
				&& (!runId || runId === previousRunId || outcome.status === "in_progress" || outcome.status === "none")) return;
			settled = true;
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
				if (!runId || runId === previousRunId)
					return fail(new Error("fire-review 审查未启动"));
				finish(outcome);
			},
			fail,
		);
	});
}

/** 审查落定在活动列表上的事实：只有通过算完成，停止与未完成都是要指挥官看的失败行。 */
function reviewSettledFact(outcome: ReviewOutcome): SettledFact {
	const at = Date.now();
	if (outcome.status === "passed") return { at, kind: "done", note: "审查通过" };
	return { at, kind: "failed", note: outcome.status === "stopped" ? "审查停止" : "审查未完成" };
}

function reviewRunId(outcome: ReviewOutcome): string | undefined {
	return "runId" in outcome ? outcome.runId : undefined;
}

function captureWorkerTerminal(
	messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>,
): WorkerTerminal | undefined {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	if (!message) return undefined;
	return {
		text: textOf(message.content),
		...(message.stopReason ? { stopReason: message.stopReason } : {}),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
	};
}

function terminalFailure(terminal: WorkerTerminal | undefined): string | undefined {
	if (!terminal) return "回合结束但未产生 assistant 终态";
	if (terminal.stopReason === "error") return terminal.errorMessage || "供应商返回未知错误";
	if (terminal.stopReason === "aborted") return `回合意外中止：${terminal.errorMessage || "供应商未提供原因"}`;
	if (!terminal.text) return "回合结束但未产生回复";
	return undefined;
}

function faultSummary(terminal: WorkerTerminal): string {
	const message = terminal.errorMessage?.trim();
	if (!message) return "供应商返回未知错误";
	const [first = message] = message.split(/(?<=[.。!！?？])\s|\n/u);
	return clip(first.trim(), FAULT_SUMMARY_WIDTH);
}

function latestAssistantText(messages: Array<{ role: string; content?: unknown }>): string {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	return textOf(message?.content);
}


function reviewGateError(): string | undefined {
	const loaded = loadConfig();
	if (loaded.config.features.review === false) return "fire-review 已关闭，不能挂审查义务或发起审查";
	return "error" in loaded.review ? loaded.review.error : undefined;
}

function loadMasterPrompts() {
	try {
		return {
			master: readMasterPrompt("master"),
			worker: readMasterPrompt("worker"),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** 宿主已按 schema 枚举校验过 role，这里只查表。 */
function resolveRole(roles: MasterRole[], role: string): MasterRole {
	return roles.find((candidate) => candidate.role === role)!;
}

function nextFallback(role: MasterRole, worker: WorkerRef): ModelAtom | undefined {
	const chain: ModelAtom[] = [role, ...role.fallback];
	let index = chain.findIndex((atom) => atom.model === worker.model && atom.thinking === worker.thinking);
	if (index < 0) index = chain.findIndex((atom) => atom.model === worker.model);
	return chain[index + 1];
}

function rosterText(models: MasterRole[]): string {
	return models.map((entry) => {
		const fallback = entry.fallback.length
			? `，fallback ${entry.fallback.map(modelAtomText).join(" → ")}`
			: "";
		return `${entry.role}：${modelAtomText(entry)}（${entry.use}${fallback}）`;
	}).join("；");
}

function modelAtomText(atom: Pick<ModelAtom, "model" | "thinking">): string {
	return `${atom.model}/${atom.thinking}`;
}

function masterEventEnvelope(content: string): string {
	return wrapEnvelope("firecode_master_event", content);
}

function resumeCheckPrompt(): string {
	return masterEventEnvelope("上次被外部中断，先核对 git status 与现场再继续，避免重复执行已经发生的副作用。");
}

function fallbackResumePrompt(from: string, to: string, reason: string): string {
	return masterEventEnvelope(`供应商故障，已切换 ${from}→${to}（${reason}）。沿用当前会话与原工作说明，从中断处继续，不要重复已经完成的副作用。`);
}

const ACTION_VERB: Record<string, string> = { start: "启动", list: "查看", kill: "移除", send: "发送", interrupt: "中断", review: "审查", tail: "近况", ack: "待命" };
function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const parts: Part[] = [{ text: ACTION_VERB[action] ?? action, bold: true }];
	const target = optionalString(args.worker);
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	const role = optionalString(args.role);
	if ((action === "start" || action === "send") && role) parts.push({ text: ` · ${role}`, color: "muted" });
	const prompt = optionalString(args.prompt)?.split("\n", 1)[0];
	if (prompt && action === "start") parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

const renderSubagentsResult = makeResultRenderer(false);
const STATUS_WORD = { working: "工作", idle: "空闲", reviewing: "审查" } satisfies Record<WorkerStatus, string>;
const LIST_WIDGET_KEY = "firecode-master-list";
/** 边框身份：纯文字，子代理状态由输入框上方的活动列表承担。 */
const MASTER_IDENTITY = paint(HEAT_COLORS.orange, "指挥官");


function currentWorkerAction(active: MasterRuntime, worker: ReturnType<typeof compactWorker>) {
	if (worker.status === "reviewing") {
		const progress = active.reviewProgress.get(worker.session);
		return progress && { kind: "review" as const, ...progress };
	}
	if (worker.status === "idle") {
		let since = active.idleSince.get(worker.session);
		try {
			since ??= statSync(worker.session).mtimeMs;
		} catch {
			// 缺失档案仍可 list；真正恢复时由 send 明确报错。
		}
		return { kind: "idle" as const, ...(since ? { since } : {}) };
	}
	const current = [...(active.currentTools.get(worker.session)?.values() ?? [])].at(-1);
	return current ? { kind: "tool" as const, ...current } : undefined;
}

function expandedWorkerList(
	workers: unknown[],
	theme: ExtensionContext["ui"]["theme"],
	context: Parameters<typeof renderSubagentsResult>[3],
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			return ["", ...workers.flatMap((value) => {
				const worker = value as Record<string, unknown>;
				const action = worker.currentAction as {
					kind?: string;
					tool?: string;
					startedAt?: number;
					since?: number;
					round?: number;
					settled?: number;
					total?: number;
				} | undefined;
				const actionParts: Part[] = action?.kind === "tool" && action.tool && action.startedAt
					? [{
						text: ` · ${action.tool} · 已 ${formatDuration(Math.max(0, Date.now() - action.startedAt))}`,
						color: "accent",
					}]
					: action?.kind === "idle"
						? [{
							text: action.since ? ` · 落定 ${formatDuration(Date.now() - action.since)}前` : " · 已落定",
							color: "muted",
						}]
						: action?.kind === "review"
							? [{ text: ` · 第 ${action.round} 轮 · 审查者 ${action.settled}/${action.total}`, color: "accent" }]
							: [];
				return new ToolLine({
					label: String(worker.name),
					value: [
						{ text: roleStatusText(worker), color: "accent" },
						...actionParts,
						{ text: ` · ${String(worker.model).split("/").pop()}/${String(worker.thinking)}`, color: "muted" },
					],
					clip: "end",
					theme,
					ctx: { ...context, state: {}, expanded: false },
				}).render(width);
			})];
		},
	};
}
function listMeta(workers: unknown[]): Part[] {
	if (!workers.length) return [{ text: " — 池 0", color: "muted" }];
	return [{ text: ` — 池 ${workers.length}：${workers.map((value) => {
		const worker = value as Record<string, unknown>;
		return `${String(worker.name)} ${roleStatusText(worker)}`;
	}).join(" · ")}`, color: "muted" }];
}
/** 角色为主的状态投影：「工程师·工作」；档案缺角色时退到纯状态词。 */
function roleStatusText(worker: { role?: unknown; status?: unknown }): string {
	const status = STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status);
	return worker.role ? `${String(worker.role)}·${status}` : status;
}
export function statusText(workers: WorkerRef[]): string {
	return workers.length
		? workers.map((worker) => `${worker.name} ${roleStatusText(worker)} ${worker.model.split("/").pop()}`).join("\n")
		: "没有子代理";
}
function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
		role: worker.role,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		session: worker.sessionPath,
		...(worker.interruptedAt ? { interruptedAt: worker.interruptedAt } : {}),
		...(worker.reviewNeeded ? { reviewNeeded: true } : {}),
		...(worker.disposition ? { disposition: worker.disposition } : {}),
	};
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

function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}
function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	return value.trim();
}
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
async function outsideCheckoutReason(path: string, cwd: string): Promise<string | undefined> {
	const root = await realpath(cwd);
	const target = await canonicalWritePath(resolve(cwd, path));
	const local = relative(root, target);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ? `子代理只能修改当前 checkout：${path}` : undefined;
}
async function canonicalWritePath(path: string): Promise<string> {
	let ancestor = path;
	const missing: string[] = [];
	while (true) {
		try {
			return resolve(await realpath(ancestor), ...missing.reverse());
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) return path;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}
