/** 过程分组的安装：原始聊天树不变，渲染与鼠标命中共用同一份投影；宿主私有细节全部经 host.ts。 */
import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { onFrame } from "../flame.js";
import { isMachineMessage, projectProcessGroups, toggleToolDetails, type ProjectionEnv } from "./group-view.js";
import { assistantFacts, captureTui, findChat, HostShapeError, patchMethod, rowUiOf, toolFacts } from "./host.js";
import type { TurnClock } from "./turn-clock.js";

const OWNER = Symbol.for("pi.firecode.tool-groups");
const runtime = globalThis as typeof globalThis & { [OWNER]?: () => void };

export interface GroupOptions {
	replyLines: number;
	clock: TurnClock;
}

export function installGroupPatch(ui: ExtensionUIContext, options: GroupOptions): () => void {
	runtime[OWNER]?.();
	let detach = () => {};
	captureTui(ui, (tui) => {
		detach = attach(tui, ui, options);
	});
	const dispose = () => {
		if (runtime[OWNER] !== dispose) return;
		detach();
		delete runtime[OWNER];
	};
	runtime[OWNER] = dispose;
	return dispose;
}

/** 首个真实实例的形状自检：私有字段改名或换型就不安装。 */
function checkShape(child: Component): void {
	if (child instanceof ToolExecutionComponent) toolFacts(child);
	if (child instanceof AssistantMessageComponent) assistantFacts(child);
}

function attach(tui: TUI, ui: ExtensionUIContext, options: GroupOptions): () => void {
	const originalExpand = ToolExecutionComponent.prototype.setExpanded;
	const originalMessageExpand = CustomMessageComponent.prototype.setExpanded;
	const originalAdd = Container.prototype.addChild;
	const restores: (() => void)[] = [];
	let stopFrames: (() => void) | undefined;
	let attached = false;
	const detach = () => {
		stopFrames?.();
		stopFrames = undefined;
		for (const restore of restores.splice(0).reverse()) restore();
	};
	/** 自检或渲染时发现宿主形状不符：整体退回原生显示并明确提示，不悄悄画错。 */
	const abandon = (error: HostShapeError) => {
		detach();
		ui.notify(error.message, "warning");
	};
	const belongsHere = (row: ToolExecutionComponent) => toolFacts(row).ui === tui;
	// 全局展开只控制组摘要/列表；单工具正文通过下方独立的鼠标入口调用原方法。
	restores.push(patchMethod(ToolExecutionComponent.prototype, "setExpanded", function (this: ToolExecutionComponent, value) {
		originalExpand.call(this, belongsHere(this) ? false : value);
	}));
	// 机器消息的原生卡片只由点击那一行打开；全局展开不平铺它（其余 CustomMessage 照旧跟随全局）。
	restores.push(patchMethod(CustomMessageComponent.prototype, "setExpanded", function (this: CustomMessageComponent, value) {
		originalMessageExpand.call(this, isMachineMessage(this) ? false : value);
	}));

	const install = (chat: Container) => {
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
			try {
				const { nodes, animating } = projectProcessGroups(chat.children, env);
				projection.children = nodes;
				// 动效只经全局时钟：有活的摘要才订阅，静止即取消。
				if (animating && !stopFrames) stopFrames = onFrame(() => tui.requestRender());
				else if (!animating && stopFrames) { stopFrames(); stopFrames = undefined; }
				return projection.render(width);
			} catch (error) {
				if (!(error instanceof HostShapeError)) throw error;
				abandon(error);
				return render.call(chat, width);
			}
		};
		chat.handleMouse = (event) => projection.handleMouse(event);
		restores.push(() => {
			chat.render = render;
			chat.handleMouse = mouse;
		});
	};
	const discover = (trigger?: Component) => {
		if (attached) return;
		const chat = findChat(tui);
		if (!chat) return;
		attached = true;
		removeHook();
		try {
			for (const child of trigger ? [trigger, ...chat.children] : chat.children) checkShape(child);
		} catch (error) {
			if (!(error instanceof HostShapeError)) throw error;
			return abandon(error);
		}
		install(chat);
	};
	// 宿主没有聊天容器句柄；只在首个助手或工具插入时定位，随后立即卸掉发现钩子。
	const removeHook = patchMethod(Container.prototype, "addChild", function (this: Container, child: Component) {
		originalAdd.call(this, child);
		if (child instanceof AssistantMessageComponent || (child instanceof ToolExecutionComponent && rowUiOf(child) === tui)) discover(child);
	});
	restores.push(removeHook);
	discover();
	return detach;
}

