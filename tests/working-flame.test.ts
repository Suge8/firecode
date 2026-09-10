import { expect, test } from "bun:test";
import { FLAME_FRAME_COUNT, flameFrameLines, flameFrameWidth } from "../flame-frames.js";
import { flameFitHeight, flameHeightFor, registerWorkingFlame } from "../session/working-flame.js";

const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// Working 行可见性的最终仲裁：审查占用期 agent_end 不得复显 Working...，
// 占用释放且无回合时才复显——这是两模块共写同一开关的竞态回归现场。
test("working line stays hidden while review holds occupancy across turn boundaries", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let occupancy: ((data: { active?: boolean }) => void) | undefined;
	const visible: boolean[] = [];
	const widgets: boolean[] = [];
	registerWorkingFlame({
		on: (name: string, handler: never) => handlers.set(name, handler),
		events: { on: (_name: string, handler: never) => { occupancy = handler; } },
	} as never);
	const ctx = {
		mode: "tui",
		ui: {
			setWorkingVisible: (value: boolean) => visible.push(value),
			setWidget: (_key: string, content: unknown) => widgets.push(Boolean(content)),
		},
	};
	occupancy?.({ active: true });
	await handlers.get("agent_start")?.({}, ctx);
	await handlers.get("agent_end")?.({}, ctx);
	await microtask();
	expect(visible.at(-1)).toBe(false);
	expect(widgets.every((shown) => !shown)).toBe(true);

	occupancy?.({ active: false });
	await microtask();
	expect(visible.at(-1)).toBe(true);
});

test("几何量宽与全帧实际宽度相等，工作和审查尺寸均不改变轮廓", () => {
	for (const height of [...Array.from({ length: 16 }, (_, index) => index + 1), 31]) {
		const actual = Math.max(...Array.from({ length: FLAME_FRAME_COUNT }, (_, frame) =>
			Math.max(...flameFrameLines(height, frame).map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "").length))));
		expect(flameFrameWidth(height)).toBe(actual);
	}
	expect([3, 4, 5, 6, 7, 8, 9, 10].map(flameFrameWidth)).toEqual([5, 6, 8, 9, 11, 12, 14, 15]);
});

test("工作火焰逐行渐进缩放，小窗口保轮廓，大窗口最多七行", () => {
	for (const [rows, height] of [[8, 3], [12, 3], [16, 4], [20, 4], [24, 5], [28, 5], [32, 6], [36, 6], [40, 7], [80, 7]])
		expect(flameHeightFor(rows)).toBe(height);
	expect(flameHeightFor(undefined)).toBe(5);
});

test("宽度查询和逐级适配不生成动画帧，也不淘汰当前尺寸的帧缓存", () => {
	const frame = flameFrameLines(3, 0);
	flameFrameWidth(10);
	expect(flameFrameLines(3, 0)).toBe(frame);
	flameFitHeight(10, flameFrameWidth(3));
	expect(flameFrameLines(3, 0)).toBe(frame);
});

test("flame shrinks to fit narrow widths before hiding", () => {
	expect(flameFitHeight(10, flameFrameWidth(10))).toBe(10);
	const narrow = flameFrameWidth(10) - 1;
	const fitted = flameFitHeight(10, narrow);
	expect(fitted).toBeGreaterThan(0);
	expect(fitted).toBeLessThan(10);
	expect(flameFitHeight(10, 0)).toBe(0);
});

test("退出后丢弃尚未落地的火焰 UI 投影", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const writes: string[] = [];
	registerWorkingFlame({ on: (name: string, handler: never) => handlers.set(name, handler), events: { on() {} } } as never);
	const ctx = { mode: "tui", ui: {
		setWorkingVisible: () => writes.push("working"),
		setWidget: () => writes.push("widget"),
	} };
	handlers.get("agent_start")?.({}, ctx);
	handlers.get("session_shutdown")?.({}, ctx);
	await microtask();
	expect(writes).toEqual([]);
});
