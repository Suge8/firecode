/**
 * 接管默认工具（read/bash/edit/write/grep/find/ls）的展示：组摘要/紧凑列表 + 单工具正文，保留耗时/大小列。
 *
 * 只经宿主的 registerToolRenderer 接管渲染，不重新注册工具：工具定义、系统提示条目与准则、
 * shellPath/shellCommandPrefix/图片缩放等设置全部仍由宿主自己的定义负责，也不改变启用的工具集。
 */
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { busyView } from "../busy.js";
import { installGroupPatch } from "./grouping.js";
import { ToolLine, makeResultRenderer } from "./line.js";
import { toolTarget } from "./actions.js";
import { type Part, diffMeta } from "./parts.js";
import { msg } from "./messages.js";
import { ROUND_ENTRY } from "../round.js";
import { renderRound } from "./round.js";

type Name = keyof typeof msg.labels;

function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/** 七个工具共有的展示壳：调用行是动作词 + 目标，meta 给调用行追加后缀。 */
function renderers(name: Name, renderResult: ToolRenderers["renderResult"], meta?: (args: any) => Part[]): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: msg.labels[name], ...toolTarget(name, args, ctx.cwd), meta: meta?.(args), theme, ctx }),
		renderResult,
	};
}

const SIZED = makeResultRenderer(true);
const PLAIN = makeResultRenderer(false);

/** edit 的结果渲染把 diff 的 ± 统计回写到调用行，展开时附 diff。 */
const EDIT: ToolRenderers["renderResult"] = (result, options, theme, ctx) => {
	const details = result.details as { diff?: unknown } | undefined;
	const diff = !ctx.isError && typeof details?.diff === "string" ? details.diff : undefined;
	ctx.state.meta = diff ? diffMeta(diff) : undefined;
	const display = options.expanded && diff
		? { ...result, content: [...result.content, { type: "text" as const, text: diff }] }
		: result;
	return PLAIN(display, options, theme, ctx);
};

const RENDERERS: Record<Name, ToolRenderers> = {
	read: renderers("read", SIZED),
	bash: renderers("bash", SIZED),
	edit: renderers("edit", EDIT),
	write: renderers("write", PLAIN, (args) => [{ text: " +" + lineCount(args.content ?? ""), color: "toolDiffAdded" }]),
	grep: renderers("grep", SIZED),
	find: renderers("find", SIZED),
	ls: renderers("ls", SIZED),
};

/** 默认工具的渲染器，按工具名取：主会话经宿主解析器使用，子代理全过程视图拿同一份渲染子会话的工具行。 */
export function toolRenderers(tool: string): ToolRenderers | undefined {
	return Object.hasOwn(RENDERERS, tool) ? RENDERERS[tool as Name] : undefined;
}

export function registerToolRendering(pi: ExtensionAPI): void {
	let dispose: (() => void) | undefined;
	// 轮记录由根级轮记录器写（每个会话都有）；这里只把它渲染成零行标记，供摘要行读。
	pi.registerEntryRenderer(ROUND_ENTRY, renderRound);
	pi.registerToolRenderer((tool, next) => toolRenderers(tool) ?? next());
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		dispose?.();
		dispose = installGroupPatch(ctx.ui, { busy: () => busyView(pi) });
		ctx.ui.setToolsExpanded(false);
	});
	pi.on("session_shutdown", () => {
		dispose?.();
		dispose = undefined;
	});
}
