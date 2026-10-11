import { describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

describe("review editor lock", () => {
	const tui = { requestRender: () => {}, terminal: { rows: 40 } };
	const theme = { borderColor: (text: string) => text, selectList: {} };
	const keys = {
		matches: (data: string, action: string) => ({ "\x1b": "app.interrupt", "\x0e": "app.model.cycleForward", "\x04": "app.exit" })[data] === action,
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

	test("typing and submitting are swallowed, esc cancels, and the hint names the configured key", async () => {
		const { editor, cancelled } = await lock();
		editor.handleInput("这段字不该出现");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b");
		expect(cancelled).toEqual(["cancel"]);
		const custom = await lock(undefined, { ...keys, getKeys: () => ["ctrl+c"] });
		expect(custom.editor.render(80)[1].replace(/\x1b\[[0-9;]*m/gu, "")).toContain("ctrl+c 取消");
	});

	// 审查可能跑很久：切模型、退出这类应用级按键和扩展快捷键不能被一并锁死。
	test("app-level keys and extension shortcuts keep working while the text input is locked", async () => {
		const { editor, cancelled } = await lock();
		const calls: string[] = [];
		editor.actionHandlers.set("app.model.cycleForward", () => calls.push("model"));
		editor.onExtensionShortcut = (data: string) => { if (data === "\x07") calls.push("shortcut"); return data === "\x07"; };
		editor.onCtrlD = () => calls.push("exit");
		editor.handleInput("\x0e");
		editor.handleInput("\x07");
		editor.handleInput("\x04");
		expect(calls).toEqual(["model", "shortcut", "exit"]);
		expect(cancelled).toEqual([]);
		expect(editor.getText()).toBe("");
	});

	test("unlocking restores the custom editor that was in place, or the default one when there was none", async () => {
		const custom = () => ({});
		const first = await lock(custom);
		first.unlock();
		expect(first.installed.at(-1)).toBe(custom);
		const second = await lock(undefined);
		second.unlock();
		expect(second.installed.at(-1)).toBeUndefined();
	});
});
