/**
 * /fire-master 的注册入口：激活与停用、命令、两个工具与生命周期。
 * 运行时事实在 runtime.ts，回合编排在 run.ts，七个动作在 actions.ts，发件箱在 outbox.ts，工具行在 list-view.ts。
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { busyView, WORKERS_CHANNEL, type WorkersPayload } from "../busy.js";
import { loadConfig, type MasterRole, modelAtomText, THINKING_LEVELS } from "../config.js";
import { ToolLine } from "../tools/line.js";
import { ACTION_HANDLERS, ACTIONS, type Action } from "./actions.js";
import { registerMasterEventRenderer } from "./event-card.js";
import {
	compactWorker, currentWorkerAction, expandedWorkerList, listMeta, type ListedWorker, renderSubagentsResult, statusText, subagentsCallParts,
} from "./list-view.js";
import { msg } from "./messages.js";
import { assembleMasterPrompt, readMasterPrompt } from "./prompt.js";
import { armInterruptReminder } from "./run.js";
import { MasterRuntime, type MasterSetup } from "./runtime.js";
import { SUBAGENTS_CHANNEL, type SubagentInfo, type SubagentsPayload } from "./roster.js";
import type { InProcessSessionPool } from "../spawn.js";

const MASTER_TOOL = "subagents";
const MASTER_LIST_TOOL = "subagents_list";
const MASTER_TOOLS = [MASTER_TOOL, MASTER_LIST_TOOL];

export function registerMaster(pi: ExtensionAPI, pool: InProcessSessionPool): void {
	const all = loadConfig();
	const loaded = all.master;
	const prompts = loadMasterPrompts();
	// 配置或提示词有问题时拒绝激活：runtime 存在就意味着两者都可用。
	const startupError = "error" in loaded ? loaded.error : prompts.error;
	const roster = "error" in loaded ? [] : loaded.config.roles;
	const autoActivate = "error" in loaded ? false : loaded.config.autoActivate;
	// 在飞子代理数的唯一发布者。
	let publishedInFlight = 0;
	const publishInFlight = (count: number, teardown = false) => {
		if (count === publishedInFlight) return;
		publishedInFlight = count;
		pi.events.emit(WORKERS_CHANNEL, { inFlight: count, ...(teardown ? { teardown: true as const } : {}) } satisfies WorkersPayload);
	};
	// 子代理名册的唯一发布者；停用发空名册，读者据此清掉。
	let publishedRoster = "[]";
	const publishRoster = (workers: SubagentInfo[]) => {
		const key = JSON.stringify(workers);
		if (key === publishedRoster) return;
		publishedRoster = key;
		pi.events.emit(SUBAGENTS_CHANNEL, { workers } satisfies SubagentsPayload);
	};
	const setup: MasterSetup = {
		pi,
		pool,
		roster,
		exclusions: "error" in loaded ? [] : loaded.config.workerExcludeExtensions,
		workerPrompt: prompts.worker,
		reviewGate: all.config.features.review === false ? msg.command.reviewOff : "error" in all.review ? all.review.error : undefined,
		publishInFlight,
		publishRoster,
		// 事件末尾的“当前任务”耗时是给指挥官的时间信号；起点只取 busy.ts。
		sessionSince: () => busyView(pi).since,
	};
	let runtime: MasterRuntime | undefined;
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => !MASTER_TOOLS.includes(name));
		pi.setActiveTools(active ? [...tools, ...MASTER_TOOLS] : tools);
	};
	/** 激活（含 reload 恢复）：载入档案时在飞状态已收敛为 idle + interruptedAt，这里补挂续跑提醒并重投未确认事件。 */
	const activate = (ctx: ExtensionContext): void => {
		if (startupError) throw new Error(startupError);
		const active = runtime = new MasterRuntime(setup, ctx);
		setTools(true);
		if (active.store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(msg.command.legacyPool(active.store.discardedLegacyVersion), "warning");
		active.render();
		// 只有本次载入收敛的子代理是被重载打断的；指挥官自己 interrupt 的、早已提醒过的不再提醒。
		for (const name of active.store.recovered) armInterruptReminder(active, active.store.require(name));
		active.outbox.replayUnacked(ctx);
	};
	/** 会话关闭先清空当前 runtime，再释放池、订阅与定时器：迟到任务不写状态、投递、UI 或持久化。 */
	const deactivate = async () => {
		const active = runtime;
		runtime = undefined;
		active?.close();
		// 遗弃在飞子代理不是歇下：带 teardown 归零，busy.ts 只结束本段。
		publishInFlight(0, true);
		publishRoster([]);
		await setup.pool.disposeWorkers();
		setTools(false);
	};

	pi.registerCommand("fire-master", {
		description: msg.command.description,
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				ctx.ui.notify(runtime ? statusText(runtime.store.workers) : msg.command.notStarted, "info");
				return;
			}
			if (input) {
				ctx.ui.notify(msg.command.statusOnly, "error");
				return;
			}
			if (runtime) {
				if (!(await confirmStop(runtime, ctx))) return;
				await deactivate();
				ctx.ui.notify(msg.command.off, "info");
				return;
			}
			try {
				activate(ctx);
				ctx.ui.notify(msg.command.on, "info");
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
		event.systemPromptOptions.sections.firecode_master = assembleMasterPrompt(prompts.master, rosterText(roster));
	});

	pi.registerTool({
		name: MASTER_LIST_TOOL,
		label: msg.tool.label,
		description: msg.tool.listDescription,
		renderShell: "self",
		renderCall: (_args, theme, ctx) =>
			new ToolLine({ label: msg.tool.label, value: subagentsCallParts({ action: "list" }), clip: "end", theme, ctx }),
		renderResult: (result, options, theme, context) => {
			const workers = (result.details as { workers?: ListedWorker[] } | undefined)?.workers;
			context.state.meta = !context.isError && workers ? listMeta(workers) : undefined;
			if (options.expanded && workers) return expandedWorkerList(workers, theme, context);
			return renderSubagentsResult(result, options, theme, context);
		},
		parameters: Type.Object({}),
		async execute() {
			const active = runtime;
			if (!active) throw new Error(msg.tool.onlyInMaster(MASTER_LIST_TOOL));
			const workers = active.store.workers.map(compactWorker);
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
		label: msg.tool.label,
		description: msg.tool.description,
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: msg.tool.label, value: subagentsCallParts(args as Record<string, unknown>), clip: "end", theme, ctx }),
		renderResult: renderSubagentsResult,
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: msg.tool.action }),
			worker: Type.String({ description: msg.tool.worker }),
			prompt: Type.Optional(Type.String({ description: msg.tool.prompt })),
			// 角色词只来自角色表，代码不持有固定词表；代价是角色名拼错无法在加载时报出。
			role: Type.Optional(StringEnum(roster.map((entry) => entry.role), { description: msg.tool.role })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: msg.tool.thinking })),
			cwd: Type.Optional(Type.String({ description: msg.tool.cwd })),
			review: Type.Optional(Type.Boolean({ description: msg.tool.review })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (!active) throw new Error(msg.tool.onlyInMaster(MASTER_TOOL));
			return ACTION_HANDLERS[params.action as Action](active, params, ctx, "master");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await deactivate();
		if (!autoActivate) return;
		try {
			activate(ctx);
		} catch (error) {
			ctx.ui.notify(msg.command.restoreFailed(error instanceof Error ? error.message : String(error)), "error");
		}
	});

	pi.on("session_shutdown", () => deactivate());
}

/** 关闭会中断在跑的子代理：有界面时先让用户确认；无界面（print、rpc）照旧直接关。 */
async function confirmStop(active: MasterRuntime, ctx: ExtensionContext): Promise<boolean> {
	const running = active.store.workers.filter((worker) => worker.status !== "idle").length;
	return !running || !ctx.hasUI || ctx.ui.confirm(msg.command.confirmOffTitle, msg.command.confirmOff(running));
}

function loadMasterPrompts(): { master: string; worker: string; error?: string } {
	try {
		return { master: readMasterPrompt("master"), worker: readMasterPrompt("worker") };
	} catch (error) {
		return { master: "", worker: "", error: error instanceof Error ? error.message : String(error) };
	}
}

function rosterText(models: MasterRole[]): string {
	return models.map((entry) => {
		const fallback = entry.fallback.length ? msg.roster.fallback(entry.fallback.map(modelAtomText).join(" → ")) : "";
		return msg.roster.entry(entry.role, modelAtomText(entry), entry.use, fallback);
	}).join(msg.roster.join);
}
