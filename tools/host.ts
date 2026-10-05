/**
 * 宿主适配：读宿主组件私有字段、改宿主原型、找聊天容器——全插件只在这一个文件做。
 * 宿主没有聊天投影接缝，这些都是对实现细节的依赖；升级 pi 时只审这一个文件。
 * 每个读取点都校验形状：字段改名或换型时抛 HostShapeError，分组安装与渲染据此整体退回原生显示并明确提示，
 * 不悄悄画错。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Container, ScrollView, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RowState, ToolResult } from "./line.js";

export class HostShapeError extends Error {
	constructor(where: string) {
		super(`过程分组已停用：宿主组件形状变了（${where}），已保持原生显示；请升级 FireCode`);
	}
}

/** 宿主工具行：结果与单工具展开仍归宿主所有，这里只读。 */
export type ToolRow = ToolExecutionComponent;
export interface ToolFacts {
	toolName: string;
	toolCallId: string;
	args: unknown;
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	rendererState: RowState;
	toolDefinition?: { label?: string };
	callRendererComponent?: Component;
	result?: ToolResult & { isError: boolean };
	ui: TUI;
}

type Shape = Record<string, "string" | "boolean" | "object">;
const TOOL_SHAPE: Shape = { toolName: "string", toolCallId: "string", cwd: "string", expanded: "boolean", isPartial: "boolean", rendererState: "object", ui: "object" };
const ASSISTANT_SHAPE: Shape = { contentContainer: "object", isStreaming: "boolean" };

function checked<T>(value: object, shape: Shape, where: string): T {
	for (const [field, type] of Object.entries(shape)) {
		const actual = (value as Record<string, unknown>)[field];
		if (typeof actual !== type || actual === null) throw new HostShapeError(`${where}.${field}`);
	}
	return value as T;
}

/** 发现钩子只比对工具行归属哪个 TUI，不做形状校验（形状交给发现后的统一自检）。 */
export function rowUiOf(row: ToolRow): unknown {
	return (row as unknown as { ui?: unknown }).ui;
}

export function toolFacts(row: ToolRow): ToolFacts {
	return checked<ToolFacts>(row, TOOL_SHAPE, "ToolExecutionComponent");
}

interface AssistantFacts {
	contentContainer: Container;
	lastMessage?: AssistantMessage;
	isStreaming: boolean;
}

export function assistantFacts(source: AssistantMessageComponent): AssistantFacts {
	const facts = checked<AssistantFacts>(source, ASSISTANT_SHAPE, "AssistantMessageComponent");
	if (!(facts.contentContainer instanceof Container)) throw new HostShapeError("AssistantMessageComponent.contentContainer");
	return facts;
}

/** CustomMessage 的原始消息（content 与扩展给的 details）。 */
export function customMessageOf(component: CustomMessageComponent): { content: unknown; details?: unknown } {
	const message = (component as unknown as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) throw new HostShapeError("CustomMessageComponent.message");
	return message as { content: unknown; details?: unknown };
}

export function userTextOf(component: UserMessageComponent): string {
	return checked<{ text: string }>(component, { text: "string" }, "UserMessageComponent").text;
}

/** 宿主整行单色提示的原文（带颜色转义）。宿主的 ThemedText 首次渲染前 text 还是空串，原文由私有的 build 现算。 */
export function textComponentText(component: Text): string {
	const build = (component as unknown as { build?: unknown }).build;
	if (typeof build === "function") return String(build.call(component));
	return checked<{ text: string }>(component, { text: "string" }, "Text").text;
}

/** 宿主对 ctrl+o 的状态回显；在过程分组里 ctrl+o 就是“全部展开/全部折叠”，这句回显只是噪声。 */
const TOOL_OUTPUT_ECHO = /^Tool output: (?:expanded|collapsed)$/;

export function isToolOutputEcho(component: Component | undefined): boolean {
	return component instanceof Text && TOOL_OUTPUT_ECHO.test(stripVTControlCharacters(textComponentText(component)).trim());
}

/** 宿主 CustomEntry（轮记录等）：类不对扩展导出，按它独有的 hasContent 能力识别。 */
export function isEntry(component: Component): boolean {
	return component instanceof Container && typeof (component as unknown as { hasContent?: unknown }).hasContent === "function";
}

/** 宿主不给 TUI 句柄：挂一个空 widget 拿到引用后立即撤掉。 */
export function captureTui(ui: ExtensionUIContext, use: (tui: TUI) => void): void {
	ui.setWidget("firecode-tui-capture", (tui) => {
		use(tui);
		return { render: () => [], invalidate() {} };
	});
	ui.setWidget("firecode-tui-capture", undefined);
}

/** 聊天容器 = 直接装着用户消息、助手消息或工具行的容器（宿主只在聊天里构造用户消息组件）。 */
export function findChat(value: Component): Container | undefined {
	if (!(value instanceof Container)) return undefined;
	if (value.children.some(isChatChild)) return value;
	for (const child of value.children) {
		const found = findChat(child);
		if (found) return found;
	}
	return undefined;
}

export function isChatChild(child: Component): boolean {
	return child instanceof ToolExecutionComponent || child instanceof AssistantMessageComponent || child instanceof UserMessageComponent;
}

/** 装着聊天容器的滚动视图（全屏模式下跟随末尾的那个）；主屏模式没有，返回 undefined。 */
export function scrollViewOf(root: Component, target: Component): ScrollView | undefined {
	const contains = (node: Component): boolean => node === target || (node instanceof Container && node.children.some(contains));
	const visit = (node: Component): ScrollView | undefined => {
		if (!(node instanceof Container)) return undefined;
		for (const child of node.children) {
			if (!contains(child)) continue;
			return visit(child) ?? (child instanceof ScrollView ? child : undefined);
		}
		return undefined;
	};
	return visit(root);
}

/** 原型补丁的安装与精确还原：只还原仍是自己装上的那一层。 */
export function patchMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
	const original = target[key];
	if (typeof original !== "function") throw new HostShapeError(`${String(key)} 不是方法`);
	target[key] = replacement;
	return () => {
		if (target[key] === replacement) target[key] = original;
	};
}
