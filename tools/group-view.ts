import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { parseEnvelopes } from "../deliver.js";
import { HEAT_COLORS, paint, settling } from "../flame.js";
import { toolTargetText } from "./actions.js";
import { firstSentence, oneLine, textOf } from "../format.js";
import { ToolLine, resultText, type ActionLine } from "./line.js";
import { genericArgsParts } from "./parts.js";
import { assistantView, hasThinking, replyText, type AssistantActivity } from "./assistant-view.js";
import { customMessageOf, isEntry, isToolOutputEcho, openCard, textComponentText, toolFacts, userTextOf, type ToolFacts, type ToolRow } from "./host.js";
import { machineEntries, machineLine, type MachineEntry } from "./machine.js";
import { msg } from "./messages.js";
import { combineRounds, type Round } from "../round.js";
import { roundOf } from "./round.js";
import type { BusyView } from "../busy.js";
import { ARRIVAL_FLASH_MS, Line, TurnSummary, type SummaryView } from "./turn-summary.js";

function actionLine(component: Component | undefined): ActionLine | undefined {
	return component && "actionWord" in component && typeof component.actionWord === "string"
		? component as ActionLine : undefined;
}

/** 机器消息：整条文本由信封构成，来自 CustomMessage 或空闲时投递的用户消息。 */
function machineText(component: Component): string | undefined {
	if (component instanceof CustomMessageComponent) {
		return textOf(customMessageOf(component).content);
	}
	if (component instanceof UserMessageComponent) return userTextOf(component);
	return undefined;
}

function machineEntriesOf(component: Component): MachineEntry[] | undefined {
	const text = machineText(component);
	if (text === undefined) return undefined;
	const details = component instanceof CustomMessageComponent
		? customMessageOf(component).details
		: undefined;
	return machineEntries(text, details);
}

/** 整条内容由信封构成的 CustomMessage 或用户消息。 */
export function isMachineMessage(component: Component): boolean {
	return machineEntriesOf(component) !== undefined;
}

function machineBodies(component: Component): string {
	return parseEnvelopes(machineText(component) ?? "")?.map((envelope) => envelope.body).join("\n\n") ?? "";
}

/** 只有人类用户消息是轮次边界。 */
function isHuman(component: Component): boolean {
	return component instanceof UserMessageComponent && !machineEntriesOf(component);
}

/** 模型侧的过程 = 模型的输出、动作与收件（含机器消息）；投影里再加上本段的补话。其余节点（错误、CustomEntry 等）是段边界。 */
function isModelProcess(component: Component): boolean {
	return component instanceof ToolExecutionComponent
		|| component instanceof AssistantMessageComponent
		|| component instanceof CustomMessageComponent
		|| (component instanceof UserMessageComponent && !isHuman(component));
}

/** 有实质的过程（工具或思考）或轮记录才有摘要行；提示只折入有摘要行的段。 */
function hasSubstance(component: Component): boolean {
	return component instanceof ToolExecutionComponent
		|| (component instanceof AssistantMessageComponent && hasThinking(component))
		|| roundOf(component) !== undefined;
}

/**
 * 宿主把 transcript 提示（缓存/丢思考/压缩计费）与状态行（切档、切模型）画成整行单色 Text：
 * warning 是提示，dim 是状态。颜色是宿主唯一给出的语义通道；错误与混色文本仍是边界。
 */
function noticeKind(component: Component | undefined, theme: Theme): "warning" | "dim" | undefined {
	if (!(component instanceof Text)) return;
	const text = textComponentText(component);
	const plain = stripVTControlCharacters(text);
	return (["warning", "dim"] as const).find((color) => theme.fg(color, plain) === text);
}

function compactLine(row: ToolFacts | undefined, theme: Theme): ToolLine {
	return new ToolLine({
		label: row ? row.toolDefinition?.label ?? row.toolName : msg.thinking, value: genericArgsParts(row?.args), clip: "end", theme,
		ctx: {
			state: { ...row?.rendererState, errorText: row?.result?.isError ? resultText(row.result, true).displayText : "" },
			cwd: row?.cwd ?? "", toolCallId: row?.toolCallId ?? "",
			isPartial: row?.isPartial ?? false, isError: row?.result?.isError ?? false, expanded: false,
		},
	});
}

/** 折叠态每组最多列几条中间回复首句。 */
const REPLY_LINES = 3;

