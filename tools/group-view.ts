import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Spacer, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
const LAYOUT_MOUSE_HANDLERS = new Set<NonNullable<Component["handleMouse"]>>([
	Container.prototype.handleMouse, Box.prototype.handleMouse,
]);

/** 普通布局容器只路由鼠标；真正的输入/鼠标处理或图片需要独立展示。 */
function requiresStandalone(component: Component | undefined): boolean {
	if (!component) return false;
	if (component instanceof Image || component.handleInput) return true;
	if (component.handleMouse && !LAYOUT_MOUSE_HANDLERS.has(component.handleMouse)) return true;
	return (component instanceof Container || component instanceof Box) && component.children.some(requiresStandalone);
}

function groupRenderer(component: Component | undefined): GroupRenderer | undefined {
	return component && "renderGroup" in component && typeof component.renderGroup === "function"
		? component as GroupRenderer : undefined;
}

export function groupable(component: Component): component is ToolRow {
	if (!(component instanceof ToolExecutionComponent)) return false;
	const row = rowData(component);
	if (row.result?.content?.some((block) => block.type === "image")) return false;
	return !requiresStandalone(row.callRendererComponent) && !requiresStandalone(row.resultRendererComponent);
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
		let running = 0;
		let failures = 0;
		let latest = this.rows.length ? rowData(this.rows[this.rows.length - 1]) : undefined;
		for (const row of this.rows) {
			const data = rowData(row);
			if (data.isPartial) { running++; latest = data; }
			if (data.result?.isError) failures++;
		}
		const activity = this.activity === "thinking" ? "思考中" : this.activity === "processing" ? "处理中" : undefined;
		const renderer = groupRenderer(latest?.callRendererComponent) ?? compactLine(latest, this.ui.theme);
		return renderer.renderGroup(width, { calls: this.rows.length, running, failures, activity });
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
	let rows: ToolRow[] = [];
	let activity: AssistantActivity | undefined;
	const flush = () => {
		if (!rows.length && !activity) return;
		projected.push(new Spacer(1));
		if (expanded) projected.push(...rows.map((row) => new ToolItem(row, ui, toggle)));
		else projected.push(new ProcessSummary(rows, activity, ui));
		rows = [];
		activity = undefined;
	};
	for (const child of children) {
		if (groupable(child)) {
			rows.push(child);
			activity = undefined;
		} else if (child instanceof AssistantMessageComponent) {
			const view = assistantView(child, expanded);
			if (view.body) { flush(); projected.push(view.body); }
			activity = view.activity;
		} else {
			flush();
			projected.push(child);
		}
	}
	flush();
	return projected;
}

export function toggleToolDetails(row: ToolRow, setExpanded: ToolRow["setExpanded"]): void {
	setExpanded.call(row, !rowData(row).expanded);
}
