/**
 * /fire-master 的注册入口：激活与停用、命令、两个工具与生命周期。
 * 运行时事实在 runtime.ts，回合编排在 run.ts，七个动作在 actions.ts，发件箱在 outbox.ts，工具行在 list-view.ts；
 * 活动列表与全过程视图在这里挂到运行时上（运行时不认识界面）。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { busyView, WORKERS_CHANNEL, type WorkersPayload } from "../busy.js";
import { loadConfig, THINKING_LEVELS } from "../config.js";
import { ToolLine } from "../tools/line.js";
import { ACTION_HANDLERS, ACTIONS, type Action } from "./actions.js";
import { ActivityList, visibleRows } from "./activity-list.js";
import { registerMasterEventRenderer } from "./event-card.js";
import {
	expandedWorkerList, listedWorkers, listMeta, type ListedWorker, renderSubagentsResult, statusText, subagentsCallParts,
} from "./list-view.js";
import { compactWorker } from "./state.js";
import { msg } from "./messages.js";
import { assembleMasterPrompt, MASTER_PROMPT } from "./prompt.js";
import { armInterruptReminder, armResume } from "./run.js";
import { Roles } from "./roles.js";
import { MasterRuntime, type MasterSetup } from "./runtime.js";
import { SUBAGENTS_CHANNEL, type SubagentInfo, type SubagentsPayload } from "./roster.js";
import { openWorkerView } from "./worker-view.js";
import type { InProcessSessionPool } from "../spawn.js";

const MASTER_TOOL = "subagents";
const MASTER_LIST_TOOL = "subagents_list";
const MASTER_TOOLS = [MASTER_TOOL, MASTER_LIST_TOOL];
const LIST_WIDGET_KEY = "firecode-master-list";

export function registerMaster(pi: ExtensionAPI, pool: InProcessSessionPool): void {
	const all = loadConfig();
	const loaded = all.master;
	// 配置有问题时拒绝激活：runtime 存在就意味着配置可用。
	const startupError = "error" in loaded ? loaded.error : undefined;
	const configuredRoles = "error" in loaded ? [] : loaded.config.roles;
	const roleParameter = Type.Optional(StringEnum(configuredRoles.map((entry) => entry.role), { description: msg.tool.role }));
	/** 本次会话核对过的角色表：session_start 作废重核，激活与切换开关沿用（不可用角色只告警一次）。 */
	let roles: Promise<Roles> | undefined;
	const prepareRoles = (ctx: ExtensionContext): Promise<Roles> => roles ??= Roles.check(configuredRoles, pool).then((checked) => {
		const { warning } = checked;
		if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
		else if (warning) console.error(warning);
		return checked;
	});
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
		progress: all.config.background?.model ?? false,
		exclusions: "error" in loaded ? [] : loaded.config.workerExcludeExtensions,
		reviewGate: all.config.features.review === false ? msg.command.reviewOff : "error" in all.review ? all.review.error : undefined,
		publishInFlight,
		publishRoster,
		// 事件末尾的“当前任务”耗时是给指挥官的时间信号；起点只取 busy.ts。
		sessionSince: () => busyView(pi).since,
	};
	let runtime: MasterRuntime | undefined;
	let activity: ReturnType<typeof mountActivity> | undefined;
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => !MASTER_TOOLS.includes(name));
		pi.setActiveTools(active ? [...tools, ...MASTER_TOOLS] : tools);
	};
	/**
	 * 激活（含 reload 恢复）：载入档案时在飞状态已收敛为 idle + interruptedAt + reloadInterrupted，这里按标记补挂续跑提醒、按档案重挂暂停的自动续跑，
	 * 重投未确认事件，并重判上一回合是否因瞬时故障留下没处理的事件。
	 */
	const activate = async (ctx: ExtensionContext): Promise<void> => {
		if (startupError) throw new Error(startupError);
		const active = runtime = new MasterRuntime(setup, ctx, await prepareRoles(ctx));
		activity = mountActivity(active);
		setTools(true);
		if (active.store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(msg.command.legacyPool(active.store.discardedLegacyVersion), "warning");
		active.render();
		// 只有带 reloadInterrupted 的票是被重载打断、还没提醒的；指挥官自己 interrupt 的、早已提醒过的不再提醒。
		for (const worker of active.store.workers) {
			armInterruptReminder(active, worker);
			armResume(active, worker);
		}
		active.outbox.replayUnacked(ctx);
		active.outbox.resumeIfStranded();
	};
	/** 会话关闭先清空当前 runtime，再释放池、订阅与定时器：迟到任务不写状态、投递、UI 或持久化。 */
	const deactivate = async () => {
		const active = runtime;
		runtime = undefined;
		active?.close();
		activity?.dispose();
		activity = undefined;
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
				ctx.ui.notify(runtime ? statusText(listedWorkers(runtime.activityFacts(), Date.now())) : msg.command.notStarted, "info");
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
				await activate(ctx);
				ctx.ui.notify(msg.command.on, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("agent_settled", () => runtime?.outbox.resumeIfStranded());

	pi.on("input", (event) => {
		if (event.source !== "extension") activity?.collapse();
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime || !pi.getActiveTools().includes(MASTER_TOOL)) return;
		event.systemPromptOptions.sections.firecode_master = assembleMasterPrompt(MASTER_PROMPT, runtime.roles.promptText);
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
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ workers: active.store.workers.map(compactWorker) }) }],
				details: { workers: listedWorkers(active.activityFacts(), Date.now()) },
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
			role: roleParameter,
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: msg.tool.thinking })),
			cwd: Type.Optional(Type.String({ description: msg.tool.cwd })),
			review: Type.Optional(Type.Boolean({ description: msg.tool.review })),
		}),
		async execute(_id, params: Record<string, unknown>) {
			const active = runtime;
			if (!active) throw new Error(msg.tool.onlyInMaster(MASTER_TOOL));
			return ACTION_HANDLERS[params.action as Action](active, params);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await deactivate();
		roles = undefined;
		if (!startupError) await prepareRoles(ctx);
		if (!autoActivate) return;
		try {
			await activate(ctx);
		} catch (error) {
			ctx.ui.notify(msg.command.restoreFailed(error instanceof Error ? error.message : String(error)), "error");
		}
	});

	pi.on("session_shutdown", () => deactivate());
}

