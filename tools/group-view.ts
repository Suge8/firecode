import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { parseEnvelopes } from "../deliver.js";
import { HEAT_COLORS, paint, settling } from "../flame.js";
import { toolTarget } from "./actions.js";
import { firstSentence } from "./machine.js";
import { oneLine } from "../format.js";
import { ToolLine, resultText, type ActionLine, type RowState, type ToolResult } from "./line.js";
import { genericArgsParts } from "./parts.js";
import { assistantView, hasThinking, replyText, type AssistantActivity } from "./assistant-view.js";
import { machineEntries, machineLine, type MachineEntry } from "./machine.js";
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
function machineText(component: Component): string | undefined {
	if (component instanceof CustomMessageComponent) {
		const content = (component as unknown as { message: { content: unknown } }).message.content;
		return typeof content === "string" ? content : contentText(content);
	}
	if (component instanceof UserMessageComponent) return (component as unknown as { text: string }).text;
	return undefined;
}

function machineEntriesOf(component: Component): MachineEntry[] | undefined {
	const text = machineText(component);
	return text === undefined ? undefined : machineEntries(text);
}

/** 整条内容由信封构成的 CustomMessage 或用户消息。 */
export function isMachineMessage(component: Component): boolean {
	return machineEntriesOf(component) !== undefined;
}

function machineBodies(component: Component): string {
	return parseEnvelopes(machineText(component) ?? "")?.map((envelope) => envelope.body).join("\n\n") ?? "";
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (part?.type === "text" ? [String(part.text)] : [])).join("\n");
}

/** 只有人类用户消息是轮次边界。 */
function isHuman(component: Component): boolean {
	return component instanceof UserMessageComponent && !machineEntriesOf(component);
}

