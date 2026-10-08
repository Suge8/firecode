/**
 * /fire-master 的注册入口：激活与停用、命令、两个工具与生命周期。
 * 运行时事实在 runtime.ts，回合编排在 run.ts，七个动作在 actions.ts，发件箱在 outbox.ts，工具行在 list-view.ts。
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKERS_CHANNEL, type WorkersPayload, watchBusy } from "../busy.js";
import { loadConfig, type MasterRole } from "../config.js";
import { ToolLine } from "../tools/line.js";
import { ACTION_HANDLERS, ACTIONS } from "./actions.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { registerWorkerGuard } from "./guard.js";
import {
	compactWorker, currentWorkerAction, expandedWorkerList, listMeta, renderSubagentsResult, statusText, subagentsCallParts,
} from "./list-view.js";
import { assembleMasterPrompt, readMasterPrompt } from "./prompt.js";
import { armInterruptReminder, modelAtomText } from "./run.js";
import { MasterRuntime, type MasterSetup } from "./runtime.js";
import { InProcessSessionPool } from "./spawn.js";
import { loadMasterState, masterStatePath, recoverMasterState, THINKING_LEVELS, type MasterState } from "./state.js";

const MASTER_TOOL = "subagents";
const MASTER_LIST_TOOL = "subagents_list";
const MASTER_TOOLS = [MASTER_TOOL, MASTER_LIST_TOOL];
const INTERRUPT_RESUME_MS = 5 * 60_000;
/**
 * 一批结果陆续返回时，最后一条后静默这么久才唤醒空闲的指挥官：合并唤醒，单条结果最多多等这一下。
 * 这是业务语义的等待：“这一批还会不会马上再来一条”没有事件能回答。同批结果相邻间隔约 2～3 秒，而唤醒回合本身要数秒，
 * 1.5 秒足以把紧挨着的并进一次唤醒，回合开跑后再到的走句缝。
 */
const WAKE_QUIET_MS = 1_500;

interface MasterDependencies {
	pool?: InProcessSessionPool;
	interruptResumeMs?: number;
	wakeQuietMs?: number;
}

