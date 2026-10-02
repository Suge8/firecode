import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { HEAT_COLORS, paint, settling } from "../flame.js";
import { firstSentence } from "./machine.js";
import { ToolLine, resultText, type ActionLine, type RowState, type ToolResult } from "./line.js";
import { genericArgsParts } from "./parts.js";
import { assistantView, hasThinking, replyText, type AssistantActivity } from "./assistant-view.js";
import { MachineRow, machineEntries, type MachineEntry } from "./machine.js";
import { ARRIVAL_FLASH_MS, type TurnClock } from "./turn-clock.js";
import { Line, TurnSummary, type SummaryView } from "./turn-summary.js";

/** 宿主工具行内部字段只在工具分组接缝读取，结果与单工具展开仍归宿主所有。 */
export type ToolRow = ToolExecutionComponent;
type RowData = {
	toolName: string;
	toolCallId: string;
	args: unknown;
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	rendererState: RowState;
	toolDefinition?: { label?: string };
	callRendererComponent?: Component;
	resultRendererComponent?: Component;
	result?: ToolResult & { isError: boolean };
};
const rowData = (row: ToolRow): RowData => row as unknown as RowData;

function actionLine(component: Component | undefined): ActionLine | undefined {
	return component && "actionWord" in component && typeof component.actionWord === "string"
		? component as ActionLine : undefined;
}

/** 机器消息：整条文本由信封构成，来自 CustomMessage 或空闲时投递的用户消息。 */
function machineEntriesOf(component: Component): MachineEntry[] | undefined {
	if (component instanceof CustomMessageComponent) {
		const content = (component as unknown as { message: { content: unknown } }).message.content;
		return machineEntries(typeof content === "string" ? content : contentText(content));
	}
	if (component instanceof UserMessageComponent) return machineEntries((component as unknown as { text: string }).text);
	return undefined;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (part?.type === "text" ? [String(part.text)] : [])).join("\n");
}

/** 只有人类用户消息是轮次边界。 */
function isHuman(component: Component): boolean {
	return component instanceof UserMessageComponent && !machineEntriesOf(component);
}

/** 过程 = 模型的输出、动作与收件（含机器消息）；其余节点（错误、CustomEntry 等）是段边界。 */
function isProcess(component: Component): boolean {
	return component instanceof ToolExecutionComponent
		|| component instanceof AssistantMessageComponent
		|| component instanceof CustomMessageComponent
		|| (component instanceof UserMessageComponent && !isHuman(component));
}

/** 有实质的过程（工具或思考）才有摘要行；提示只折入有摘要行的段。 */
function hasSubstance(component: Component): boolean {
	return component instanceof ToolExecutionComponent
		|| (component instanceof AssistantMessageComponent && hasThinking(component));
}

/**
 * 宿主把 transcript 提示（缓存/丢思考/压缩计费）与状态行（切档、切模型）画成整行单色 Text：
 * warning 是提示，dim 是状态。颜色是宿主唯一给出的语义通道；错误与混色文本仍是边界。
 */
function noticeKind(component: Component | undefined, theme: Theme): "warning" | "dim" | undefined {
	if (!(component instanceof Text)) return;
	const text = (component as unknown as { text: string }).text;
	const plain = stripVTControlCharacters(text);
	return (["warning", "dim"] as const).find((color) => theme.fg(color, plain) === text);
}

