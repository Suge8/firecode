/**
 * 宿主适配：读宿主组件私有字段、改宿主原型、找聊天容器——全插件只在这一个文件做。
 * 宿主没有聊天投影接缝，这些都是对实现细节的依赖；升级 pi 时只审这一个文件。
 * 每个读取点都校验形状：字段改名或换型时抛 HostShapeError，分组安装与渲染据此整体退回原生显示并明确提示，
 * 不悄悄画错。形状只对首批真实实例自检：构造假实例探测要 TUI 引用且有副作用。向上游要投影钩子是长期方向。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	type CustomEntry,
	type EntryRenderer,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
	type AgentSessionEvent,
	type ExtensionUIContext,
	type MessageRenderer,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Container, ScrollView, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RowState, ToolResult } from "./line.js";
import { msg } from "./messages.js";

export class HostShapeError extends Error {
	constructor(where: string) {
		super(msg.hostShape(where));
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

/** 滚动视图上次布局的内容总高（宿主私有字段）：点击锚定按它把组件内行号换成滚动内容行号。 */
export function scrollContentHeight(view: ScrollView): number {
	const height = (view as unknown as { contentHeight?: unknown }).contentHeight;
	if (typeof height !== "number") throw new HostShapeError("ScrollView.contentHeight");
	return height;
}

/** 原型补丁的安装与精确还原：只还原仍是自己装上的那一层。 */
export function patchMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
	const original = target[key];
	if (typeof original !== "function") throw new HostShapeError(msg.notMethod(String(key)));
	target[key] = replacement;
	return () => {
		if (target[key] === replacement) target[key] = original;
	};
}

/**
 * 机器消息卡片（指挥官事件、审查结果卡）的原生展开只由投影决定：主会话的分组补丁压住宿主对它们的全局展开，
 * 只放行投影点开登记过的卡片。主会话与子代理视图同一机制。
 */
const openedCards = new WeakSet<Component>();

export function openCard(card: CustomMessageComponent): void {
	openedCards.add(card);
	card.setExpanded(true);
}

export function isCardOpened(card: Component): boolean {
	return openedCards.has(card);
}

/**
 * 独立的工具行 TUI 句柄：除 requestRender 外全部委托给真实 TUI。主会话的分组补丁按“工具行属于主 TUI”识别自己的行，
 * 不在主聊天里的投影（子代理全过程视图）用它建工具行，单工具展开与重绘都归调用方。
 */
export function detachedTui(tui: TUI, requestRender: () => void): TUI {
	return Object.create(tui, { requestRender: { value: requestRender } }) as TUI;
}

/** 镜像建组件要的外部来源：工具行的 TUI 句柄与工作目录、工具渲染定义、自定义消息与自定义记录的渲染器、主题。 */
export interface MirrorSources {
	ui: TUI;
	cwd: string;
	theme: Theme;
	toolDefinition(name: string): ToolDefinition | undefined;
	messageRenderer(customType: string): MessageRenderer | undefined;
	entryRenderer(customType: string): EntryRenderer | undefined;
}

/** 会话分支里镜像认得的条目（宿主 SessionEntry 的结构子集）。 */
export type MirrorEntry =
	| { type: "message"; message: AgentMessage }
	| { type: "custom_message"; customType: string; content: unknown; display: boolean; details?: unknown; timestamp: string }
	| { type: "custom"; customType: string; data?: unknown; timestamp: string }
	| { type: string };

function customMessage(entry: { customType: string; content: unknown; details?: unknown; timestamp: string }) {
	return {
		role: "custom", customType: entry.customType, content: entry.content, display: true,
		details: entry.details, timestamp: Date.parse(entry.timestamp),
	} as AgentMessage;
}

/** 宿主 CustomEntryComponent 的壳（类不导出）：Container 带 hasContent 能力，里面放一个零行标记；isEntry 按同一能力识别。 */
function entryShell(marker: Component): Container {
	const shell = new Container();
	shell.addChild(new Spacer(1));
	shell.addChild(marker);
	(shell as unknown as { hasContent: () => boolean }).hasContent = () => true;
	return shell;
}

const ABORTED_TEXT = "Operation aborted";

/**
 * 宿主把会话消息与运行事件变成聊天组件的逻辑（interactive-mode 的 addMessageToChat、renderSessionItems 与事件分支）是私有的；
 * 子代理全过程视图要同一套组件喂给过程组投影，这里是它的最小镜像：user / assistant（含 toolCall 工具行）/ toolResult / custom，
 * 历史回放与运行中事件两条入口。每建一个助手或工具组件都过形状自检，宿主改了就抛 HostShapeError，由调用方整体提示，不画错。
 * 不镜像的（bashExecution、压缩与分支摘要、技能块、缓存提示）在子代理会话里不出现或无关。
 */
export class ChatMirror {
	readonly chat = new Container();
	private readonly pending = new Map<string, ToolExecutionComponent>();
	private streaming: AssistantMessageComponent | undefined;

	constructor(private readonly sources: MirrorSources) {}

