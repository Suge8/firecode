import { describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

describe("review editor lock", () => {
	const tui = { requestRender: () => {}, terminal: { rows: 40 } };
	const theme = { borderColor: (text: string) => text, selectList: {} };
	const keys = {
		matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b",
		getKeys: (action: string) => (action === "app.interrupt" ? ["escape"] : []),
	};

	async function lock(previous?: unknown, bindings = keys) {
		const { ReviewUi } = await loadFirecodeModule("review/ui.js") as any;
		const installed: unknown[] = [];
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionName: () => undefined, getCwd: () => "/tmp/project" },
			ui: { setTitle: () => {}, getEditorComponent: () => previous, setEditorComponent: (next: unknown) => installed.push(next) },
		};
		const cancelled: string[] = [];
		const ui = new ReviewUi();
		ui.show(ctx, 1, true, () => cancelled.push("cancel"));
		const editor = (installed[0] as any)(tui, theme, bindings);
		return { editor, unlock: () => ui.clear(ctx), installed, cancelled };
	}

	test("输入不进缓冲区，esc 立即取消", async () => {
		const { editor, cancelled } = await lock();
		editor.handleInput("这段字不该出现");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b");
		expect(cancelled).toEqual(["cancel"]);
	});

	test("锁定期间输入区收起成一行暗色提示，快捷键文案取自 keybindings", async () => {
		const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/gu, "");
		const { editor } = await lock();
		const lines = editor.render(80);
		expect(lines).toHaveLength(3);
		expect(plain(lines[1]).trim()).toBe("审查进行中 · esc 取消");
		const custom = await lock(undefined, { ...keys, getKeys: () => ["ctrl+c"] });
		expect(plain(custom.editor.render(80)[1])).toContain("ctrl+c 取消");
		expect(plain(editor.render(12)[1]).length).toBeLessThanOrEqual(12);
	});

	test("解锁恢复锁定前的自定义编辑器，没有自定义编辑器则恢复默认", async () => {
		const custom = () => ({});
		const first = await lock(custom);
		first.unlock();
		expect(first.installed.at(-1)).toBe(custom);
		const second = await lock(undefined);
		second.unlock();
		expect(second.installed.at(-1)).toBeUndefined();
	});
});
