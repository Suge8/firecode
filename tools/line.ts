/** 单条工具行的渲染：状态字形 + 标签 + 主体 + 右侧耗时/大小，展开时附完整结果。 */
import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ClipSide, clip, oneLine } from "../format.js";
import {
	type Part,
	clipParts,
	durationPart,
	paint,
	partsWidth,
	sizePart,
} from "./parts.js";
import { takeDuration } from "./timing.js";

export const RAIL = "▏ ";
/** 右侧列与主体之间至少留出的空隙，不够就先丢弃右侧列 */
const RIGHT_GAP = 2;
const MIN_VALUE_WIDTH = 8;
/** 有错误摘要时，主体最多占可用宽度的比例 */
const ERROR_VALUE_RATIO = 0.4;

const STATUS = {
	run: { glyph: "●", color: "accent", bg: "toolPendingBg" },
	ok: { glyph: "✓", color: "success", bg: "toolSuccessBg" },
	err: { glyph: "✗", color: "error", bg: "toolErrorBg" },
} as const satisfies Record<string, Status>;
/** 过程摘要运行中的字形；摘要不铺工具背景色，与工具行区分。 */
const SUMMARY_GLYPH = "✦";

type Status = { glyph: string; color: ThemeColor; bg?: ThemeBg };
type ThemeBg = Parameters<Theme["bg"]>[0];

/** renderCall / renderResult 之间共享的行状态。 */
export type RowState = {
	/** 结果字符数（read/bash），驱动右对齐大小列 */
	chars?: number;
	durationMs?: number;
	/** 结果产生的动态后缀（edit 的 ±diff） */
	meta?: Part[];
	/** 失败时的一行摘要 */
	errorText?: string;
};

export type RenderContext = {
	state: RowState;
	cwd: string;
	toolCallId: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
};

type ResultContent = { type: string; text?: string };
export type ToolResult = { content?: ResultContent[]; details?: unknown };

export type ToolLineOptions = {
	label: string;
	value: Part[];
	/** 溢出时从哪端截断：路径保尾部，命令保头部 */
	clip: ClipSide;
	/** 紧跟 value 的左侧后缀（edit ±diff、write +N） */
	meta?: Part[];
	theme: Theme;
	ctx: RenderContext;
};

function sanitizeDisplayText(text: string): string {
	let output = "";
	for (const char of stripVTControlCharacters(text)) {
		const code = char.codePointAt(0);
		if (code === undefined || code === 0x0d) continue;
		if (code === 0x09 || code === 0x0a) output += char;
		else if (code > 0x1f && (code < 0xfff9 || code > 0xfffb)) output += char;
	}
	return output;
}

export function resultText(result: ToolResult, includeText: boolean): { displayText: string; chars: number } {
	const blocks: string[] = [];
	let chars = 0;
	for (const item of result.content ?? []) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		if (includeText) blocks.push(sanitizeDisplayText(item.text));
		chars += item.text.length;
	}
	return { displayText: blocks.join("\n"), chars };
}

/** 右侧列之间用 " · " 分隔。 */
function rightContentWidth(parts: Part[]): number {
	return partsWidth(parts) + Math.max(0, parts.length - 1) * 3;
}

const EMPTY_RESULT: Component = { render: () => [], invalidate() {} };

class ExpandedResult implements Component {
	constructor(
		private readonly text: string,
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = wrapTextWithAnsi(this.text, Math.max(1, width));
		return ["", ...lines.map((line) => this.theme.fg("toolOutput", line))];
	}
}

export function paintBgLine(line: string, width: number, bgFn?: (text: string) => string): string {
	const visLen = visibleWidth(line);
	const padNeeded = Math.max(0, width - visLen);
	const padded = line + " ".repeat(padNeeded);
	return bgFn ? bgFn(padded) : padded;
}

export interface GroupSummary {
	/** 按工具标签的调用计数，首次出现顺序 */
	counts: readonly (readonly [label: string, calls: number])[];
	running: number;
	failures: number;
	/** 折入段内的宿主提示条数（缓存、丢思考、压缩计费） */
	notices: number;
	activity?: string;
}

export interface GroupRenderer extends Component {
	renderGroup(width: number, summary: GroupSummary): string[];
}

export class ToolLine implements GroupRenderer {
	constructor(private readonly options: ToolLineOptions) {}
	invalidate(): void {}

	render(width: number): string[] {
		const { theme, ctx, meta } = this.options;
		const state = ctx.state;
		const status = ctx.isError ? STATUS.err : ctx.isPartial ? STATUS.run : STATUS.ok;
		const value = this.valueWithMeta();
		return renderLine(theme, width, {
			status,
			label: { text: this.options.label, color: ctx.isError ? "error" : "toolTitle", bold: true },
			value: ctx.isError ? value.map((part) => ({ ...part, color: "error" as const })) : value,
			clip: this.options.clip,
			error: ctx.isError && !ctx.expanded ? oneLine(state.errorText ?? "") : "",
			right: [durationPart(state.durationMs), sizePart(state.chars)].filter((part): part is Part => !!part),
		});
	}

