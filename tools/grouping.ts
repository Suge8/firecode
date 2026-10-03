/** 过程分组的宿主适配：原始聊天树不变，渲染与鼠标命中共用同一份投影。 */
import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { onFrame } from "../flame.js";
import { isMachineMessage, projectProcessGroups, toggleToolDetails, type ProjectionEnv } from "./group-view.js";
import type { TurnClock } from "./turn-clock.js";

const OWNER = Symbol.for("pi.firecode.tool-groups");
const runtime = globalThis as typeof globalThis & { [OWNER]?: () => void };

function findChat(value: Component): Container | undefined {
	if (!(value instanceof Container)) return undefined;
	if (value.children.some((child) => child instanceof ToolExecutionComponent || child instanceof AssistantMessageComponent)) return value;
	for (const child of value.children) {
		const found = findChat(child);
		if (found) return found;
	}
	return undefined;
}

export interface GroupOptions {
	replyLines: number;
	clock: TurnClock;
}

export function installGroupPatch(ui: ExtensionUIContext, options: GroupOptions): () => void {
	runtime[OWNER]?.();
	let detach = () => {};
	ui.setWidget("firecode-tui-capture", (tui) => {
		detach = attach(tui, ui, options);
		return { render: () => [], invalidate() {} };
	});
	ui.setWidget("firecode-tui-capture", undefined);
	const dispose = () => {
		if (runtime[OWNER] !== dispose) return;
		detach();
		delete runtime[OWNER];
	};
	runtime[OWNER] = dispose;
	return dispose;
}

function attach(tui: TUI, ui: ExtensionUIContext, options: GroupOptions): () => void {
	const prototype = ToolExecutionComponent.prototype;
	const originalExpand = prototype.setExpanded;
	const originalAdd = Container.prototype.addChild;
	let restoreChat = () => {};
	let stopFrames: (() => void) | undefined;
	let attached = false;
	const belongsHere = (row: ToolExecutionComponent) => (row as unknown as { ui: TUI }).ui === tui;
	const setExpanded: typeof originalExpand = function (this: ToolExecutionComponent, value) {
		// 全局展开只控制组摘要/列表；单工具正文通过下方独立的鼠标入口调用原方法。
		originalExpand.call(this, belongsHere(this) ? false : value);
	};
	prototype.setExpanded = setExpanded;
	// 机器消息的原生卡片只由点击那一行打开；全局展开不平铺它（其余 CustomMessage 照旧跟随全局）。
	const messagePrototype = CustomMessageComponent.prototype;
	const originalMessageExpand = messagePrototype.setExpanded;
	const setMessageExpanded: typeof originalMessageExpand = function (this: CustomMessageComponent, value) {
		originalMessageExpand.call(this, isMachineMessage(this) ? false : value);
	};
	messagePrototype.setExpanded = setMessageExpanded;

	const discover = () => {
		if (attached) return;
		const chat = findChat(tui);
		if (!chat) return;
		attached = true;
		if (Container.prototype.addChild === addChild) Container.prototype.addChild = originalAdd;
		const render = chat.render;
		const mouse = chat.handleMouse;
		const projection = new Container();
		const overrides = new Set<object>();
		let lastExpanded = ui.getToolsExpanded();
		const env: ProjectionEnv = {
			ui, clock: options.clock, replyLines: options.replyLines, headless: {},
			toggleRow: (row) => {
				toggleToolDetails(row, originalExpand);
				tui.requestRender();
			},
			isOpen: (key) => overrides.has(key),
			toggleOpen: (key) => {
				const opening = !overrides.delete(key);
				if (opening) overrides.add(key);
				if (key instanceof CustomMessageComponent) originalMessageExpand.call(key, opening);
				tui.requestRender();
			},
		};
		chat.render = (width) => {
			// ctrl+o 永远是全部展开/全部折叠：全局档位一变，逐轮覆盖与被点开的原生卡片一并复位。
			if (ui.getToolsExpanded() !== lastExpanded) {
				lastExpanded = ui.getToolsExpanded();
				for (const key of overrides) if (key instanceof CustomMessageComponent) originalMessageExpand.call(key, false);
				overrides.clear();
			}
			const { nodes, animating } = projectProcessGroups(chat.children, env);
			projection.children = nodes;
			// 动效只经全局时钟：有活的摘要才订阅，静止即取消。
			if (animating && !stopFrames) stopFrames = onFrame(() => tui.requestRender());
			else if (!animating && stopFrames) { stopFrames(); stopFrames = undefined; }
			return projection.render(width);
		};
		chat.handleMouse = (event) => projection.handleMouse(event);
		restoreChat = () => {
			stopFrames?.();
			chat.render = render;
			chat.handleMouse = mouse;
		};
	};
	// 宿主没有聊天容器句柄；只在首个助手或工具插入时定位，随后立即卸掉发现钩子。
	const addChild: Container["addChild"] = function (this: Container, child) {
		originalAdd.call(this, child);
		if (child instanceof AssistantMessageComponent || (child instanceof ToolExecutionComponent && belongsHere(child))) discover();
	};
	Container.prototype.addChild = addChild;
	discover();
	return () => {
		restoreChat();
		if (Container.prototype.addChild === addChild) Container.prototype.addChild = originalAdd;
		if (prototype.setExpanded === setExpanded) prototype.setExpanded = originalExpand;
		if (messagePrototype.setExpanded === setMessageExpanded) messagePrototype.setExpanded = originalMessageExpand;
	};
}
