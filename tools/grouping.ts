/** 过程分组的安装：原始聊天树不变，渲染与鼠标命中共用同一份投影；宿主私有细节全部经 host.ts。 */
import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { onFrame } from "../flame.js";
import { isMachineMessage, projectProcessGroups, toggleToolDetails, type ProjectionEnv } from "./group-view.js";
import { assistantFacts, captureTui, findChat, HostShapeError, patchMethod, rowUiOf, scrollViewOf, toolFacts } from "./host.js";
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
	let abandoned = false;
	/** 自检、渲染、点击或全局展开时发现宿主形状不符：整体退回原生显示并明确提示一次，不悄悄画错。 */
	const abandon = (error: HostShapeError) => {
		detach();
		if (abandoned) return;
		abandoned = true;
		ui.notify(error.message, "warning");
	};
	/** 宿主调进来的每个入口都经这里：形状不符就退回原生，再按原生行为完成这次调用。 */
	const guarded = <T>(run: () => T, native: () => T): T => {
		try {
			return run();
		} catch (error) {
			if (!(error instanceof HostShapeError)) throw error;
			abandon(error);
			return native();
		}
	};
	// 归属只比对 TUI 引用，不校验别的 TUI 的工具行形状。
	const belongsHere = (row: ToolExecutionComponent) => rowUiOf(row) === tui;
	// 全局展开只控制组摘要/列表；单工具正文通过下方独立的鼠标入口调用原方法。
	restores.push(patchMethod(ToolExecutionComponent.prototype, "setExpanded", function (this: ToolExecutionComponent, value) {
		originalExpand.call(this, belongsHere(this) ? false : value);
	}));
	// 机器消息的原生卡片只由点击那一行打开；全局展开不平铺它（其余 CustomMessage 照旧跟随全局）。
	restores.push(patchMethod(CustomMessageComponent.prototype, "setExpanded", function (this: CustomMessageComponent, value) {
		const target = guarded(() => (isMachineMessage(this) ? false : value), () => value);
		originalMessageExpand.call(this, target);
	}));

	const install = (chat: Container) => {
		const render = chat.render;
		const mouse = chat.handleMouse;
		const projection = new Container();
		const overrides = new Set<object>();
		let lastExpanded = ui.getToolsExpanded();
		/**
		 * 点击展开/收起时被点的那一行留在视口原位：跟随末尾的滚动视图会把下方新增的内容顶上来、把被点的行滚出屏幕，
		 * 所以点击当下就地停住滚动位置（被点行之上的内容不变，它在视口里的位置也就不变）；用户滚回底部即恢复跟随。
		 */
		const holdViewport = () => {
			const view = scrollViewOf(tui, chat);
			view?.scrollTo(view.scrollTop, { disableFollow: true });
		};
		const env: ProjectionEnv = {
			ui, clock: options.clock, replyLines: options.replyLines, headless: {},
			toggleRow: (row) => {
				holdViewport();
				toggleToolDetails(row, originalExpand);
				tui.requestRender();
			},
			isOpen: (key) => overrides.has(key),
			toggleOpen: (key) => {
				holdViewport();
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
			return guarded(() => {
				const { nodes, animating } = projectProcessGroups(chat.children, env);
				projection.children = nodes;
				// 动效只经全局时钟：有活的摘要才订阅，静止即取消。
				if (animating && !stopFrames) stopFrames = onFrame(() => tui.requestRender());
				else if (!animating && stopFrames) { stopFrames(); stopFrames = undefined; }
				return projection.render(width);
			}, () => render.call(chat, width));
		};
		chat.handleMouse = (event) => guarded(() => projection.handleMouse(event), () => mouse.call(chat, event));
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
		const healthy = guarded(() => {
			for (const child of trigger ? [trigger, ...chat.children] : chat.children) checkShape(child);
			return true;
		}, () => false);
		if (healthy) install(chat);
	};
	// 宿主没有聊天容器句柄；首条用户消息、助手或工具插入时定位（首条用户消息一出现就带竖条），随后立即卸掉发现钩子。
	const removeHook = patchMethod(Container.prototype, "addChild", function (this: Container, child: Component) {
		originalAdd.call(this, child);
		if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent
			|| (child instanceof ToolExecutionComponent && rowUiOf(child) === tui)) discover(child);
	});
	restores.push(removeHook);
	discover();
	return detach;
}

