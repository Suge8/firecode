/**
 * 连续工具行的视觉合并：pi 原生每行前有一个空行，相邻的装饰行去掉它即可连成一条轨道。
 * 实现依赖 pi 内部的组件树与原型，属于与宿主耦合最紧的一块，单独隔离在此文件。
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const GROUP_PATCH = Symbol.for("pi.firecode.group-patch");
const REQUEST_RENDER_PATCH = Symbol.for("pi.firecode.request-render-patch");
const GLOBAL_STATE = Symbol.for("pi.firecode.tools-state");

type RenderFunction = (width: number) => string[];
type RequestRenderFunction = (force?: boolean) => unknown;
type ToolRow = { toolName: unknown; setExpanded: unknown; render: RenderFunction };
type ToolRowPatch = { original: RenderFunction; patched: RenderFunction };
type ToolRowPrototype = ToolRow & { [GROUP_PATCH]?: ToolRowPatch };
type RequestRenderPatch = { original: RequestRenderFunction; patched: RequestRenderFunction };
type ContainerLike = { children: unknown[] };
type TuiLike = {
	requestRender: RequestRenderFunction;
	children?: unknown[];
	[REQUEST_RENDER_PATCH]?: RequestRenderPatch;
};
type GlobalState = {
	tui?: TuiLike;
	chat?: ContainerLike;
	indexedChildren?: unknown[];
	indexedLength?: number;
	joinedRows?: WeakSet<object>;
	patchedPrototype?: ToolRowPrototype;
	patchErrorReported?: boolean;
	decorated: Set<string>;
};

// 扩展热重载会重新执行模块，patch 状态必须挂在全局才能正确卸载。
const runtimeGlobal = globalThis as typeof globalThis & { [GLOBAL_STATE]?: GlobalState };
const globalState = (runtimeGlobal[GLOBAL_STATE] ??= { decorated: new Set<string>() });

function isToolRow(value: unknown): value is ToolRow {
	if (!value || typeof value !== "object") return false;
	const row = value as ToolRow;
	return typeof row.render === "function" && typeof row.setExpanded === "function" && "toolName" in row;
}

function isDecoratedToolRow(value: unknown): value is ToolRow {
	return (
		isToolRow(value) &&
		typeof value.toolName === "string" &&
		globalState.decorated.has(value.toolName)
	);
}

function findChatContainer(value: unknown, seen = new Set<unknown>()): ContainerLike | undefined {
	if (!value || typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	const children = (value as ContainerLike).children;
	if (!Array.isArray(children)) return undefined;
	if (children.some(isToolRow)) return value as ContainerLike;
	for (const child of children) {
		const found = findChatContainer(child, seen);
		if (found) return found;
	}
	return undefined;
}

/** 增量标记"紧跟另一条装饰行"的行，聊天记录只增不改，可以从上次位置续算。 */
function indexJoinedRows(children: unknown[]): void {
	const canAppend =
		globalState.indexedChildren === children &&
		globalState.indexedLength !== undefined &&
		globalState.indexedLength <= children.length &&
		globalState.joinedRows !== undefined;
	const joinedRows =
		canAppend && globalState.joinedRows ? globalState.joinedRows : new WeakSet<object>();
	const start = canAppend ? Math.max(1, globalState.indexedLength ?? 1) : 1;
	for (let index = start; index < children.length; index++) {
		const current = children[index];
		if (isDecoratedToolRow(current) && isDecoratedToolRow(children[index - 1]))
			joinedRows.add(current);
	}
	globalState.indexedChildren = children;
	globalState.indexedLength = children.length;
	globalState.joinedRows = joinedRows;
}

function followsToolRow(row: ToolRow): boolean {
	if (!globalState.chat) globalState.chat = findChatContainer(globalState.tui);
	const children = globalState.chat?.children;
	if (!children) return false;
	if (globalState.indexedChildren !== children || globalState.indexedLength !== children.length)
		indexJoinedRows(children);
	return globalState.joinedRows?.has(row) ?? false;
}

function patchToolRows(): void {
	if (globalState.patchedPrototype) return;
	const chat = globalState.chat ?? findChatContainer(globalState.tui);
	if (!chat) return;
	globalState.chat = chat;
	const row = chat.children.find(isToolRow);
	if (!row) return;
	const prototype = Object.getPrototypeOf(row) as ToolRowPrototype;
	if (prototype[GROUP_PATCH]) {
		globalState.patchedPrototype = prototype;
		return;
	}
	const original = prototype.render;
	const patched: RenderFunction = function (this: ToolRow, width: number): string[] {
		const lines = original.call(this, width);
		return followsToolRow(this) && lines[0] === "" ? lines.slice(1) : lines;
	};
	Object.defineProperty(prototype, GROUP_PATCH, {
		configurable: true,
		value: { original, patched } satisfies ToolRowPatch,
	});
	prototype.render = patched;
	globalState.patchedPrototype = prototype;
}

export function installGroupPatch(ui: ExtensionUIContext, decorated: Set<string>): void {
	globalState.decorated = decorated;
	globalState.patchErrorReported = false;
	// 借一次 widget 生命周期拿到 tui 实例，拿到即注销。
	ui.setWidget("firecode-tui-capture", (tui) => {
		const patchableTui = tui as TuiLike;
		globalState.tui = patchableTui;
		globalState.chat = undefined;
		globalState.indexedChildren = undefined;
		globalState.joinedRows = undefined;
		if (!patchableTui[REQUEST_RENDER_PATCH]) {
			const original = patchableTui.requestRender;
			const patched: RequestRenderFunction = (force) => {
				try {
					patchToolRows();
				} catch (error) {
					if (!globalState.patchErrorReported) {
						globalState.patchErrorReported = true;
						ui.notify(
							`工具轨道连接失败：${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}
				return original.call(patchableTui, force);
			};
			Object.defineProperty(patchableTui, REQUEST_RENDER_PATCH, {
				configurable: true,
				value: { original, patched } satisfies RequestRenderPatch,
			});
			patchableTui.requestRender = patched;
		}
		patchToolRows();
		return { render: () => [], invalidate: () => {} };
	});
	ui.setWidget("firecode-tui-capture", undefined);
}

export function uninstallGroupPatch(): void {
	const tui = globalState.tui;
	const requestPatch = tui?.[REQUEST_RENDER_PATCH];
	if (tui && requestPatch && tui.requestRender === requestPatch.patched) {
		tui.requestRender = requestPatch.original;
		delete tui[REQUEST_RENDER_PATCH];
	}

	const prototype = globalState.patchedPrototype;
	const rowPatch = prototype?.[GROUP_PATCH];
	if (prototype && rowPatch && prototype.render === rowPatch.patched) {
		prototype.render = rowPatch.original;
		delete prototype[GROUP_PATCH];
	}

	globalState.tui = undefined;
	globalState.chat = undefined;
	globalState.indexedChildren = undefined;
	globalState.indexedLength = undefined;
	globalState.joinedRows = undefined;
	globalState.patchedPrototype = undefined;
	globalState.patchErrorReported = false;
}
