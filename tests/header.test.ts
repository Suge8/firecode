import { afterEach, expect, jest, test } from "bun:test";
import { loadFirecodeModule, PI_TUI_URL } from "./loader.js";
import { fakePi } from "./fake-pi.ts";

type Header = { render(width: number): string[]; dispose(): void };
type Factory = (tui: { requestRender(): void }, theme: unknown) => Header;

const { visibleWidth } = await import(PI_TUI_URL) as { visibleWidth(text: string): number };

// 独立配置让 loader 创建专属副本，避免 fake timers 接到其他套件已启动的真实动画时钟。
const configJsonc = JSON.stringify({
	features: {
		header: true,
		statusbar: false,
		tools: false,
		stats: false,
		claudeSub: false,
		claudeFiles: false,
		openaiNative: false,
		review: false,
		master: false,
	},
});
const mounted: Header[] = [];

afterEach(() => {
	for (const header of mounted.splice(0)) header.dispose();
	jest.useRealTimers();
});
/** 经真实注册入口拿到横幅：session_start 时宿主收到的组件，以及它请求重绘的次数。 */
async function mountHeader(cwd = "/tmp/project") {
	const { registerHeader } = await loadFirecodeModule("header.ts", { configJsonc }) as { registerHeader(pi: unknown): void };
	const fake = fakePi();
	registerHeader(fake.pi);
	let factory: Factory | undefined;
	void fake.fire("session_start", {}, { cwd, ui: { setHeader: (next: Factory) => { factory = next; } } });
	const tui = { renders: 0, requestRender() { tui.renders++; } };
	const header = factory!(tui, {});
	mounted.push(header);
	return { header, tui };
}

test("任意宽度横幅每行都不超出终端宽度（宿主遇到超宽行会崩），入场中与定格后皆然，且显示工作目录", async () => {
	jest.useFakeTimers();
	const { header } = await mountHeader();
	for (const elapsed of [0, 400, 900, 3000]) {
		jest.advanceTimersByTime(elapsed);
		for (let width = 20; width <= 200; width++)
			for (const line of header.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	expect(header.render(110).join("\n").replace(/\x1b\[[0-9;]*m/gu, "")).toContain("/tmp/project");
});
