/**
 * 工作期间在编辑器上方居中显示火焰，审查占用时退让，组件 dispose 停止动画。
 * Review 也会写 Working 行的可见性；本模块在同一同步调度链收尾后统一投影，
 * 避免审查占用期间被 agent_end 的写入重新打开。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { FLAME_FRAME_COUNT, flameFrameLines, flameFrameWidth } from "../flame-frames.js";

const WIDGET_KEY = "firecode-working-flame";
const FRAME_MS = 100;
const MAX_HEIGHT = 7;
const DEFAULT_HEIGHT = 5;
const HEIGHT_STEP_ROWS = 8;
const HEIGHT_OFFSET = 2;
const MIN_HEIGHT = 3;

/** 逐行增长，小窗口保轮廓，大窗口少占空间；未知尺寸用中等高度。 */
export function flameHeightFor(terminalRows: number | undefined): number {
	if (!terminalRows || !Number.isFinite(terminalRows)) return DEFAULT_HEIGHT;
	return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(terminalRows / HEIGHT_STEP_ROWS) + HEIGHT_OFFSET));
}

/** 宽度自适应：装不下就逐级降高（火焰宽随高缩），实在不行才隐藏。 */
export function flameFitHeight(height: number, width: number): number {
	for (let fit = height; fit >= MIN_HEIGHT; fit -= 1) {
		if (flameFrameWidth(fit) <= width) return fit;
	}
	return 0;
}

export function registerWorkingFlame(pi: ExtensionAPI): void {
	let turnActive = false;
	let reviewHeld = false;
	let ui: ExtensionContext["ui"] | undefined;
	let pending = false;

	const apply = () => {
		pending = false;
		if (!ui) return;
		// Working 行：回合内由大火焰替代，审查占用期由审查活动条替代，两者都不在才复显。
		ui.setWorkingVisible(!turnActive && !reviewHeld);
		if (turnActive && !reviewHeld)
			ui.setWidget(
				WIDGET_KEY,
				(tui: TUI) => new WorkingFlame(tui, () => tui.requestRender()),
				{ placement: "aboveEditor" },
			);
		else ui.setWidget(WIDGET_KEY, undefined);
	};
	/** 微任务合并：同一调度链内的多个事件只落地一次，且排在 review 的同步写入之后。 */
	const sync = () => {
		if (pending) return;
		pending = true;
		queueMicrotask(apply);
	};

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		turnActive = true;
		sync();
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		turnActive = false;
		sync();
	});
	pi.on("session_shutdown", () => {
		ui = undefined;
		turnActive = false;
		reviewHeld = false;
	});
	// 审查占用频道（review 模块发布）：审查活跃期活动条自带火焰，大火焰退让避免双火同烧。
	pi.events.on("herdr:blocked", (data) => {
		reviewHeld = Boolean((data as { active?: boolean } | undefined)?.active);
		sync();
	});
}

/** 居中的多行火焰；素材自带 ANSI 颜色与行尾复位。 */
class WorkingFlame implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		requestRender: () => void,
	) {
		this.timer = setInterval(() => {
			this.frame += 1;
			requestRender();
		}, FRAME_MS);
		this.timer.unref();
	}

	render(width: number): string[] {
		const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
		const height = flameFitHeight(flameHeightFor(rows), Math.max(0, width));
		if (height === 0) return [];
		const flameWidth = flameFrameWidth(height);
		const indent = " ".repeat(Math.max(0, Math.floor((width - flameWidth) / 2)));
		return flameFrameLines(height, this.frame % FLAME_FRAME_COUNT).map(
			(line) => `${indent}${line}`,
		);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