	/** 会话分支里的一个条目（历史回放）：消息、显示的自定义消息与自定义记录。 */
	replay(entry: MirrorEntry): void {
		if (entry.type === "message" && "message" in entry) this.replayMessage(entry.message);
		else if (entry.type === "custom_message" && "display" in entry) {
			if (entry.display) this.add(customMessage(entry));
		} else if (entry.type === "custom" && "customType" in entry) this.addEntry(entry);
	}

	private replayMessage(message: AgentMessage): void {
		if (message.role === "assistant") {
			this.chat.addChild(this.assistant(message));
			for (const call of message.content) {
				if (call.type !== "toolCall") continue;
				const row = this.toolRow(call.name, call.id, call.arguments);
				if (message.stopReason === "aborted" || message.stopReason === "error")
					row.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? ABORTED_TEXT : message.errorMessage || "Error" }], isError: true });
				else this.pending.set(call.id, row);
			}
			return;
		}
		if (message.role === "toolResult") {
			this.pending.get(message.toolCallId)?.updateResult(message);
			this.pending.delete(message.toolCallId);
			return;
		}
		this.add(message);
	}

	/** 运行中的会话事件；返回是否改了聊天树或组件（调用方据此重绘）。 */
	handle(event: AgentSessionEvent): boolean {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.streaming = this.assistant(event.message, true);
					this.chat.addChild(this.streaming);
				} else this.add(event.message);
				return true;
			case "message_update":
				if (event.message.role !== "assistant") return false;
				// 回合中途打开视图时错过了这条消息的 message_start：在第一次更新时补建。
				if (!this.streaming) {
					this.streaming = this.assistant(event.message, true);
					this.chat.addChild(this.streaming);
				}
				this.streaming.updateContent(event.message, true);
				for (const call of event.message.content) {
					if (call.type !== "toolCall") continue;
					const row = this.pending.get(call.id);
					if (row) row.updateArgs(call.arguments);
					else this.pending.set(call.id, this.toolRow(call.name, call.id, call.arguments));
				}
				return true;
			case "message_end":
				if (!this.streaming || event.message.role !== "assistant") return false;
				this.streaming.updateContent(event.message, false);
				if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
					const text = event.message.stopReason === "aborted" ? ABORTED_TEXT : event.message.errorMessage || "Error";
					for (const row of this.pending.values()) row.updateResult({ content: [{ type: "text", text }], isError: true });
					this.pending.clear();
				} else for (const row of this.pending.values()) row.setArgsComplete();
				this.streaming = undefined;
				return true;
			case "tool_execution_start": {
				if (event.parentToolCallId) return false;
				const row = this.pending.get(event.toolCallId) ?? this.toolRow(event.toolName, event.toolCallId, event.args);
				this.pending.set(event.toolCallId, row);
				row.markExecutionStarted();
				return true;
			}
			case "tool_execution_update":
				this.pending.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				return this.pending.has(event.toolCallId);
			case "tool_execution_end": {
				const row = this.pending.get(event.toolCallId);
				row?.updateResult({ ...event.result, isError: event.isError });
				this.pending.delete(event.toolCallId);
				return row !== undefined;
			}
			case "agent_end":
				if (this.streaming) this.chat.removeChild(this.streaming);
				this.streaming = undefined;
				this.pending.clear();
				return true;
			case "entry_appended":
				if (event.entry.type === "custom") return this.addEntry(event.entry);
				if (event.entry.type !== "custom_message" || !event.entry.display) return false;
				this.add(customMessage(event.entry));
				return true;
			default:
				return false;
		}
	}

	/** 自定义记录（如轮记录）：有渲染器的以宿主 CustomEntry 的同一形态放进聊天树，没有的不显示（与宿主一致）。 */
	private addEntry(entry: { customType: string; data?: unknown; timestamp: string }): boolean {
		const renderer = this.sources.entryRenderer(entry.customType);
		const component = renderer?.(entry as CustomEntry, { expanded: false }, this.sources.theme);
		if (!component) return false;
		this.chat.addChild(entryShell(component));
		return true;
	}

	private add(message: AgentMessage): void {
		if (message.role === "custom") {
			const custom = message as ConstructorParameters<typeof CustomMessageComponent>[0];
			if (!custom.display) return;
			this.chat.addChild(new CustomMessageComponent(custom, this.sources.messageRenderer(custom.customType), getMarkdownTheme()));
			return;
		}
		if (message.role !== "user") return;
		const text = typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		if (!text) return;
		if (this.chat.children.length) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new UserMessageComponent(text, getMarkdownTheme()));
	}

	private assistant(message: AssistantMessage, streaming = false): AssistantMessageComponent {
		const component = new AssistantMessageComponent(message, true, getMarkdownTheme());
		if (streaming) component.updateContent(message, true);
		assistantFacts(component);
		return component;
	}

	private toolRow(name: string, id: string, args: unknown): ToolExecutionComponent {
		const row = new ToolExecutionComponent(name, id, args, {}, this.sources.toolDefinition(name), this.sources.ui, this.sources.cwd);
		toolFacts(row);
		this.chat.addChild(row);
		return row;
	}
}
