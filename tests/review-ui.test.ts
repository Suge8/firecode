import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

// 审查可能跑很久：切模型、退出这类应用级按键和扩展快捷键不能被一并锁死。
test("审查锁住输入框时，应用级按键与扩展快捷键照常生效，打字被吞掉", async () => {
	const { ReviewUi } = await loadFirecodeModule("review/ui.js") as any;
	const installed: any[] = [];
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionName: () => undefined, getCwd: () => "/tmp/project" },
		ui: { setTitle: () => {}, getEditorComponent: () => undefined, setEditorComponent: (next: unknown) => installed.push(next) },
	};
	const cancelled: string[] = [];
	new ReviewUi().show(ctx, 1, true, () => cancelled.push("cancel"));
	const editor = installed[0](
		{ requestRender: () => {}, terminal: { rows: 40 } },
		{ borderColor: (text: string) => text, selectList: {} },
		{
			matches: (data: string, action: string) => ({ "\x1b": "app.interrupt", "\x0e": "app.model.cycleForward", "\x04": "app.exit" } as Record<string, string>)[data] === action,
			getKeys: (action: string) => (action === "app.interrupt" ? ["escape"] : []),
		},
	);
	const calls: string[] = [];
	editor.actionHandlers.set("app.model.cycleForward", () => calls.push("model"));
	editor.onExtensionShortcut = (data: string) => { if (data === "\x07") calls.push("shortcut"); return data === "\x07"; };
	editor.onCtrlD = () => calls.push("exit");
	for (const key of ["这段字不该出现", "\x0e", "\x07", "\x04"]) editor.handleInput(key);
	expect(calls).toEqual(["model", "shortcut", "exit"]);
	expect(cancelled).toEqual([]);
	expect(editor.getText()).toBe("");
});
