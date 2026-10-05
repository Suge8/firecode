import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule, PI_TUI_URL } from "./loader.js";

type Header = { render(width: number): string[]; dispose?(): void };
type Factory = (tui: { requestRender(): void }, theme: unknown) => Header;

const { visibleWidth } = await import(PI_TUI_URL) as { visibleWidth(text: string): number };

afterEach(() => jest.useRealTimers());
afterAll(cleanupFirecodeModules);

/** 经真实注册入口拿到横幅：session_start 时宿主收到的组件，以及它请求重绘的次数。 */
async function mountHeader() {
	const { registerHeader } = await loadFirecodeModule("header.ts") as { registerHeader(pi: unknown): void };
	let onStart: ((event: unknown, ctx: unknown) => void) | undefined;
	registerHeader({ on: (name: string, handler: never) => { if (name === "session_start") onStart = handler; } });
	let factory: Factory | undefined;
	onStart?.({}, { cwd: "/tmp/project", ui: { setHeader: (next: Factory) => { factory = next; } } });
	const tui = { renders: 0, requestRender() { tui.renders++; } };
	return { header: factory!(tui, {}), tui };
}

test("任意宽度横幅每行都不超出终端宽度，入场中与定格后皆然", async () => {
	jest.useFakeTimers();
	const { header } = await mountHeader();
	for (const elapsed of [0, 400, 900, 3000]) {
		jest.advanceTimersByTime(elapsed);
		for (let width = 20; width <= 200; width++)
			for (const line of header.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	header.dispose?.();
});

test("入场动画驱动重绘，定格后不再请求重绘、画面静止", async () => {
	jest.useFakeTimers();
	const { header, tui } = await mountHeader();
	jest.advanceTimersByTime(500);
	expect(tui.renders).toBeGreaterThan(0);

	jest.advanceTimersByTime(2500);
	const settled = tui.renders;
	const frames = [110, 72, 40].map((width) => header.render(width));
	jest.advanceTimersByTime(3000);
	expect(tui.renders).toBe(settled);
	expect([110, 72, 40].map((width) => header.render(width))).toEqual(frames);
});

test("三档都显示版本与工作目录（同一份来源）；单行档放在字标后的横线里，放不下从开头裁、保留目录尾部", async () => {
	jest.useFakeTimers();
	const { header } = await mountHeader();
	jest.advanceTimersByTime(3000);
	const plain = (width: number) => header.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/gu, "")).join("\n");
	for (const width of [110, 72, 60, 52, 51, 40]) expect(plain(width)).toMatch(/pi \S+ · \/tmp\/project/u);
	const tiny = header.render(40)[0].replace(/\x1b\[[0-9;]*m/gu, "");
	expect(tiny).toMatch(/FireCode .*pi \S+ · \/tmp\/project ─+$/u);
	expect(visibleWidth(tiny)).toBe(40);
	expect(plain(30)).toMatch(/FireCode …\S*project ─+/u);
	header.dispose?.();
});