type Facts = Pick<SummaryView, "notice" | "action" | "arrival" | "failures" | "earlier"> & { round?: Round };

/** 一遍扫描段内过程，汇出摘要行需要的全部事实。 */
function scan(segment: readonly Component[], activity: AssistantActivity | undefined, env: ProjectionEnv): Facts {
	const running: ToolFacts[] = [];
	let notice: string | undefined;
	let arrival: Facts["arrival"];
	const rounds: Round[] = [];
	const failed = new Set<string>();
	for (const item of segment) {
		// 多条宿主提示只取首条原文，其余在展开态可见。
		if (noticeKind(item, env.ui.theme) === "warning") notice ??= oneLine(stripVTControlCharacters(textComponentText(item as Text)));
		const round = roundOf(item);
		if (round) rounds.push(round);
		const entries = machineEntriesOf(item);
		for (const entry of entries ?? []) if (entry.failed && entry.worker) failed.add(entry.worker);
		const settled = entries?.findLast((entry) => entry.duration);
		const age = settled ? arrivalAge(item, env) : Infinity;
		if (settled && age < ARRIVAL_FLASH_MS) arrival = { text: settled.title, failed: settled.alarm, age };
		if (item instanceof ToolExecutionComponent && toolFacts(item).isPartial) running.push(toolFacts(item));
	}
	const record = combineRounds(rounds);
	return { notice, arrival, round: record?.round, earlier: record?.earlier, failures: failed.size, action: actionOf(running.at(-1), activity, env) };
}

/**
 * 当前动作只说正在发生的事：运行中的工具 > 助手在思考/回复 > 指挥官回合在跑但两头都没动静（等模型）是思考中；
 * 指挥官自己歇着、只在等子代理时没有当前动作，摘要行只留火苗（等待状态与计时只在边框）。
 */
function actionOf(tool: ToolFacts | undefined, activity: AssistantActivity | undefined, env: ProjectionEnv): SummaryView["action"] {
	if (tool) {
		const line = actionLine(tool.callRendererComponent);
		return line
			? { word: line.actionWord, target: line.actionTarget }
			: { word: tool.toolDefinition?.label ?? tool.toolName, target: toolTargetText(tool.toolName, tool.args, tool.cwd) };
	}
	if (activity) return { word: msg.activity[activity] };
	return env.busy().agentRunning ? { word: msg.activity.thinking } : undefined;
}

/** 机器消息首次出现的时刻：只有运行中出现的才算“新到达”，恢复的历史永远是旧的。 */
const FIRST_SEEN = new WeakMap<object, number>();

/** 机器消息距首次出现多久。 */
function arrivalAge(item: object, env: ProjectionEnv): number {
	if (!FIRST_SEEN.has(item)) FIRST_SEEN.set(item, env.busy().busy ? Date.now() : -Infinity);
	return Date.now() - FIRST_SEEN.get(item)!;
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
		if (this.item instanceof CustomMessageComponent) {
			openCard(this.item);
			return this.item.render(width);
		}
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
		private readonly ui: ProjectionUI,
		private readonly toggle: (row: ToolRow) => void,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const data = toolFacts(this.row);
		if (!data.expanded) {
			const renderer = actionLine(data.callRendererComponent) ?? compactLine(data, this.ui.theme);
			return renderer.render(width);
		}
		const lines = this.row.render(width);
		this.leadingRows = lines[0] === "" ? 1 : 0;
		return lines.slice(this.leadingRows);
	}
	handleMouse(event: TuiMouseEvent) {
		if (toolFacts(this.row).expanded)
			return this.row.handleMouse({ ...event, y: event.y + this.leadingRows, height: event.height + this.leadingRows });
		if (event.type !== "click" || event.button !== "left" || !toolFacts(this.row).result) return undefined;
		this.toggle(this.row);
		return { handled: true };
	}
}

const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

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
		// 宿主上下各留一行背景内边距：去掉，竖条从第一行正文开始、到最后一行正文结束（主会话与子代理视图同一组件）。
		// 去掉的内边距行上若带 OSC 133 语义标记，挪到相邻正文行的行首：行中的 133;A 会被终端当 fresh-line 执行 CR+LF，留下残影。
		const blank = (line: string | undefined) => line !== undefined && !stripVTControlCharacters(line).trim();
		const head = blank(lines[0]) ? OSC133_PREFIX.exec(lines.shift()!)?.[0] ?? "" : "";
		const tail = lines.length > 1 && blank(lines.at(-1)) ? OSC133_PREFIX.exec(lines.pop()!)?.[0] ?? "" : "";
		return lines.map((line, index) => {
			const carried = (index === 0 ? head : "") + (index === lines.length - 1 ? tail : "");
			const mark = OSC133_PREFIX.exec(line)?.[0] ?? "";
			return carried + mark + bar + line.slice(mark.length);
		});
	}
}