function compactLine(row: RowData | undefined, theme: Theme): ToolLine {
	return new ToolLine({
		label: row ? row.toolDefinition?.label ?? row.toolName : "思考", value: genericArgsParts(row?.args), clip: "end", theme,
		ctx: {
			state: { ...row?.rendererState, errorText: row?.result?.isError ? resultText(row.result, true).displayText : "" },
			cwd: row?.cwd ?? "", toolCallId: row?.toolCallId ?? "",
			isPartial: row?.isPartial ?? false, isError: row?.result?.isError ?? false, expanded: false,
		},
	});
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
/** 摘要计数的类别；固定四类在前，其余工具按各自标签。 */
const FIXED_CATEGORIES = ["读", "改", "运行", "子代理"];

function categoryOf(data: RowData): string {
	if (READ_TOOLS.has(data.toolName)) return "读";
	if (EDIT_TOOLS.has(data.toolName)) return "改";
	if (data.toolName === "bash") return "运行";
	if (data.toolName.startsWith("subagents")) return "子代理";
	return data.toolDefinition?.label ?? data.toolName;
}

const ACTIVITY_TEXT = { thinking: "思考中", processing: "处理中" } as const;

type Facts = Pick<SummaryView, "tally" | "failures" | "notices" | "action" | "arrival"> & { running: number };

/** 一遍扫描段内过程，汇出摘要行需要的全部事实。 */
function scan(segment: readonly Component[], activity: AssistantActivity | undefined, env: ProjectionEnv): Facts {
	const counts = new Map<string, number>();
	let running = 0;
	let failures = 0;
	let notices = 0;
	let latest: RowData | undefined;
	let arrival: Facts["arrival"];
	for (const item of segment) {
		if (noticeKind(item, env.ui.theme) === "warning") notices++;
		const entries = machineEntriesOf(item);
		const returned = entries?.findLast((entry) => entry.returned)?.returned;
		const age = entries ? env.clock.arrivalAge(item) : Infinity;
		if (returned && age < ARRIVAL_FLASH_MS)
			arrival = { text: `${returned.name} ${returned.failed ? "失败" : "已返回"}`, failed: returned.failed, age };
		if (!(item instanceof ToolExecutionComponent)) continue;
		const data = rowData(item);
		const category = categoryOf(data);
		counts.set(category, (counts.get(category) ?? 0) + 1);
		// 运行中的工具优先当“当前动作”；都完成时取最后一个
		if (data.isPartial) running++;
		if (data.isPartial || !latest?.isPartial) latest = data;
		if (data.result?.isError) failures++;
	}
	const rank = (label: string) => (FIXED_CATEGORIES.includes(label) ? FIXED_CATEGORIES.indexOf(label) : FIXED_CATEGORIES.length);
	const tally = [...counts].sort((a, b) => rank(a[0]) - rank(b[0])).map(([label, calls]) => `${label} ${calls}`);
	const thought = segment.some((item) => item instanceof AssistantMessageComponent && hasThinking(item));
	const word = latest && (actionLine(latest.callRendererComponent)?.actionWord ?? latest.toolDefinition?.label ?? latest.toolName);
	return {
		tally: tally.length || !thought || activity ? tally : ["思考"],
		failures, notices, running, arrival,
		action: activity ? ACTIVITY_TEXT[activity] : word ?? "思考",
	};
}

class ToolItem implements Component {
	private leadingRows = 0;
	constructor(
		private readonly row: ToolRow,
		private readonly ui: ExtensionUIContext,
		private readonly toggle: (row: ToolRow) => void,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const data = rowData(this.row);
		if (!data.expanded) {
			const renderer = actionLine(data.callRendererComponent) ?? compactLine(data, this.ui.theme);
			return renderer.render(width);
		}
		const lines = this.row.render(width);
		this.leadingRows = lines[0] === "" ? 1 : 0;
		return lines.slice(this.leadingRows);
	}
	handleMouse(event: TuiMouseEvent) {
		if (rowData(this.row).expanded)
			return this.row.handleMouse({ ...event, y: event.y + this.leadingRows, height: event.height + this.leadingRows });
		if (event.type !== "click" || event.button !== "left" || !rowData(this.row).result) return undefined;
		this.toggle(this.row);
		return { handled: true };
	}
}

/** 人类输入：左侧橙色竖条，正文复用宿主用户消息。 */
class UserBar implements Component {
	constructor(private readonly message: Component) {}
	invalidate(): void {
		this.message.invalidate();
	}
	render(width: number): string[] {
		if (width <= 2) return this.message.render(width);
		const bar = paint(HEAT_COLORS.orange, "▌");
		const lines = this.message.render(width - 1);
		// 宿主上下各留一行背景内边距；竖条只贴正文行，段落间空行仍连续。
		const padding = (index: number) => (index === 0 || index === lines.length - 1)
			&& !stripVTControlCharacters(lines[index]).trim();
		return lines.map((line, index) => (padding(index) ? " " : bar) + line);
	}
}

export interface ProjectionEnv {
	ui: ExtensionUIContext;
	clock: TurnClock;
	/** 折叠态每轮最多显示几条中间回复首句。 */
	replyLines: number;
	toggleRow: (row: ToolRow) => void;
	/** 单轮展开状态以该轮的人类用户消息为键。 */
	isOpen: (turn: object) => boolean;
	toggleTurn: (turn: object) => void;
	/** 第一条人类输入之前的过程所属的轮次键。 */
	headless: object;
}

export interface Projection {
	nodes: Component[];
	/** 有活的摘要或落定过渡在播放，宿主需要按帧重绘。 */
	animating: boolean;
}

/** 从宿主组件顺序投影，既不搬走原组件，也不另存工具调用或展开档位。 */
export function projectProcessGroups(children: readonly Component[], env: ProjectionEnv): Projection {
	const nodes: Component[] = [];
	let animating = false;
	let turn = env.headless;
	let segment: Component[] = [];
	env.clock.track(children.findLast(isHuman) ?? env.headless);
	const flush = (final: boolean) => {
		if (!segment.length) return;
		const view = renderSegment(segment, turn, final, env);
		nodes.push(...view.nodes);
		animating ||= view.animating;
		segment = [];
	};
	const inSegment = (index: number) => {
		const child = children[index];
		if (isProcess(child)) return true;
		if (!segment.some(hasSubstance)) return false;
		const notice = child instanceof Spacer ? children[index + 1] : child;
		return noticeKind(notice, env.ui.theme) !== undefined;
	};
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (isHuman(child)) {
			flush(false);
			turn = child;
			nodes.push(new UserBar(child));
		} else if (inSegment(index)) segment.push(child);
		else {
			flush(false);
			nodes.push(child);
		}
	}
	flush(true);
	return { nodes, animating };
}

