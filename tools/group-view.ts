import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { ToolLine, resultText, type RowState, type ToolResult, type GroupRenderer } from "./line.js";
import { genericArgsParts } from "./parts.js";
import { assistantView, type AssistantActivity } from "./assistant-view.js";

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

function groupRenderer(component: Component | undefined): GroupRenderer | undefined {
	return component && "renderGroup" in component && typeof component.renderGroup === "function"
		? component as GroupRenderer : undefined;
}

/** 过程 = 模型的输出、动作与收件；用户消息、CustomEntry 等其余节点是段边界。 */
function isProcess(component: Component): boolean {
	return component instanceof ToolExecutionComponent
		|| component instanceof AssistantMessageComponent
		|| component instanceof CustomMessageComponent;
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
		label: row?.toolDefinition?.label ?? row?.toolName ?? "过程", value: genericArgsParts(row?.args), clip: "end", theme,
		ctx: {
			state: { ...row?.rendererState, errorText: row?.result?.isError ? resultText(row.result, true).displayText : "" },
			cwd: row?.cwd ?? "", toolCallId: row?.toolCallId ?? "",
			isPartial: row?.isPartial ?? false, isError: row?.result?.isError ?? false, expanded: false,
		},
	});
}

class ProcessSummary implements Component {
	constructor(
		private readonly process: readonly Component[],
		private readonly activity: AssistantActivity | undefined,
		private readonly ui: ExtensionUIContext,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const counts = new Map<string, number>();
		let running = 0;
		let failures = 0;
		let notices = 0;
		let latest: RowData | undefined;
		for (const item of this.process) {
			if (noticeKind(item, this.ui.theme) === "warning") notices++;
			if (!(item instanceof ToolExecutionComponent)) continue;
			const data = rowData(item);
			const label = data.toolDefinition?.label ?? data.toolName;
			counts.set(label, (counts.get(label) ?? 0) + 1);
			// 运行中的工具优先当“当前动作”；都完成时取最后一个
			if (data.isPartial) running++;
			if (data.isPartial || !latest?.isPartial) latest = data;
			if (data.result?.isError) failures++;
		}
		const activity = this.activity === "thinking" ? "思考中" : this.activity === "processing" ? "处理中" : undefined;
		const renderer = groupRenderer(latest?.callRendererComponent) ?? compactLine(latest, this.ui.theme);
		return renderer.renderGroup(width, { counts: [...counts], running, failures, notices, activity });
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.ui.setToolsExpanded(true);
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
			const renderer = groupRenderer(data.callRendererComponent) ?? compactLine(data, this.ui.theme);
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

/** 从宿主组件顺序投影，既不搬走原组件，也不另存工具调用或展开档位。 */
export function projectProcessGroups(
	children: readonly Component[],
	ui: ExtensionUIContext,
	toggle: (row: ToolRow) => void,
): Component[] {
	const projected: Component[] = [];
	const expanded = ui.getToolsExpanded();
	let segment: Component[] = [];
	const flush = () => {
		if (!segment.length) return;
		if (expanded) projected.push(...processList(segment, ui, toggle));
		else projected.push(...processSummary(segment, ui));
		segment = [];
	};
	const inSegment = (index: number) => {
		const child = children[index];
		if (isProcess(child)) return true;
		if (!segment.length) return false;
		const notice = child instanceof Spacer ? children[index + 1] : child;
		return noticeKind(notice, ui.theme) !== undefined;
	};
	for (let index = 0; index < children.length; index++) {
		if (inSegment(index)) { segment.push(children[index]); continue; }
		flush();
		projected.push(children[index]);
	}
	flush();
	return projected;
}

/** 段尾回复 = 其后只剩提示与状态行的最后一条助手消息；提示折入摘要，回复留在摘要下方。 */
function processSummary(segment: readonly Component[], ui: ExtensionUIContext): Component[] {
	let replyAt = segment.length - 1;
	while (replyAt >= 0 && !isProcess(segment[replyAt])) replyAt--;
	const tail = segment[replyAt];
	const reply = tail instanceof AssistantMessageComponent ? assistantView(tail, false) : undefined;
	const process = reply?.body ? segment.filter((item) => item !== tail) : segment;
	const summarized = process.some((item) => item instanceof ToolExecutionComponent || noticeKind(item, ui.theme) === "warning");
	const out: Component[] = [];
	if (summarized || reply?.activity) out.push(new Spacer(1), new ProcessSummary(process, reply?.activity, ui));
	if (reply?.body) out.push(new Spacer(1), reply.body);
	return out;
}

function processList(segment: readonly Component[], ui: ExtensionUIContext, toggle: (row: ToolRow) => void): Component[] {
	const list: Component[] = [];
	for (const item of segment) {
		if (item instanceof ToolExecutionComponent) {
			if (!(list.at(-1) instanceof ToolItem)) list.push(new Spacer(1));
			list.push(new ToolItem(item, ui, toggle));
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