/**
 * 输入框上方的活动列表与点行打开的全过程视图：读运行时的事实、随 onChange 重绘；视图草稿活到指挥官停用。
 * 下一轮人类输入时收起展开（collapse）。
 */
function mountActivity(active: MasterRuntime): { collapse(): void; dispose(): void } {
	const drafts = new Map<string, string>();
	let list: ActivityList | undefined;
	active.ctx.ui.setWidget(LIST_WIDGET_KEY, (tui, theme) => {
		list = new ActivityList(tui, theme, () => active.activityFacts(), () => visibleRows(tui.terminal?.rows), (name) => void openWorkerView(active, name, drafts));
		return list;
	}, { placement: "aboveEditor" });
	const stop = active.onChange(() => list?.sync());
	return {
		collapse: () => list?.collapse(),
		dispose() {
			stop();
			list?.dispose();
			active.ctx.ui.setWidget(LIST_WIDGET_KEY, undefined);
		},
	};
}

/** 关闭会中断在跑的子代理：有界面时先让用户确认；无界面（print、rpc）照旧直接关。 */
async function confirmStop(active: MasterRuntime, ctx: ExtensionContext): Promise<boolean> {
	const running = active.store.workers.filter((worker) => worker.status !== "idle").length;
	return !running || !ctx.hasUI || ctx.ui.confirm(msg.command.confirmOffTitle, msg.command.confirmOff(running));
}
