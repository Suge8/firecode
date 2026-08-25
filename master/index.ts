import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	isToolCallEventType,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type MasterModel } from "../config.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { MASTER_EVENT_TYPE, masterEventDetails } from "./event-format.js";
import { InProcessSessionPool, preallocateWorkerSession } from "./spawn.js";
import {
	MasterStore,
	THINKING_LEVELS,
	loadMasterState,
	masterStatePath,
	requireWorker,
	type MasterState,
	type WorkerRef,
	type WorkerStatus,
} from "./state.js";

const MASTER_TOOL = "subagents";
const WORKER_TOOLS = ["read", "bash", "edit", "write"];

interface MasterDependencies {
	resolveModel?: (id: string) => Promise<Model<any>>;
	pool?: InProcessSessionPool;
}

interface MasterRuntime {
	ctx: ExtensionContext;
	store: MasterStore;
	pool: InProcessSessionPool;
}

export function registerMaster(pi: ExtensionAPI, dependencies: MasterDependencies = {}): void {
	let runtime: MasterRuntime | undefined;
	const loaded = loadMasterConfiguration();
	const roster = "error" in loaded ? [] : loaded.models;
	const exclusions = "error" in loaded ? [] : loaded.workerExcludeExtensions;
	const pool = dependencies.pool ?? new InProcessSessionPool();
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => name !== MASTER_TOOL);
		pi.setActiveTools(active ? [...tools, MASTER_TOOL] : tools);
	};
	const renderStatus = () => {
		if (!runtime) return;
		runtime.ctx.ui.setStatus("master", masterStatusLine(runtime.store.state.workers, runtime.ctx.ui.theme));
	};
	const activate = (ctx: ExtensionContext, restored?: MasterState): MasterRuntime => {
		if ("error" in loaded) throw new Error(loaded.error);
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		const store = new MasterStore(masterStatePath(ctx.sessionManager.getSessionId()), restored, renderStatus);
		runtime = { ctx, store, pool };
		setTools(true);
		if (store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(`旧版 v${store.discardedLegacyVersion} 子代理池已丢弃并从空池重建；原有子代理已脱管，请手动清理`, "warning");
		renderStatus();
		return runtime;
	};
	const deactivate = () => {
		const active = runtime;
		runtime = undefined;
		pool.disposeAll();
		active?.ctx.ui.setStatus("master", undefined);
		setTools(false);
	};

	pi.registerCommand("fire-master", {
		description: "启动指挥官模式（子代理池）：/fire-master [status|off]",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				ctx.ui.notify(runtime ? statusText(runtime.store.state.workers) : "指挥官模式未启动", "info");
				return;
			}
			if (input === "off") {
				deactivate();
				ctx.ui.notify("指挥官模式已关闭", "info");
				return;
			}
			if (input) {
				ctx.ui.notify("/fire-master 只接受 status 或 off；启用后直接描述需求", "error");
				return;
			}
			try {
				activate(ctx);
				ctx.ui.notify("指挥官模式已启动", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: MASTER_TOOL,
		label: "子代理",
		description: "指挥官的子代理接口。T2 只实现 start、list、kill；其余动作将在 T3 实现。",
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts(args as Record<string, unknown>), clip: "end", theme, ctx }),
		renderResult: (result, options, theme, context) => {
			const details = result.details as { workers?: unknown } | undefined;
			context.state.meta = !context.isError && Array.isArray(details?.workers) ? listMeta(details.workers) : undefined;
			return renderSubagentsResult(result, options, theme, context);
		},
		promptGuidelines: masterGuidelines(roster),
		parameters: Type.Object({
			action: StringEnum(["list", "start", "send", "interrupt", "review", "tail", "ack", "kill"] as const),
			worker: Type.Optional(Type.String()),
			prompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
			cwd: Type.Optional(Type.String()),
			review: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (!active) throw new Error("subagents 只在 Master 中可用");
			if (params.action === "list") return toolResult({ workers: active.store.state.workers.map(compactWorker) });
			if (params.action === "kill") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				active.pool.dispose(target.sessionPath);
				active.store.dispatch({ type: "REMOVE_WORKER", name: target.name });
				return toolResult({ killed: true });
			}
			if (params.action !== "start") throw new Error(`T3 未实现：${String(params.action)}`);
			const name = requiredString(params.worker, "worker");
			validateWorkerName(name);
			if (active.store.state.workers.some((worker) => worker.name === name)) throw new Error(`子代理已存在：${name}`);
			const prompt = requiredString(params.prompt, "prompt");
			validateDelegationText(prompt);
			const selection = resolveSelection(roster, params);
			const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
			const mainSessionPath = ctx.sessionManager.getSessionFile?.();
			if (!mainSessionPath) throw new Error("主会话尚未落盘，无法创建子代理会话目录");
			const sessionPath = preallocateWorkerSession(mainSessionPath, cwd);
			const worker: WorkerRef = {
				name,
				model: selection.model,
				thinking: selection.thinking,
				status: "working",
				sessionPath,
				cwd,
				...(params.review === true ? { reviewNeeded: true } : {}),
			};
			active.store.dispatch({ type: "UPSERT_WORKER", worker });
			let spawned;
			try {
				const model = await (dependencies.resolveModel ?? resolveConfiguredModel)(selection.model);
				spawned = await active.pool.spawn({
					cwd,
					model,
					thinking: selection.thinking,
					tools: WORKER_TOOLS,
					excludeExtensions: exclusions,
					systemPrompt: { mode: "append", text: workerInstructions(name) },
					contextFiles: true,
					persistence: { type: "file", sessionPath },
				});
			} catch (error) {
				active.store.dispatch({ type: "REMOVE_WORKER", name });
				throw error;
			}
			void spawned.prompt(prompt).then(
				() => settleWorker(active, worker, spawned.session.messages, pi),
				(error) => settleWorker(active, worker, spawned.session.messages, pi, error),
			);
			return toolResult({ started: true, worker: compactWorker(worker) });
		},
	});

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		try {
			const path = masterStatePath(ctx.sessionManager.getSessionId());
			let restored: MasterState | undefined;
			try {
				restored = loadMasterState(path);
			} catch {
				// MasterStore 是旧版状态的唯一所有者，激活时由它丢弃并保留告知依据。
				activate(ctx);
				return;
			}
			if (restored?.workers.length) activate(ctx, restored);
		} catch (error) {
			ctx.ui.notify(`指挥官模式恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!process.env.FIRECODE_MASTER_WORKER) return;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
		if (reason) return { block: true, reason };
	});
	pi.on("session_shutdown", () => deactivate());
}

async function settleWorker(
	active: MasterRuntime,
	identity: WorkerRef,
	messages: Array<{ role: string; content?: unknown }>,
	pi: ExtensionAPI,
	error?: unknown,
): Promise<void> {
	const current = active.store.state.workers.find((worker) => worker.name === identity.name);
	if (!current || current.sessionPath !== identity.sessionPath) return;
	active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
	const content = error
		? `子代理 ${identity.name} 已停下\n错误：${error instanceof Error ? error.message : String(error)}`
		: `子代理 ${identity.name} 已停下\n回复：\n${latestAssistantText(messages) || "（无回复）"}`;
	pi.sendMessage(
		{ customType: MASTER_EVENT_TYPE, content, display: true, details: masterEventDetails([content]) },
		{ deliverAs: "steer", triggerTurn: false },
	);
}

function latestAssistantText(messages: Array<{ role: string; content?: unknown }>): string {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function resolveConfiguredModel(id: string): Promise<Model<any>> {
	const runtime = await ModelRuntime.create({
		authPath: `${getAgentDir()}/auth.json`,
		modelsPath: `${getAgentDir()}/models.json`,
	});
	const slash = id.indexOf("/");
	const model = slash > 0 ? runtime.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`找不到模型：${id}`);
	return model;
}

function loadMasterConfiguration() {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = loaded.problems.filter((problem) => problem.startsWith("master") || problem.startsWith("未知字段 master.") || problem.startsWith("config.jsonc") || problem.startsWith("features"));
	if (problems.length) return { error: `Master 配置有问题，已停止：${problems.join("；")}` };
	if (!loaded.config.master.models.length) return { error: "Master 配置有问题，已停止：请显式配置 master.models 选型表" };
	return loaded.config.master;
}

function resolveSelection(models: MasterModel[], params: Record<string, unknown>) {
	const model = optionalString(params.model);
	const entry = models.find((candidate) => candidate.model === model);
	if (!entry) throw new Error(model ? `model 不在选型表：${model}` : "start 必须显式指定 model");
	const thinking = optionalString(params.thinking);
	if (!thinking) throw new Error(`start 必须显式指定 thinking：${entry.model} 默认档是 ${entry.thinking}`);
	if (!THINKING_LEVELS.includes(thinking as WorkerRef["thinking"])) throw new Error(`thinking 值无效：${thinking}`);
	return { model: entry.model, thinking: thinking as WorkerRef["thinking"] };
}

function masterGuidelines(models: MasterModel[]): string[] {
	return [
		"subagents 激活时，你是唯一的指挥官（Master），负责委派与最终验收。",
		`选型表：${models.map((entry) => `${entry.model}（${entry.use}，thinking ${entry.thinking}）`).join("；")}。start 必须显式传 model 与 thinking。`,
		"T2 仅可使用 start、list、kill；send、interrupt、review、tail、ack 将在 T3 实现。",
	];
}

function workerInstructions(name: string): string {
	return `<firecode_worker name="${name}">\n你是指挥官委派的子代理，只完成工作说明。必须自测并报告证据；禁止 herdr、子 Agent、git push、新增依赖和写 checkout 外路径。提交只带自己改动的路径。\n</firecode_worker>`;
}

const ACTION_VERB: Record<string, string> = { start: "启动", list: "查看", kill: "移除", send: "发送", interrupt: "中断", review: "审查", tail: "近况", ack: "待命" };
function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const parts: Part[] = [{ text: ACTION_VERB[action] ?? action, bold: true }];
	const target = optionalString(args.worker);
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	const model = optionalString(args.model);
	if (action === "start" && model) parts.push({ text: ` · ${model.split("/").pop()}`, color: "muted" });
	const prompt = optionalString(args.prompt)?.split("\n", 1)[0];
	if (prompt && action === "start") parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

const renderSubagentsResult = makeResultRenderer(false);
const STATUS_WORD = { working: "工作", idle: "空闲", reviewing: "审查" } satisfies Record<WorkerStatus, string>;
function listMeta(workers: unknown[]): Part[] {
	if (!workers.length) return [{ text: " — 空", color: "muted" }];
	return [{ text: ` — ${workers.map((value) => {
		const worker = value as Record<string, unknown>;
		return `${String(worker.name)} ${STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status)}`;
	}).join(" · ")}`, color: "muted" }];
}
function masterStatusLine(workers: WorkerRef[], theme: ExtensionContext["ui"]["theme"]): string {
	const count = (status: WorkerStatus) => workers.filter((worker) => worker.status === status).length;
	return `${theme.fg("dim", "👑 指挥官")}${count("working") ? theme.fg("dim", `/工作${count("working")}`) : ""}${count("reviewing") ? theme.fg("dim", `/审${count("reviewing")}`) : ""}${count("idle") ? theme.fg("dim", `/闲${count("idle")}`) : ""}`;
}
function statusText(workers: WorkerRef[]): string {
	return workers.length ? workers.map((worker) => `${worker.name} ${worker.status} ${worker.model}`).join(" · ") : "没有子代理";
}
function compactWorker(worker: WorkerRef) {
	return { name: worker.name, status: worker.status, model: worker.model, thinking: worker.thinking, session: worker.sessionPath };
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