export function registerMaster(pi: ExtensionAPI, dependencies: MasterDependencies = {}, worker = false): void {
	// Worker 会话里只注册 checkout 守卫，不注册命令、工具与生命周期。
	if (worker) return registerWorkerGuard(pi);
	const loaded = loadConfig().master;
	const prompts = loadMasterPrompts();
	const startupError = "error" in loaded ? loaded.error : "error" in prompts ? prompts.error : undefined;
	const roster = "error" in loaded ? [] : loaded.config.roles;
	const autoActivate = "error" in loaded ? false : loaded.config.autoActivate;
	const requirePrompts = () => {
		if ("error" in prompts) throw new Error(prompts.error);
		return prompts;
	};
	// 在飞子代理数的唯一发布者。
	let publishedInFlight = 0;
	const publishInFlight = (count: number, teardown = false) => {
		if (count === publishedInFlight) return;
		publishedInFlight = count;
		pi.events.emit(WORKERS_CHANNEL, { inFlight: count, ...(teardown ? { teardown: true as const } : {}) } satisfies WorkersPayload);
	};
	// 事件末尾的“当前任务”耗时是给指挥官的时间信号（Opus 5.5 据已用时间安排并行）；起点只取 busy.ts。
	let sessionSince: number | undefined;
	watchBusy(pi, { onChange: (view) => { sessionSince = view.since; } });
	const setup: MasterSetup = {
		pi,
		pool: dependencies.pool ?? new InProcessSessionPool(),
		roster,
		exclusions: "error" in loaded ? [] : loaded.config.workerExcludeExtensions,
		workerPrompt: () => requirePrompts().worker,
		reviewGate: reviewGateError(),
		interruptResumeMs: dependencies.interruptResumeMs ?? INTERRUPT_RESUME_MS,
		wakeQuietMs: dependencies.wakeQuietMs ?? WAKE_QUIET_MS,
		publishInFlight,
		sessionSince: () => sessionSince,
	};
	let runtime: MasterRuntime | undefined;
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => !MASTER_TOOLS.includes(name));
		pi.setActiveTools(active ? [...tools, ...MASTER_TOOLS] : tools);
	};
	const activate = (ctx: ExtensionContext, restored?: MasterState): MasterRuntime => {
		if (startupError) throw new Error(startupError);
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		const active = runtime = new MasterRuntime(setup, ctx, restored);
		setTools(true);
		if (active.store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(`旧版 v${active.store.discardedLegacyVersion} 子代理池已丢弃并从空池重建；旧运行时进程不会纳入新池，请手动清理`, "warning");
		active.render();
		return active;
	};
	/** 会话关闭先清空当前 runtime，再释放池、订阅与定时器：迟到任务不写状态、投递、UI 或持久化。 */
	const deactivate = async () => {
		const active = runtime;
		runtime = undefined;
		active?.close();
		// 遗弃在飞子代理不是歇下：带 teardown 归零，busy.ts 只结束本段。
		publishInFlight(0, true);
		await setup.pool.disposeAll();
		setTools(false);
	};
	/** reload 恢复：在飞状态收敛为 idle + interruptedAt，补挂续跑提醒，重投未确认事件。 */
	const activateSession = (ctx: ExtensionContext): MasterRuntime => {
		if (runtime) return activate(ctx);
		let restored: MasterState | undefined;
		try {
			restored = loadMasterState(masterStatePath(getAgentDir(), ctx.sessionManager.getSessionId()));
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
		active.outbox.replayUnacked(ctx);
		return active;
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
		if (event.source !== "extension") runtime?.collapseList();
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
					workers: workers.map((worker) => ({ ...worker, currentAction: currentWorkerAction(worker, active.live.get(worker.name)) })),
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
			action: StringEnum(ACTIONS, { description: "七动作之一；等待状态变化，不要用 sleep 轮询。" }),
			worker: Type.String({ description: "start 起简短任务名；其余动作填目标 Worker。" }),
			prompt: Type.Optional(Type.String({ description: "start/send 必填自包含任务说明，包括交付物、限制与验证要求。" })),
			// 角色词只来自角色表，代码不持有固定词表；代价是角色名拼错无法在加载时报出。
			role: Type.Optional(StringEnum(roster.map((entry) => entry.role), { description: "start 必填角色表中的角色；send 可选，传入时切换角色，省略则沿用。" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "可选思考档覆盖；省略时使用角色原子档或当前档。" })),
			cwd: Type.Optional(Type.String({ description: "Worker 工作目录的绝对路径；start 默认当前目录，send 给空闲 Worker 换检出时带上（同一会话重开）。" })),
			review: Type.Optional(Type.Boolean({ description: "按审查纪律为 start/send 记录义务；true 不自动开审。" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (!active) throw new Error("subagents 只在 Master 中可用");
			const handler = ACTION_HANDLERS[params.action as keyof typeof ACTION_HANDLERS];
			if (!handler) throw new Error(`未知 subagents action：${String(params.action)}`);
			return handler(active, params, ctx);
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

function reviewGateError(): string | undefined {
	const loaded = loadConfig();
	if (loaded.config.features.review === false) return "fire-review 已关闭，不能挂审查义务或发起审查";
	return "error" in loaded.review ? loaded.review.error : undefined;
}

function loadMasterPrompts() {
	try {
		return { master: readMasterPrompt("master"), worker: readMasterPrompt("worker") };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function rosterText(models: MasterRole[]): string {
	return models.map((entry) => {
		const fallback = entry.fallback.length ? `，fallback ${entry.fallback.map(modelAtomText).join(" → ")}` : "";
		return `${entry.role}：${modelAtomText(entry)}（${entry.use}${fallback}）`;
	}).join("；");
}
