/** 过程分组的宿主适配：原始聊天树不变，渲染与鼠标命中共用同一份投影。 */
import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { projectProcessGroups, toggleToolDetails } from "./group-view.js";

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

export function installGroupPatch(ui: ExtensionUIContext): () => void {
	runtime[OWNER]?.();
	let detach = () => {};
	ui.setWidget("firecode-tui-capture", (tui) => {
		detach = attach(tui, ui);
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

function attach(tui: TUI, ui: ExtensionUIContext): () => void {
	const prototype = ToolExecutionComponent.prototype;
	const originalExpand = prototype.setExpanded;
	const originalAdd = Container.prototype.addChild;
	let restoreChat = () => {};
	let attached = false;
	const belongsHere = (row: ToolExecutionComponent) => (row as unknown as { ui: TUI }).ui === tui;
	const setExpanded: typeof originalExpand = function (this: ToolExecutionComponent, value) {
		// 全局展开只控制组摘要/列表；单工具正文通过下方独立的鼠标入口调用原方法。
		originalExpand.call(this, belongsHere(this) ? false : value);
	};
	prototype.setExpanded = setExpanded;

	const discover = () => {
		if (attached) return;
		const chat = findChat(tui);
		if (!chat) return;
		attached = true;
		if (Container.prototype.addChild === addChild) Container.prototype.addChild = originalAdd;
		const render = chat.render;
		const mouse = chat.handleMouse;
		const projection = new Container();
		const toggle = (row: ToolExecutionComponent) => {
			toggleToolDetails(row, originalExpand);
			tui.requestRender();
		};
		chat.render = (width) => {
			projection.children = projectProcessGroups(chat.children, ui, toggle);
			return projection.render(width);
		};
		chat.handleMouse = (event) => projection.handleMouse(event);
		restoreChat = () => {
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
	};
}