/** 投影只用到宿主 UI 的主题与全局展开档位；主会话传 ctx.ui，子代理全过程视图传自己的一份。 */
type ProjectionUI = Pick<ExtensionUIContext, "theme" | "getToolsExpanded">;

export interface ProjectionEnv {
	ui: ProjectionUI;
	/** 会话进行中的快照（拉取）：哪一轮开着、指挥官回合是否在跑、机器消息是否刚到。落定后的耗时与终态来自聊天树里的轮记录。 */
	busy: () => BusyView;
	toggleRow: (row: ToolRow) => void;
	/** 相对全局档位被点击翻转过的键：该轮的人类用户消息，或被点开的机器消息本身；全局档位变化时清空。 */
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

/**
 * 开轮的人类消息：没有更早的人类消息，或与上一条人类消息之间已有轮记录（上一段已歇下）。
 * 其余人类消息是本段内的补话（steer、等子代理时的追加），折进当前轮，不另起一轮。只看聊天树，不另存状态。
 */
function openersOf(children: readonly Component[]): Set<Component> {
	const openers = new Set<Component>();
	let seenHuman = false;
	let settled = false;
	for (const child of children) {
		if (roundOf(child)) settled = true;
		else if (isHuman(child)) {
			if (!seenHuman || settled) openers.add(child);
			seenHuman = true;
			settled = false;
		}
	}
	return openers;
}

/** 宿主对 ctrl+o 的回显连同它前面的 Spacer 不进投影。 */
function withoutEchoes(children: readonly Component[]): Component[] {
	return children.filter((child, index) => !isToolOutputEcho(child) && !(child instanceof Spacer && isToolOutputEcho(children[index + 1])));
}

/** 从宿主组件顺序投影，既不搬走原组件，也不另存工具调用或展开档位。 */
export function projectProcessGroups(source: readonly Component[], env: ProjectionEnv): Projection {
	const children = withoutEchoes(source);
	const openers = openersOf(children);
	const isProcess = (component: Component) => isModelProcess(component) || (isHuman(component) && !openers.has(component));
	const nodes: Component[] = [];
	let animating = false;
	let turn = env.headless;
	let segment: Component[] = [];
	const flush = (final: boolean) => {
		// 进行中的轮在第一个助手组件到来之前也有摘要行（思考中）。
		if (!segment.length && !(final && env.busy().busy)) return;
		const view = renderSegment(segment, turn, final, isProcess, env);
		nodes.push(...view.nodes);
		animating ||= view.animating;
		segment = [];
	};
	const inSegment = (index: number) => {
		const child = children[index];
		if (isProcess(child)) return true;
		// 轮记录等 CustomEntry 属于本轮：有段可依附时不切段。
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
		if (openers.has(child)) {
			flush(false);
			turn = child;
			nodes.push(new UserBar(child));
		} else if (inSegment(index)) segment.push(child);
		else if (!roundOf(child)) {
			// 无段可依附的轮记录（这一段没有任何过程）没有摘要行可画，不让它的宿主壳空出一行。
			flush(false);
			nodes.push(child);
		}
	}
	flush(true);
	return { nodes, animating };
}

type IsProcess = (component: Component) => boolean;

/** 段尾回复 = 其后只剩提示与机器消息的最后一条助手消息（其后有补话就还没有段尾回复）；回复留在摘要下方，其余折进摘要。 */
function tailReply(segment: readonly Component[], isProcess: IsProcess) {
	let at = segment.length - 1;
	while (at >= 0 && (!isProcess(segment[at]) || machineEntriesOf(segment[at]))) at--;
	const tail = segment[at];
	const reply = tail instanceof AssistantMessageComponent ? assistantView(tail, false) : undefined;
	return { tail, reply };
}

function renderSegment(segment: readonly Component[], turn: object, final: boolean, isProcess: IsProcess, env: ProjectionEnv) {
	const { tail, reply } = tailReply(segment, isProcess);
	const globalOpen = env.ui.getToolsExpanded();
	// 逐轮点击只是相对全局档位的覆盖：全局折叠时点开，全局展开时折起。
	const open = globalOpen !== env.isOpen(turn);
	const facts = scan(segment, reply?.activity, env);
	const live = final && env.busy().busy;
	// 进行中的轮一律有摘要行：纯文字轮从开始到歇下都占着这一行，回复不跳。
	const hasSummary = live || segment.some(hasSubstance);
	const round = live ? undefined : facts.round;
	const sinceEnd = round && Date.now() - round.at;
	const nodes: Component[] = [];
	if (hasSummary) {
		nodes.push(new Spacer(1), new TurnSummary({
			// 运行中失败行常驻在子代理活动列表，摘要行只在事后留痕。
			...facts, failures: live ? 0 : facts.failures, live, round, sinceEnd,
			toggle: () => env.toggleOpen(turn),
		}, env.ui.theme));
	}
	if (open) nodes.push(...processList(segment, env));
	else nodes.push(...foldedReplies(segment, hasSummary && reply?.body ? tail : undefined, reply?.body, hasSummary, env));
	return { nodes, animating: hasSummary && (live || (sinceEnd !== undefined && settling(sinceEnd))) };
}

/**
 * 折叠态按时间顺序：先是第一条补话之前的中间回复，之后每条补话（人类原话，竖条全文）后面跟它那一段的中间回复；
 * 每组各自只列最近 REPLY_LINES 条首句，更早的在组内折成“+N 条”。最后接段尾回复全文。
 */
function foldedReplies(
	segment: readonly Component[],
	tail: Component | undefined,
	body: Component | undefined,
	hasSummary: boolean,
	env: ProjectionEnv,
): Component[] {
	const out: Component[] = [];
	const { theme } = env.ui;
	const groups: { message?: UserMessageComponent; replies: string[] }[] = [{ replies: [] }];
	for (const item of segment) {
		if (item instanceof UserMessageComponent && isHuman(item)) groups.push({ message: item, replies: [] });
		else if (item instanceof AssistantMessageComponent && item !== tail) {
			const text = replyText(item);
			if (text) groups[groups.length - 1].replies.push(firstSentence(text));
		}
	}
	const listing = hasSummary;
	for (const { message, replies } of groups) {
		// 前后留白与开轮的用户消息一致：上方隔一行，竖条消息自带上下内边距。
		if (message) out.push(new Spacer(1), new UserBar(message));
		if (!listing || !replies.length) continue;
		const shown = replies.slice(-REPLY_LINES);
		// 与宿主正文同一左边距（1 列）。
		out.push(new Spacer(1));
		if (replies.length > shown.length) out.push(new Line(` ${theme.fg("dim", msg.moreReplies(replies.length - shown.length))}`));
		for (const text of shown) out.push(new Line(` ${theme.fg("muted", text)}`));
	}
	// 宿主助手正文自带前导空行，不再另垫。
	if (body) out.push(body);
	return out;
}

function processList(segment: readonly Component[], env: ProjectionEnv): Component[] {
	const list: Component[] = [];
	for (const [index, item] of segment.entries()) {
		// 机器消息前的宿主 Spacer 已由列表自己的间距取代；轮记录零行，已在摘要行体现。
		if (item instanceof Spacer && machineEntriesOf(segment[index + 1] ?? item)) continue;
		if (roundOf(item)) continue;
		const machine = machineEntriesOf(item);
		if (machine) {
			// 与上一个工具行或正文空一行，免得 ↳ 行像是贴在它底下；连续的 ↳ 行紧挨。
			if (!(list.at(-1) instanceof MachineItem || list.at(-1) instanceof Spacer)) list.push(new Spacer(1));
			list.push(new MachineItem(item, machine, env));
		} else if (item instanceof ToolExecutionComponent) {
			if (!(list.at(-1) instanceof ToolItem)) list.push(new Spacer(1));
			list.push(new ToolItem(item, env.ui, env.toggleRow));
		} else if (item instanceof AssistantMessageComponent) {
			const body = assistantView(item, true).body;
			if (body) list.push(body);
		} else if (item instanceof UserMessageComponent) list.push(new UserBar(item));
		else list.push(item);
	}
	return list;
}

export function toggleToolDetails(row: ToolRow, setExpanded: ToolRow["setExpanded"]): void {
	setExpanded.call(row, !toolFacts(row).expanded);
}
