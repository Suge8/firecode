import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Spacer, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolLine, resultText, type RowState, type ToolResult } from "./line.js";
import { genericArgsParts } from "./parts.js";

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
	toolDefinition?: { label?: string; renderCall?: unknown; renderResult?: unknown };
	result?: ToolResult & { isError: boolean };
};
const rowData = (row: ToolRow): RowData => row as unknown as RowData;
const BUILT_INS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const CUSTOM_LINES = new Set(["read", "bash", "edit", "write"]);

export function groupable(component: Component): component is ToolRow {
	if (!(component instanceof ToolExecutionComponent)) return false;
	const row = rowData(component);
	if (row.result?.content?.some((block) => block.type === "image")) return false;
	return BUILT_INS.has(row.toolName) || !(row.toolDefinition?.renderCall || row.toolDefinition?.renderResult);
}

function emptyAssistant(component: Component): boolean {
	if (!(component instanceof AssistantMessageComponent)) return false;
	const message = (component as unknown as { lastMessage?: {
		stopReason?: string;
		content: Array<{ type: string; text?: string; thinking?: string }>;
	} }).lastMessage;
	if (!message) return true;
	if (["error", "aborted", "length"].includes(message.stopReason ?? "")) return false;
	return !message.content.some((block) =>
		(block.type === "text" && block.text?.trim()) || (block.type === "thinking" && block.thinking?.trim()));
}

function compactLine(row: RowData, theme: Theme, label = row.toolDefinition?.label ?? row.toolName): ToolLine {
	return new ToolLine({
		label, value: genericArgsParts(row.args), clip: "end", theme,
		ctx: {
			state: { ...row.rendererState, errorText: row.result?.isError ? resultText(row.result, true).displayText : "" },
			cwd: row.cwd, toolCallId: row.toolCallId,
			isPartial: row.isPartial, isError: row.result?.isError ?? false, expanded: false,
		},
	});
}

class ToolSummary implements Component {
	constructor(private readonly rows: ToolRow[], private readonly ui: ExtensionUIContext) {}
	invalidate(): void {}
	render(width: number): string[] {
		let running = 0;
		let failures = 0;
		let latest = rowData(this.rows[this.rows.length - 1]);
		for (const row of this.rows) {
			const data = rowData(row);
			if (data.isPartial) { running++; latest = data; }
			if (data.result?.isError) failures++;
		}
		const label = [`调用 ${this.rows.length} 次`, failures ? `${failures} 次失败` : "", running ? `${running} 个运行中` : ""]
			.filter(Boolean).join(" · ");
		return compactLine({
			...latest, rendererState: {}, isPartial: running > 0,
			result: { isError: failures > 0 },
		}, this.ui.theme, `${label} · ${latest.toolDefinition?.label ?? latest.toolName}`).render(width);
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.ui.setToolsExpanded(true);
		return { handled: true };
	}
}

class ToolItem implements Component {
	constructor(
		private readonly row: ToolRow,
		private readonly ui: ExtensionUIContext,
		private readonly toggle: (row: ToolRow) => void,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const data = rowData(this.row);
		if (!data.expanded && !CUSTOM_LINES.has(data.toolName)) return compactLine(data, this.ui.theme).render(width);
		const lines = this.row.render(width);
		return lines[0] === "" ? lines.slice(1) : lines;
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left" || !rowData(this.row).result) return undefined;
		this.toggle(this.row);
		return { handled: true };
	}
}

/** 从宿主组件顺序投影，既不搬走原组件，也不另存工具调用或展开档位。 */
export function projectToolGroups(
	children: readonly Component[],
	ui: ExtensionUIContext,
	toggle: (row: ToolRow) => void,
): Component[] {
	const projected: Component[] = [];
	let rows: ToolRow[] = [];
	const flush = () => {
		if (!rows.length) return;
		projected.push(new Spacer(1));
		if (ui.getToolsExpanded()) projected.push(...rows.map((row) => new ToolItem(row, ui, toggle)));
		else projected.push(new ToolSummary(rows, ui));
		rows = [];
	};
	for (const child of children) {
		if (groupable(child)) rows.push(child);
		else if (!emptyAssistant(child)) {
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
