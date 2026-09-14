import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Spacer, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
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

function compactLine(row: RowData | undefined, theme: Theme): ToolLine {
	return new ToolLine({
		label: row?.toolDefinition?.label ?? row?.toolName ?? "", value: genericArgsParts(row?.args), clip: "end", theme,
		ctx: {
			state: { ...row?.rendererState, errorText: row?.result?.isError ? resultText(row.result, true).displayText : "" },
			cwd: row?.cwd ?? "", toolCallId: row?.toolCallId ?? "",
			isPartial: row?.isPartial ?? false, isError: row?.result?.isError ?? false, expanded: false,
		},
	});
}

class ProcessSummary implements Component {
	constructor(
		private readonly rows: ToolRow[],
		private readonly activity: AssistantActivity | undefined,
		private readonly ui: ExtensionUIContext,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const counts = new Map<string, number>();
		let running = 0;
		let failures = 0;
		let latest = this.rows.length ? rowData(this.rows[this.rows.length - 1]) : undefined;
		for (const row of this.rows) {
			const data = rowData(row);
			const label = data.toolDefinition?.label ?? data.toolName;
			counts.set(label, (counts.get(label) ?? 0) + 1);
			if (data.isPartial) { running++; latest = data; }
			if (data.result?.isError) failures++;
		}
		const activity = this.activity === "thinking" ? "思考中" : this.activity === "processing" ? "处理中" : undefined;
		const renderer = groupRenderer(latest?.callRendererComponent) ?? compactLine(latest, this.ui.theme);
		return renderer.renderGroup(width, { counts: [...counts], running, failures, activity });
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
		const tail = segment.at(-1);
		const reply = tail instanceof AssistantMessageComponent ? assistantView(tail, expanded) : undefined;
		const process = reply?.body ? segment.slice(0, -1) : segment;
		projected.push(...(expanded ? processList(process, ui, toggle) : processSummary(process, reply?.activity, ui)));
		if (reply?.body) projected.push(reply.body);
		segment = [];
	};
	for (const child of children) {
		if (isProcess(child)) { segment.push(child); continue; }
		flush();
		projected.push(child);
	}
	flush();
	return projected;
}

function processSummary(process: readonly Component[], activity: AssistantActivity | undefined, ui: ExtensionUIContext): Component[] {
	const rows = process.filter((item): item is ToolRow => item instanceof ToolExecutionComponent);
	return rows.length || activity ? [new Spacer(1), new ProcessSummary(rows, activity, ui)] : [];
}

function processList(process: readonly Component[], ui: ExtensionUIContext, toggle: (row: ToolRow) => void): Component[] {
	const list: Component[] = [];
	for (const item of process) {
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
