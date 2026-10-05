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
} from "@earendil-works/pi-coding-agent";
import { watchBusy } from "../busy.js";
import { loadConfig } from "../config.js";
import { installGroupPatch } from "./grouping.js";
import { ToolLine, makeResultRenderer } from "./line.js";
import { LABEL, toolTarget } from "./actions.js";
import { diffMeta } from "./parts.js";
import { ROUND_ENTRY, renderRound, ROUND_RECORDED_CHANNEL } from "./round.js";
import { clearDurations, executeTimed } from "./timing.js";
import { TurnClock } from "./turn-clock.js";

type ToolMap = {
	read: ReturnType<typeof createReadTool>;
	bash: ReturnType<typeof createBashTool>;
	edit: ReturnType<typeof createEditTool>;
	write: ReturnType<typeof createWriteTool>;
};

const cache = new Map<string, ToolMap>();

function createTools(cwd: string): ToolMap {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};
}

/** 工具实例按 cwd 复用：同一会话内 cwd 不变，切目录也不必重建全部工具。 */
function tools(cwd: string): ToolMap {
	let value = cache.get(cwd);
	if (!value) {
		value = createTools(cwd);
		cache.set(cwd, value);
	}
	return value;
}

function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function invoke<T extends (...args: never[]) => unknown>(
	execute: T,
	args: unknown[],
): ReturnType<T> {
	return Reflect.apply(execute, undefined, args) as ReturnType<T>;
}

const EDIT_RESULT = makeResultRenderer(false);
let definitions: ReturnType<typeof buildDefinitions> | undefined;

/**
 * 默认四工具的展示包装（执行仍是宿主工具，按调用 cwd 取实例）：主会话注册它们，子代理全过程视图拿同一份定义渲染子会话的工具行。
 */
export function toolDefinitions() {
	return definitions ??= buildDefinitions();
}

function buildDefinitions() {
	const initial = tools(process.cwd());
	return {
		read: defineTool({
			...initial.read,
			label: LABEL.read,
			renderShell: "self",
			execute: (id, params, signal, update, ctx) =>
				executeTimed(id, () => invoke(tools(ctx.cwd).read.execute, [id, params, signal, update, ctx])),
			renderCall: (args, theme, ctx) =>
				new ToolLine({
					label: LABEL.read,
					...toolTarget("read", args, ctx.cwd),
					theme,
					ctx,
				}),
			renderResult: makeResultRenderer(true),
		}),
		bash: defineTool({
			...initial.bash,
			label: LABEL.bash,
			renderShell: "self",
			execute: (id, params, signal, update, ctx) =>
				executeTimed(id, () => invoke(tools(ctx.cwd).bash.execute, [id, params, signal, update, ctx])),
			renderCall: (args, theme, ctx) =>
				new ToolLine({
					label: LABEL.bash,
					...toolTarget("bash", args, ctx.cwd),
					theme,
					ctx,
				}),
			renderResult: makeResultRenderer(true),
		}),
		edit: defineTool({
			...initial.edit,
			label: LABEL.edit,
			renderShell: "self",
			execute: (id, params, signal, update, ctx) =>
				executeTimed(id, () => invoke(tools(ctx.cwd).edit.execute, [id, params, signal, update, ctx])),
			renderCall: (args, theme, ctx) =>
				new ToolLine({
					label: LABEL.edit,
					...toolTarget("edit", args, ctx.cwd),
					theme,
					ctx,
				}),
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
			label: LABEL.write,
			renderShell: "self",
			execute: (id, params, signal, update, ctx) =>
				executeTimed(id, () => invoke(tools(ctx.cwd).write.execute, [id, params, signal, update, ctx])),
			renderCall: (args, theme, ctx) =>
				new ToolLine({
					label: LABEL.write,
					...toolTarget("write", args, ctx.cwd),
					meta: [{ text: ` +${lineCount(args.content ?? "")}`, color: "toolDiffAdded" }],
					theme,
					ctx,
				}),
			renderResult: makeResultRenderer(false),
		}),
	};
}

export function registerToolRendering(pi: ExtensionAPI): void {
	let dispose: (() => void) | undefined;
	// 时钟只投影 busy.ts 的唯一状态机；拆会话会重载扩展，不跨会话复用。
	const clock = new TurnClock();
	pi.registerEntryRenderer(ROUND_ENTRY, renderRound);
	watchBusy(pi, {
		onChange: (view) => clock.sync(view),
		// 轮记录只属于装了分组投影的 TUI 主会话；写成会话记录，摘要行落定时读它，写入后发布给输入框外壳。
		onSettled: (_ctx, round) => {
			if (!dispose) return;
			pi.appendEntry(ROUND_ENTRY, round);
			pi.events.emit(ROUND_RECORDED_CHANNEL, undefined);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		dispose?.();
		clearDurations();
		dispose = installGroupPatch(ctx.ui, { replyLines: loadConfig().config.tools.replyLines, clock });
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
		description: "显示当前已加载/启用工具",
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