/** 宿主 CustomEntry（收尾统计等）：类不对扩展导出，按它独有的 hasContent 能力识别。 */
function isEntry(component: Component): boolean {
	return component instanceof Container && typeof (component as unknown as { hasContent?: unknown }).hasContent === "function";
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

const ACTIVITY_TEXT = { thinking: "思考中", processing: "处理中" } as const;

type Facts = Pick<SummaryView, "failures" | "notice" | "action" | "arrival"> & { running: number };

/** 一遍扫描段内过程，汇出摘要行需要的全部事实。 */
function scan(segment: readonly Component[], activity: AssistantActivity | undefined, env: ProjectionEnv): Facts {
	let running = 0;
	let failures = 0;
	let notice: string | undefined;
	let latest: RowData | undefined;
	let arrival: Facts["arrival"];
	for (const item of segment) {
		// 多条宿主提示只取首条原文，其余在展开态可见。
		if (noticeKind(item, env.ui.theme) === "warning") notice ??= oneLine(stripVTControlCharacters((item as unknown as { text: string }).text));
		const entries = machineEntriesOf(item);
		const returned = entries?.findLast((entry) => entry.returned)?.returned;
		const age = entries ? env.clock.arrivalAge(item) : Infinity;
		if (returned && age < ARRIVAL_FLASH_MS)
			arrival = { text: `${returned.name} ${returned.failed ? "失败" : "已返回"}`, failed: returned.failed, age };
		if (!(item instanceof ToolExecutionComponent)) continue;
		const data = rowData(item);
		// 运行中的工具优先当“当前动作”；都完成时取最后一个
		if (data.isPartial) running++;
		if (data.isPartial || !latest?.isPartial) latest = data;
		if (data.result?.isError) failures++;
	}
	const line = latest && actionLine(latest.callRendererComponent);
	const action = latest && (line
		? { word: line.actionWord, target: line.actionTarget }
		: {
			word: latest.toolDefinition?.label ?? latest.toolName,
			target: toolTarget(latest.toolName, latest.args, latest.cwd).value.map((part) => part.text).join("").trim(),
		});
	return {
		failures, notice, running, arrival,
		action: activity ? { word: ACTIVITY_TEXT[activity] } : action ?? { word: "思考" },
	};
}

/** 机器消息：展开态一行 ↳，点击切换完整正文（信封用户消息）或原生卡片（CustomMessage）。 */
class MachineItem implements Component {
	private rows = 1;
	constructor(
		private readonly item: Component,
		private readonly entries: readonly MachineEntry[],
		private readonly env: ProjectionEnv,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const rows = this.entries.map((entry) => machineLine(entry, this.env.ui.theme, width));
		this.rows = rows.length;
		return this.env.isOpen(this.item) ? [...rows, ...this.body(width)] : rows;
	}
	private body(width: number): string[] {
		if (this.item instanceof CustomMessageComponent) return this.item.render(width);
		const bodies = machineBodies(this.item);
		return new Markdown(bodies, 1, 0, getMarkdownTheme()).render(width);
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.y >= this.rows) {
			const inner = this.item as { handleMouse?: (e: TuiMouseEvent) => { handled: boolean } | undefined };
			if (!this.env.isOpen(this.item)) return undefined;
			return inner.handleMouse?.({ ...event, y: event.y - this.rows, height: event.height - this.rows });
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.env.toggleOpen(this.item);
		return { handled: true };
	}
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
	/** 展开状态以该轮的人类用户消息、或被点开的机器消息本身为键。 */
	isOpen: (key: object) => boolean;
	toggleOpen: (key: object) => void;
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
	const closing = lastEntries(children);
	const flush = (final: boolean) => {
		if (!segment.length) return;
		const view = renderSegment(segment, turn, final, env, closing);
		nodes.push(...view.nodes);
		animating ||= view.animating;
		segment = [];
	};
	const inSegment = (index: number) => {
		const child = children[index];
		if (isProcess(child)) return true;
		// 收尾统计等 CustomEntry 属于本轮：有段可依附时不切段。
		if (isEntry(child)) return segment.length > 0;
		// 宿主在用户消息（含空闲送达的信封）与提示前先插一个 Spacer：它跟着后面的节点走，
		// 后面的节点属于本段，它就属于本段。
		if (child instanceof Spacer) return segment.length > 0 && leadsInto(children[index + 1]);
		return segment.some(hasSubstance) && noticeKind(child, env.ui.theme) !== undefined;
	};
	const leadsInto = (next: Component | undefined) =>
		next !== undefined && (isProcess(next) || isEntry(next) || (segment.some(hasSubstance) && noticeKind(next, env.ui.theme) !== undefined));
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

/** 每轮最后一条 CustomEntry（收尾统计）：折叠态只有它留在最后回复下方。 */
function lastEntries(children: readonly Component[]): Set<Component> {
	const last = new Set<Component>();
	let current: Component | undefined;
	for (const child of children) {
		if (isHuman(child)) {
			if (current) last.add(current);
			current = undefined;
		} else if (isEntry(child)) current = child;
	}
	if (current) last.add(current);
	return last;
}

function renderSegment(segment: readonly Component[], turn: object, final: boolean, env: ProjectionEnv, closing: ReadonlySet<Component>) {
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
			...facts, live, elapsed: clock.elapsed, sinceEnd,
			toggle: globalOpen ? undefined : () => env.toggleOpen(turn),
		}, env.ui.theme));
	}
	if (open) nodes.push(...processList(segment, env));
	else nodes.push(...foldedReplies(segment, hasSummary && reply?.body ? tail : undefined, reply?.body, hasSummary, env), ...segment.filter((item) => closing.has(item)));
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
	for (const [index, item] of segment.entries()) {
		// 机器消息前的宿主 Spacer 已由列表自己的间距取代。
		if (item instanceof Spacer && machineEntriesOf(segment[index + 1] ?? item)) continue;
		const machine = machineEntriesOf(item);
		if (machine) {
			// 工具行之后空一行，免得 ↳ 行像是贴在上一个工具行底下。
			if (list.at(-1) instanceof ToolItem) list.push(new Spacer(1));
			list.push(new MachineItem(item, machine, env));
		} else if (item instanceof ToolExecutionComponent) {
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
