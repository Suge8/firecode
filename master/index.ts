import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MASTER_MODELS, loadConfig, type MasterModel } from "../config.js";
import { HerdrWorkers } from "./herdr.js";
import {
	MasterStore,
	THINKING_LEVELS,
	liveWorkers,
	loadMasterState,
	masterStatePath,
	type MasterState,
	type WorkerRef,
} from "./state.js";

const MASTER_TOOL = "subagents";
const MASTER_EVENT_TYPE = "firecode-master-event";
/** 收件箱持久化：结果先落 Master 会话（pending），投递后写 ack；reload/crash 后未 ack 的重投。 */
const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";

interface MasterEvent {
	id: string;
	content: string;
}

interface MasterRuntime {
	role: "master";
	ctx: ExtensionContext;
	store: MasterStore;
	herdr: HerdrWorkers;
	events: MasterEvent[];
	/** 显式回合状态位：宿主在 emit agent_settled 前就置 idle，不能拿 isIdle 当回合边界。 */
	turnActive: boolean;
	flushTimer?: NodeJS.Timeout;
}

interface WorkerRuntime {
	role: "worker";
	ctx: ExtensionContext;
	name: string;
}

type Runtime = MasterRuntime | WorkerRuntime;

export function registerMaster(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	const masterModels = loadMasterModels();
	const reviewGate = reviewGateError();

	const setTools = (role?: Runtime["role"]) => {
		const without = pi.getActiveTools().filter((name) => name !== MASTER_TOOL);
		// Worker 就是普通 pi（默认四工具含 bash），只保证拿不到 Master 工具；ADR-0004。
		if (role === "master") pi.setActiveTools([...without, MASTER_TOOL]);
		else pi.setActiveTools(without);
	};

	const renderStatus = () => {
		if (!runtime) return;
		if (runtime.role === "worker") {
			runtime.ctx.ui.setStatus("master", `↳ ${runtime.name}`);
			return;
		}
		const live = liveWorkers(runtime.store.state).length;
		const dormant = runtime.store.state.workers.length - live;
		const reviewing = runtime.store.state.workers.filter((worker) => worker.status === "reviewing").length;
		runtime.ctx.ui.setStatus("master", `◆ ${live}w${reviewing ? ` ${reviewing} reviewing` : ""}${dormant ? ` ${dormant}d` : ""}`);
	};

	const flushMasterEvents = (active: MasterRuntime) => {
		active.flushTimer = undefined;
		if (runtime !== active || active.events.length === 0) return;
		// 宿主 followUpMode 默认 one-at-a-time：回合中投递多条会被拆成多个回合。
		// 门槛是显式回合位而非 isIdle：宿主在 emit agent_settled 前就置 idle，
		// 那个窗口里 flush 会把同一批结果拆投。agent_settled 才是回合边界。
		if (active.turnActive) return;
		const batch = active.events.splice(0);
		const content = batch.map((event) => event.content).join("\n\n");
		try {
			pi.sendMessage(
				{ customType: MASTER_EVENT_TYPE, content, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			// 投递失败不丢结果：留在队列等下一个回合边界重试；pending 未 ack，reload 也能续投。
			active.events.unshift(...batch);
			active.ctx.ui.notify(`Worker 结果投递失败，将自动重试：${String(error)}`, "warning");
			return;
		}
		// ack 失败只影响去重（reload 后可能重复投递一次），不影响本次已成功的投递。
		try {
			pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
		} catch {
			// 重复投递无害，静默即可；下一条 ack 会一并覆盖。
		}
		renderStatus();
	};

	const enqueueMasterEvent = (active: MasterRuntime, event: MasterEvent, persist: boolean) => {
		if (persist) {
			try {
				pi.appendEntry(PENDING_EVENT_TYPE, event);
			} catch (error) {
				// 持久化失败不阻断投递，只失去 crash 恢复保障；如实告知。
				active.ctx.ui.notify(`Worker 结果持久化失败（crash 时可能丢失这条）：${String(error)}`, "warning");
			}
		}
		active.events.push(event);
		if (active.flushTimer) return;
		active.flushTimer = setTimeout(() => flushMasterEvents(active), 100);
		active.flushTimer.unref?.();
	};

	const notifyMaster = (content: string) => {
		if (runtime?.role !== "master") return;
		enqueueMasterEvent(runtime, { id: crypto.randomUUID(), content }, true);
	};

	const activateMaster = async (ctx: ExtensionContext, restored?: MasterState): Promise<MasterRuntime> => {
		if ("error" in masterModels) throw new Error(masterModels.error);
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
			throw new Error("/fire-master 必须运行在 Herdr 管理的 Pi pane 中");
		if (runtime?.role === "master") {
			runtime.ctx = ctx;
			return runtime;
		}
		if (runtime?.role === "worker") throw new Error("Worker 不能提升为 Master");
		const path = masterStatePath(ctx.sessionManager.getSessionId());
		const store = new MasterStore(path, restored);
		const activationEvents: string[] = [];
		let deliverMasterEvent = (content: string): void => {
			activationEvents.push(content);
		};
		const herdr = new HerdrWorkers({
			pi,
			store,
			workspaceId: process.env.HERDR_WORKSPACE_ID,
			notifyMaster: (content) => deliverMasterEvent(content),
		});
		try {
			await herdr.resume();
		} catch (error) {
			await herdr.shutdown();
			throw error;
		}
		const candidate: MasterRuntime = { role: "master", ctx, store, herdr, events: [], turnActive: false };
		runtime = candidate;
		deliverMasterEvent = notifyMaster;
		setTools("master");
		for (const content of activationEvents) notifyMaster(content);
		renderStatus();
		return candidate;
	};

	const deactivate = async (cleanup: boolean): Promise<string[]> => {
		const active = runtime;
		runtime = undefined;
		if (!active) return [];
		try {
			if (active.role !== "master") return [];
			if (active.flushTimer) clearTimeout(active.flushTimer);
			// 等旧实例的在飞启动退出：reload 时新运行时才不会和它交错写同一状态文件。
			await active.herdr.shutdown();
			if (!cleanup) return [];
			const failures = await active.herdr.cleanup();
			if (failures.length === 0) active.store.dispatch({ type: "CLEAR" });
			return failures;
		} finally {
			active.ctx.ui.setStatus("master", undefined);
			setTools();
		}
	};

	pi.registerCommand("fire-master", {
		description: "启用 Master Worker Pool：/fire-master [status|off]",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				if (runtime?.role !== "master") {
					ctx.ui.notify("Master 未启用", "info");
					return;
				}
				ctx.ui.notify(statusText(runtime.store.state.workers), "info");
				return;
			}
			if (input === "off") {
				const failures = await deactivate(true);
				ctx.ui.notify(
					failures.length ? `Master 已关闭，但 Worker 清理失败：${failures.join("；")}` : "Master 已关闭并清理 Worker",
					failures.length ? "warning" : "info",
				);
				return;
			}
			if (input) {
				ctx.ui.notify("/fire-master 只接受 status 或 off；启用后直接描述需求", "error");
				return;
			}
			try {
				await activateMaster(ctx);
				ctx.ui.notify("Master Worker Pool 已启用", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: MASTER_TOOL,
		label: "Subagents",
		description: "启动、追问、审查、列出、休眠或遗忘 Master 拥有的并行 Worker。结果异步回传。",
		promptGuidelines: masterGuidelines("error" in masterModels ? DEFAULT_MASTER_MODELS : masterModels.models),
		parameters: Type.Object({
			action: StringEnum(["list", "start", "send", "review", "stop"] as const),
			worker: Type.Optional(Type.String({ description: "start 必填简短任务词（如 fix-outcome）；其余 action 指定目标 Worker" })),
			prompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "可选 provider/model；省略则继承当前模型" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
			session: Type.Optional(Type.String({ description: "可选 Dormant Worker 名或 Pi session path" })),
			review: Type.Optional(Type.Boolean({ description: "start 可选：重要票——完成后自动发起对抗审查并回传终态" })),
			forget: Type.Optional(Type.Boolean({ description: "stop 时彻底删除引用；默认保留为 Dormant Worker" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (active?.role !== "master") throw new Error("subagents 只在 Master 中可用");
			if (params.action === "list") return toolResult({ workers: active.store.state.workers.map(compactWorker) });
			if (params.action === "start") {
				// 审查票在派发时即验可用性：review 不可用就拒绝，不让意图落地后才发现审不了。
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				const worker = await active.herdr.start(ctx, {
					prompt: requiredString(params.prompt, "prompt"),
					...(params.review === true ? { review: true } : {}),
					...(optionalString(params.worker) ? { name: optionalString(params.worker) } : {}),
					...(optionalString(params.model) ? { model: optionalString(params.model) } : {}),
					...(optionalString(params.thinking) ? { thinking: optionalString(params.thinking) } : {}),
					...(optionalString(params.session) ? { session: optionalString(params.session) } : {}),
				});
				renderStatus();
				return toolResult({ started: true, worker: compactWorker(worker) });
			}
			if (params.action === "send") {
				await active.herdr.send(requiredString(params.worker, "worker"), requiredString(params.prompt, "prompt"));
				return toolResult({ sent: true });
			}
			if (params.action === "review") {
				// 门禁：review 关闭时 Worker 会话没有 /fire-review 命令，投递会退化成普通模型输入；
				// 配置有错时命令存在但拒绝启动，只会延迟报“审查未启动”。两种都在投递前拦住。
				if (reviewGate) throw new Error(reviewGate);
				await active.herdr.review(requiredString(params.worker, "worker"));
				renderStatus();
				return toolResult({ reviewing: true });
			}
			if (params.action === "stop") {
				await active.herdr.stop(requiredString(params.worker, "worker"), params.forget === true);
				renderStatus();
				return toolResult({ stopped: true, forgotten: params.forget === true });
			}
			throw new Error(`未知 subagents action：${String(params.action)}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await deactivate(false);
		const workerName = process.env.FIRECODE_MASTER_WORKER;
		if (workerName) {
			runtime = { role: "worker", ctx, name: workerName };
			setTools("worker");
			renderStatus();
			return;
		}
		try {
			const restored = loadMasterState(masterStatePath(ctx.sessionManager.getSessionId()));
			if (restored?.workers.length) {
				const active = await activateMaster(ctx, restored);
				// crash/reload 窗口内未投递的结果凭 pending−ack 差集重投；已在队列的不重复入队。
				const queued = new Set(active.events.map((event) => event.id));
				for (const event of unackedEvents(ctx))
					if (!queued.has(event.id)) enqueueMasterEvent(active, event, false);
			} else setTools();
		} catch (error) {
			setTools();
			ctx.ui.notify(`Master 恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("agent_start", () => {
		if (runtime?.role === "master") runtime.turnActive = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (runtime?.role !== "master") return;
		runtime.ctx = ctx;
		runtime.turnActive = false;
		if (runtime.events.length === 0 || runtime.flushTimer) return;
		const active = runtime;
		active.flushTimer = setTimeout(() => flushMasterEvents(active), 100);
		active.flushTimer.unref?.();
	});

	pi.on("before_agent_start", (event) => {
		if (runtime?.role === "worker")
			return { systemPrompt: `${event.systemPrompt}\n\n${workerInstructions(runtime.name)}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (runtime?.role !== "worker") return;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
		if (reason) return { block: true, reason };
	});

	pi.on("session_shutdown", async (event) => {
		await deactivate(event.reason !== "reload");
	});
}

/** 配置门禁与 review 同理：花名册错误会拿错模型真实发起 Worker，静默回退不可接受。 */
function loadMasterModels(): { models: MasterModel[] } | { error: string } {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("master") ||
			problem.startsWith("未知字段 master.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0) return { error: `Master 配置有问题，已停止：${problems.join("；")}` };
	return { models: loaded.config.master.models };
}

/** review action 前置门禁：与 review 模块同源同规则，但在投递前判定，避免把命令发进注定不会开审的会话。 */
function reviewGateError(): string | undefined {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}`;
	}
	if (loaded.config.features.review === false)
		return "fire-review 已关闭（features.review=false），不能发起 Worker 审查";
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("review") ||
			problem.startsWith("未知字段 review.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0) return `fire-review 配置有问题，不能发起 Worker 审查：${problems.join("；")}`;
	return undefined;
}

function masterGuidelines(models: MasterModel[]): string[] {
	const roster = models
		.map((entry) => `${entry.model}（${entry.use}，thinking ${entry.thinking}）`)
		.join("；");
	return [
	"subagents 激活时，你是唯一的指挥官（Master），负责是否委派、如何分派和最终验收；普通问题直接回答，不必开工人。",
	`指挥官拥有的工人（Worker）的全部生命周期只经 subagents 工具控制。选型表：${roster}。start 时显式传选型表里的 model 与 thinking，用户显式指定则优先。`,
	"硬约束：禁止用 bash 调 herdr CLI 起工人、给工人发消息或管工人生命周期——CLI 起的工人是脱管工人，收不到任何完成/阻塞回传、不会自动审查，你会对它们全盲。start 失败会自动重试；仍失败就把错误报告给用户等待决策，不自行绕道。",
	"发现脱管工人（在 herdr 里跑但不在 subagents list 中）时收编：等它空闲后让其 pi 退出（会话文件保留），再用 start 传 session 路径拉回池内，上下文无损、回传恢复。",
	"start 的 worker 名用简短任务词（如 fix-outcome、scan-dups）；pane/tab/Pi 会话显示名会自动附加模型名，不要把模型写进 worker 名。",
	"从 Tracker 首次派发前，把完整分波计划连同每张 Ticket 的模型/thinking（建议值取选型表）一次性列给用户确认；确认后各波自动执行不再重复询问，计划变更（如模型无额度）才重新征询。",
	"复杂工作先用当前已加载的 planning skill 拆分；subagents 不依赖任何具体 skill。start 的 prompt 必须自包含：任务、交付物、限制、验证要求（工人必须自跑受影响测试并附证据），以及最终回复必须包含的结论、证据和未决风险。",
	"仅当项目已有本次流程的 Tracker（本地 .scratch/ 或远端 issue tracker，约定见项目 docs/agents/issue-tracker.md）时才有票务纪律：按 Ticket 阻塞边分波、首批调查票全并行、一波集成验证后解锁下一波；阻塞边除显式依赖外还包括触及路径重叠——共享 checkout 上同文件并行编辑会在提交前就互毁，重叠的 Ticket 必须串行不同波或合并为一票（无 Tracker 的日常并行委派同理）；派发即认领（远端打标或留言），收口即删票/关票。没有 Tracker 就没有这些票务动作。",
	"轻重之分靠 start 的 review 参数：重要实现票设 review:true，完成后机器自动发起对抗审查并回传终态（含轮数与顾问裁决），无需你记得或手动触发；轻量票不设。委派文本用 `/skill:tdd ` 开头或普通自包含说明；`/skill:implement` 是用户 solo 技能（内含自审），Master 委派禁用。斜杠技能只在文本开头且后跟空格才展开，写错静默失效。",
	"审查自动修复循环内不调用 start/send，等待 review 终态；整体收口交给专门的收口工人，指挥官只派活、分析和决策，不直接改代码。",
	"审查提示词具备并行改动与测试干扰的归因纪律，发起审查无需等其它工人停笔；subagents 的 review action 可对任意 idle 工人手动补审（如轻量票事后需要把关）。",
	"工人结果会以 custom follow-up message 回来。收到后决定继续 send、stop 为可恢复的休眠工人（Dormant Worker），或 stop forget=true 删除引用。",
	"生命周期：一波集成过审后就 stop 该波工人（休眠保上下文，不占屏）；走 CI/合并的项目 push 后保持休眠，红了复活对应工人修，绿了再 forget；全流程结束用 /fire-master off 清场（退出会话也会自动清）。",
	"工人共享 checkout 且可能并行写入；需要额外限制（如禁改依赖）必须写进工作说明（Delegation）。工人在发起自审前用带路径提交固定只包含自己的改动（`git commit -m <msg> -- <自己的路径>`，带路径提交走临时索引，天然不携带他人已暂存内容；遇 index.lock 冲突稍候重试；禁止 push），修复回合同样收尾即提交；指挥官在集成点检查新增 commits、运行集成层验证后统一 push，再向用户报告完成。",
	];
}

function workerInstructions(name: string): string {
	return `<firecode_worker name="${name}">
你是指挥官（Master）委派的工人（Worker），不是指挥官，只完成收到的工作说明。
义务：改完必须自己跑受影响的测试/检查，最终回复交付结论、已运行的验证命令与结果证据、未决风险。
禁令（除非工作说明明确授权）：不碰 herdr 命令、不启动子 Agent、不 git push、不新增或升级依赖（跑现有依赖的测试不受限）、不写 checkout 之外的路径。
提交必须带路径：先 git add <你的路径>，再 git commit -m <msg> -- <你的路径>；带路径提交走临时索引，不会带上他人已暂存的内容；遇 index.lock 冲突稍候重试。
全部完成停下后，若本票被指定需要审查，指挥官会自动从外部对你的会话发起 /fire-review 对抗审查，审查反馈会自动驱动你修复；你自己无法也无需触发它。
</firecode_worker>`;
}

/** 扫描 Master 会话：pending 减 ack 的差集 = 尚未成功投递给模型的结果。 */
function unackedEvents(ctx: ExtensionContext): MasterEvent[] {
	const manager = ctx.sessionManager as { getEntries?: () => unknown[] } | undefined;
	const entries = manager?.getEntries?.() ?? [];
	const pending = new Map<string, string>();
	const acked = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || !record.data || typeof record.data !== "object") continue;
		const data = record.data as Record<string, unknown>;
		if (record.customType === PENDING_EVENT_TYPE) {
			if (typeof data.id === "string" && typeof data.content === "string") pending.set(data.id, data.content);
			continue;
		}
		if (record.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending].filter(([id]) => !acked.has(id)).map(([id, content]) => ({ id, content }));
}

function statusText(workers: WorkerRef[]): string {
	if (!workers.length) return "没有 Worker";
	return workers.map((worker) => `${worker.name} ${worker.status} ${worker.model}`).join(" · ");
}

function compactWorker(worker: WorkerRef): Record<string, unknown> {
	return {
		name: worker.name,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		...(worker.sessionPath ? { session: worker.sessionPath } : {}),
	};
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

async function outsideCheckoutReason(path: string, cwd: string): Promise<string | undefined> {
	const root = await realpath(cwd);
	const target = await canonicalWritePath(resolve(cwd, path));
	const local = relative(root, target);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
		? `工人只能修改当前 checkout：${path}`
		: undefined;
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
