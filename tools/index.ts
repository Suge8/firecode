/**
 * 接管默认 4 工具（read/bash/edit/write）的展示：组摘要/紧凑列表 + 单工具正文，保留耗时/大小列。
 *
 * 只包装默认激活的工具：原版 pi 的 registerTool 是注册即激活（会话构建与 reload
 * 固定 includeAllExtensionTools），给 grep/find/ls 挂渲染包装会把它们在所有会话
 * 强制打开——渲染接管不得改变工具集，因此那三个用宿主默认渲染。
 */
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	defineTool,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { watchBusy } from "../busy.js";
import { installGroupPatch } from "./grouping.js";
import { ToolLine, makeResultRenderer } from "./line.js";
import { toolTarget } from "./actions.js";
import { type Part, diffMeta } from "./parts.js";
import { msg } from "./messages.js";
import { ROUND_ENTRY, renderRound } from "./round.js";
import { clearDurations, executeTimed } from "./timing.js";
import { TurnClock } from "./turn-clock.js";

function createTools(cwd: string) {
	return { read: createReadTool(cwd), bash: createBashTool(cwd), edit: createEditTool(cwd), write: createWriteTool(cwd) };
}

/** 工具实例按 cwd 复用：同一会话内 cwd 不变，切目录也不必重建全部工具。 */
const cache = new Map<string, ReturnType<typeof createTools>>();

function tools(cwd: string) {
	let value = cache.get(cwd);
	if (!value) cache.set(cwd, value = createTools(cwd));
	return value;
}

function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/** 四个工具共有的展示壳：执行仍是宿主工具（按调用 cwd 取实例）外加真实耗时，调用行是动作词 + 目标；meta 给调用行追加后缀。 */
function shell(name: "read" | "bash" | "edit" | "write", meta?: (args: any) => Part[]) {
	return {
		label: msg.labels[name],
		renderShell: "self" as const,
		execute: (id: string, params: any, signal: any, update: any, ctx: any) =>
			executeTimed(id, () => (tools(ctx.cwd)[name].execute as (...args: unknown[]) => Promise<any>)(id, params, signal, update, ctx)),
		renderCall: (args: any, theme: Theme, ctx: any) =>
			new ToolLine({ label: msg.labels[name], ...toolTarget(name, args, ctx.cwd), meta: meta?.(args), theme, ctx }),
	};
}

const EDIT_RESULT = makeResultRenderer(false);
let definitions: ReturnType<typeof buildDefinitions> | undefined;

/** 默认四工具的展示包装：主会话注册它们，子代理全过程视图拿同一份定义渲染子会话的工具行。 */
export function toolDefinitions() {
	return definitions ??= buildDefinitions();
}

function buildDefinitions() {
	const initial = tools(process.cwd());
	return {
		read: defineTool({ ...initial.read, ...shell("read"), renderResult: makeResultRenderer(true) }),
		bash: defineTool({ ...initial.bash, ...shell("bash"), renderResult: makeResultRenderer(true) }),
		edit: defineTool({
			...initial.edit,
			...shell("edit"),
			renderResult(result, options, theme, ctx) {
				const details = result.details as { diff?: unknown } | undefined;
				const diff = !ctx.isError && typeof details?.diff === "string" ? details.diff : undefined;
				ctx.state.meta = diff ? diffMeta(diff) : undefined;
				const display = options.expanded && diff
					? { ...result, content: [...result.content, { type: "text" as const, text: diff }] }
					: result;
				return EDIT_RESULT(display, options, theme, ctx);
			},
		}),
		write: defineTool({
			...initial.write,
			...shell("write", (args) => [{ text: " +" + lineCount(args.content ?? ""), color: "toolDiffAdded" }]),
			renderResult: makeResultRenderer(false),
		}),
	};
}

export function registerToolRendering(pi: ExtensionAPI): void {
	let dispose: (() => void) | undefined;
	// 时钟只投影 busy.ts 的唯一状态机；拆会话会重载扩展，不跨会话复用。
	const clock = new TurnClock();
	// 轮记录由根级轮记录器写（每个会话都有）；这里只把它渲染成零行标记，供摘要行读。
	pi.registerEntryRenderer(ROUND_ENTRY, renderRound);
	watchBusy(pi, { onChange: (view) => clock.sync(view) });
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		dispose?.();
		clearDurations();
		dispose = installGroupPatch(ctx.ui, { clock });
		ctx.ui.setToolsExpanded(false);
	});
	pi.on("session_shutdown", () => {
		if (!dispose) return;
		dispose();
		dispose = undefined;
		clearDurations();
	});

	for (const definition of Object.values(toolDefinitions())) pi.registerTool(definition);

	pi.registerCommand("tool-status", {
		description: msg.toolStatusCommand,
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`active: ${pi.getActiveTools().join(", ")}\nall: ${pi
					.getAllTools()
					.map((tool) => tool.name)
					.join(", ")}`,
				"info",
			);
		},
	});
}