	/** 保留当前动作与目标；整段的统计走固定标记与右列，不冒充单工具耗时与大小。 */
	renderGroup(width: number, summary: GroupSummary): string[] {
		const { activity, counts, running, failures, notices } = summary;
		const kind = running || activity ? "run" : failures ? "err" : "ok";
		return renderLine(this.options.theme, width, {
			status: kind === "run" ? { glyph: SUMMARY_GLYPH, color: "accent" } : { ...STATUS[kind], bg: undefined },
			label: { text: activity ?? this.options.label, color: "toolTitle", bold: true },
			value: activity ? [] : this.valueWithMeta(),
			clip: this.options.clip,
			tail: [
				...(failures ? [{ text: ` · ${failures} 次失败`, color: "error" as const }] : []),
				...(notices ? [{ text: ` · ⚠ ${notices}`, color: "warning" as const }] : []),
			],
			// 计数列整体去留：只显示一部分类别会误导
			right: counts.length ? [{ text: counts.map(([label, calls]) => `${label} ${calls}`).join(" · "), color: "dim" }] : [],
		});
	}

	private valueWithMeta(): Part[] {
		const { value, meta, ctx } = this.options;
		return [...value, ...(meta ?? []), ...(ctx.state.meta ?? [])];
	}
}

/** 一行的布局：头与尾固定，值可裁，错误摘要与值分摊，右列空间不足时先整列丢弃。 */
type LineSpec = {
	status: Status;
	label: Part;
	value: Part[];
	clip: ClipSide;
	error?: string;
	tail?: Part[];
	right: Part[];
};

function renderLine(theme: Theme, width: number, spec: LineSpec): string[] {
	const { status, tail = [] } = spec;
	const safeWidth = Math.max(1, width - 2);
	const head: Part[] = [
		{ text: RAIL, color: "dim" },
		{ text: `${status.glyph} `, color: status.color, bold: true },
		spec.label,
		...(spec.value.length ? [{ text: " " }] : []),
	];
	const fixedWidth = partsWidth(head) + partsWidth(tail);
	const bg = status.bg;
	const bgFn = bg && typeof theme.bg === "function" ? (text: string) => theme.bg(bg, text) : undefined;
	if (safeWidth <= fixedWidth) {
		const clipped = paint(theme, clipParts([...head, ...tail], safeWidth, "end"));
		return [paintBgLine(clipped, width, bgFn)];
	}

	const right = [...spec.right];
	while (right.length && safeWidth - fixedWidth - rightContentWidth(right) - RIGHT_GAP < MIN_VALUE_WIDTH)
		right.pop();
	const rightVisible = rightContentWidth(right);
	const freeWidth = safeWidth - fixedWidth - (right.length ? rightVisible + RIGHT_GAP : 0);
	let value = spec.value;
	let errorPart: Part | undefined;
	if (spec.error) {
		value = clipParts(value, Math.max(1, Math.floor(freeWidth * ERROR_VALUE_RATIO)), spec.clip);
		const errorWidth = freeWidth - partsWidth(value) - 3;
		if (errorWidth >= 1)
			errorPart = { text: ` · ${clip(spec.error, errorWidth, "end")}`, color: "error" };
	} else {
		value = clipParts(value, freeWidth, spec.clip);
	}

	const body = [...head, ...value, ...(errorPart ? [errorPart] : []), ...tail];
	let line = paint(theme, body);
	if (right.length) {
		const pad = Math.max(RIGHT_GAP, safeWidth - partsWidth(body) - rightVisible);
		line += " ".repeat(pad) + right.map((part) => paint(theme, [part])).join(theme.fg("dim", " · "));
	}
	return [paintBgLine(line, width, bgFn)];
}

/** 折叠时只回写行状态；展开时输出完整结果。 */
export function makeResultRenderer(sized: boolean) {
	return (
		result: ToolResult,
		options: { expanded: boolean },
		theme: Theme,
		context: RenderContext,
	): Component => {
		const state = context.state;
		const { displayText, chars } = resultText(result, options.expanded || context.isError);
		if (sized) state.chars = chars;
		const durationMs = takeDuration(context.toolCallId);
		if (durationMs !== undefined) state.durationMs = durationMs;
		state.errorText = context.isError ? displayText : "";
		return options.expanded && displayText !== ""
			? new ExpandedResult(displayText, theme)
			: EMPTY_RESULT;
	};
}