/** 段尾回复 = 其后只剩提示与机器消息的最后一条助手消息；回复留在摘要下方，其余折进摘要。 */
function tailReply(segment: readonly Component[]) {
	let at = segment.length - 1;
	while (at >= 0 && (!isProcess(segment[at]) || machineEntriesOf(segment[at]))) at--;
	const tail = segment[at];
	const reply = tail instanceof AssistantMessageComponent ? assistantView(tail, false) : undefined;
	return { tail, reply };
}

function renderSegment(segment: readonly Component[], turn: object, final: boolean, env: ProjectionEnv) {
	const { tail, reply } = tailReply(segment);
	const globalOpen = env.ui.getToolsExpanded();
	const open = globalOpen || env.isOpen(turn);
	const facts = scan(segment, reply?.activity, env);
	const hasSummary = segment.some(hasSubstance) || !!reply?.activity;
	const clock = env.clock.view(turn);
	const live = final && (clock.live || facts.running > 0 || !!reply?.activity);
	const sinceEnd = live ? undefined : clock.sinceEnd;
	const nodes: Component[] = [];
	if (hasSummary) {
		nodes.push(new Spacer(1), new TurnSummary({
			...facts, live, elapsed: clock.elapsed, sinceEnd, open,
			toggle: globalOpen ? undefined : () => env.toggleTurn(turn),
		}, env.ui.theme));
	}
	if (open) nodes.push(...processList(segment, env));
	else nodes.push(...foldedReplies(segment, hasSummary && reply?.body ? tail : undefined, reply?.body, hasSummary, env));
	return { nodes, animating: hasSummary && (live || (sinceEnd !== undefined && settling(sinceEnd))) };
}

/** 折叠态：最近 replyLines 条中间回复各一行首句（更早的计入“+N 条”），再接最后一条回复全文。 */
function foldedReplies(
	segment: readonly Component[],
	tail: Component | undefined,
	body: Component | undefined,
	hasSummary: boolean,
	env: ProjectionEnv,
): Component[] {
	const out: Component[] = [];
	const { theme } = env.ui;
	const middle = hasSummary && env.replyLines > 0
		? segment.filter((item): item is AssistantMessageComponent => item instanceof AssistantMessageComponent && item !== tail)
			.map(replyText).filter(Boolean)
		: [];
	const shown = middle.slice(-env.replyLines);
	if (shown.length) {
		out.push(new Spacer(1));
		if (middle.length > shown.length) out.push(new Line(`  ${theme.fg("dim", `+${middle.length - shown.length} 条`)}`));
		for (const text of shown) out.push(new Line(`  ${theme.fg("muted", firstSentence(text))}`));
	}
	// 宿主助手正文自带前导空行，不再另垫。
	if (body) out.push(body);
	return out;
}

function processList(segment: readonly Component[], env: ProjectionEnv): Component[] {
	const list: Component[] = [];
	for (const item of segment) {
		// 只有整条由信封构成的用户消息投影成 ↳ 行；CustomMessage 一律交给它自己的渲染器。
		const machine = item instanceof UserMessageComponent ? machineEntriesOf(item) : undefined;
		if (machine) list.push(...machine.map((entry) => new MachineRow(entry, env.ui.theme)));
		else if (item instanceof ToolExecutionComponent) {
			if (!(list.at(-1) instanceof ToolItem)) list.push(new Spacer(1));
			list.push(new ToolItem(item, env.ui, env.toggleRow));
		} else if (item instanceof AssistantMessageComponent) {
			const body = assistantView(item, true).body;
			if (body) list.push(body);
		} else list.push(item);
	}
	return list;
}

export function toggleToolDetails(row: ToolRow, setExpanded: ToolRow["setExpanded"]): void {
	setExpanded.call(row, !rowData(row).expanded);
}
