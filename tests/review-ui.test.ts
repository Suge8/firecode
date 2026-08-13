import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type Progress = typeof import("../review/progress.js");

async function loadProgress(): Promise<Progress> {
	return (await loadFirecodeModule("review/progress.js")) as Progress;
}

const reviewers = [{ model: "openai-codex/gpt-5.6-sol" }, { model: "openai-codex/gpt-5.6-luna" }];

afterEach(cleanupFirecodeModules);

describe("reviewer progress derived from subprocess events", () => {
	test("starts every reviewer as running with a readable label", async () => {
		const { initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		expect(progress.map((item) => item.label)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
		expect(progress.every((item) => item.status === "running")).toBe(true);
		expect(progress[0].action).toBe("思考中");
	});

	test("turns tool calls into human actions and counts them per reviewer", async () => {
		const { applyProcessEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applyProcessEvent(
			progress,
			0,
			{ type: "tool_execution_start", toolName: "read", args: { path: "agent/review/state.ts" } },
			"zh",
		);
		progress = applyProcessEvent(
			progress,
			0,
			{ type: "tool_execution_start", toolName: "bash", args: { command: "bun test  x" } },
			"zh",
		);
		expect(progress[0].action).toBe("跑 bun test x");
		expect(progress[0].toolCalls).toBe(2);
		expect(progress[0].trail).toEqual(["读 review/state.ts", "跑 bun test x"]);
		// 其他审查者不受影响
		expect(progress[1].toolCalls).toBe(0);
	});

	test("ignores non-tool events so the bar does not churn", async () => {
		const { applyProcessEvent, initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		const next = applyProcessEvent(progress, 0, { type: "message_update" }, "zh");
		expect(next).toBe(progress);
	});

	test("settling replaces the action with the verdict", async () => {
		const { initialProgress, settleProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = settleProgress(progress, 1, "failed", "zh");
		expect(progress[1].status).toBe("failed");
		expect(progress[1].action).toBe("发现问题");
		expect(progress[0].status).toBe("running");
	});
});

describe("review editor locks input and routes control keys", () => {
	// 用户实际踩到的回归：审查中还能打字、esc 拦不住。
	// 编辑器是输入第一落点，这里直接实例化真实组件驱动按键。
	async function makeEditor(language: "zh" | "en" = "zh") {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			lockEditor: (ctx: unknown, view: unknown, cancel: () => void) => void;
			unlockEditor: (ctx: unknown) => void;
		};
		const events: string[] = [];
		let factory: ((tui: unknown, theme: unknown, keys: unknown) => unknown) | undefined;
		const ctx = {
			ui: {
				setEditorComponent: (next?: (tui: unknown, theme: unknown, keys: unknown) => unknown) => {
					factory = next;
				},
				custom: async () => undefined,
			},
		};
		ui.lockEditor(ctx, () => ({ language, phase: "reviewing", round: 1 }), () =>
			events.push("cancel"),
		);
		const tui = { requestRender: () => {}, addInputListener: () => () => {} };
		const theme = { borderColor: (text: string) => text, selectList: {} };
		const keys = { matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" };
		const editor = factory?.(tui, theme, keys) as {
			handleInput: (data: string) => void;
			render: (width: number) => string[];
			getText: () => string;
		};
		return { editor, events, ctx, ui, hasFactory: () => factory !== undefined };
	}

	test("typing does not reach the editor buffer", async () => {
		const { editor } = await makeEditor();
		editor.handleInput("这段字不该出现");
		expect(editor.getText()).toBe("");
	});

	test("escape triggers cancel exactly once per press", async () => {
		const { editor, events } = await makeEditor();
		editor.handleInput("\x1b");
		expect(events).toEqual(["cancel"]);
	});

	test("renders a paused-input hint in the configured language", async () => {
		const { editor } = await makeEditor("en");
		expect(editor.render(80)[0]).toContain("input paused");
	});

	test("unlock restores the default editor", async () => {
		const { ctx, ui, hasFactory } = await makeEditor();
		expect(hasFactory()).toBe(true);
		ui.unlockEditor(ctx);
		expect(hasFactory()).toBe(false);
	});
});
