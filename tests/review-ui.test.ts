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

	test("tracks tool completion and token usage for the pi-flow monitor", async () => {
		const { applyProcessEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applyProcessEvent(progress, 0, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "review/state.ts" },
		}, "zh");
		progress = applyProcessEvent(progress, 0, {
			type: "tool_execution_end",
			toolCallId: "call-1",
		}, "zh");
		progress = applyProcessEvent(progress, 0, {
			type: "message_end",
			message: { usage: { totalTokens: 1250 } },
		}, "zh");
		expect(progress[0].activeTools).toEqual([]);
		expect(progress[0].recentTools[0]).toMatchObject({ tool: "read", args: "review/state.ts" });
		expect(progress[0].tokens).toBe(1250);
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

describe("review activity layout", () => {
	test("matches the pi-flow bordered quality box with flame, rows, and hint", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "gpt-5.6-sol", status: "running", action: "思考中", toolCalls: 0, trail: [] },
					{ index: 1, label: "gpt-5.6-terra", status: "passed", action: "通过", toolCalls: 3, trail: [] },
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {} },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(64) ?? [];
		const output = lines.join("\n");
		expect(output).toContain("💯 审查中");
		expect(output).toContain("gpt-5.6-sol");
		expect(output).toContain("✅ gpt-5.6-terra");
		expect(output).toContain("Esc/Ctrl+C 取消 · Alt+S 详情");
		expect(lines[0].replace(/\x1b\[[0-9;]*m/gu, "")).toBe("─".repeat(64));
		expect(lines.at(-1)?.replace(/\x1b\[[0-9;]*m/gu, "")).toBe("─".repeat(64));
		component?.dispose();
	});

	test("advisor verdict summary stays visible in the repair phase activity bar", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		const renderWith = (progressKind: string | undefined, summary: string) => {
			ui.showActivity(
				{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
				() => ({
					phase: "awaiting_fix",
					round: 2,
					focus: "",
					roundStartedAt: 0,
					advisorRunning: false,
					language: "zh",
					progressKind,
					reviewers: [{ index: 0, label: "claude-fable-5", status: "passed", action: "通过", summary, toolCalls: 1, trail: [] }],
				}),
			);
			const component = factory?.({ requestRender: () => {} }, { fg: (_tone: string, text: string) => text });
			const output = (component?.render(80) ?? []).join("\n");
			component?.dispose();
			return output;
		};
		// 顾问落定与进入修复相在同一微任务链：裁决摘要必须在迁入相可见。
		const withAdvisor = renderWith("advisor", "继续修复：settled 竞态属实");
		expect(withAdvisor).toContain("正在修复第 2 轮审查反馈");
		expect(withAdvisor).toContain("🧭 继续修复：settled 竞态属实");
		// 未经顾问的修复相：残留的审查者摘要不得冒充顾问裁决。
		expect(renderWith("reviewers", "核心逻辑已核对")).not.toContain("🧭");
	});
});

describe("review details overlay", () => {
	test("keeps every Chinese row aligned to the requested terminal width", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let lines: string[] = [];
		const ctx = {
			ui: {
				custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => {
					render: (width: number) => string[];
					dispose: () => void;
				}) => {
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_tone: string, text: string) => text },
						{ matches: () => false },
						() => {},
					);
					lines = component.render(40);
					component.dispose();
				},
			},
		};
		await ui.openDetails(ctx, () => ({
			phase: "reviewing",
			round: 1,
			focus: "中文宽度",
			roundStartedAt: 0,
			advisorRunning: false,
			language: "zh",
			reviewers: [{
				index: 0,
				label: "gpt-5.6-sol",
				status: "running",
				action: "读取审查状态",
				toolCalls: 3,
				tokens: 1_250,
				activeTools: [{ id: "t1", tool: "read", args: "review/state.ts", startedAt: Date.now() - 1_500 }],
				recentTools: [],
				trail: ["读取配置文件", "运行中文测试"],
			}],
		}));
		expect(lines.length).toBeGreaterThan(2);
		expect(lines.join("\n")).toContain("M1");
		expect(lines.join("\n")).toContain("1.3k tok");
		expect(lines.join("\n")).toContain("1.5s");
		expect(lines.join("\n")).not.toContain("gpt-5.6-sol");
		expect(lines.every((line) => Bun.stringWidth(line) === 40)).toBe(true);
	});

	test("monitor closes itself when its review scope ends", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let active = true;
		let closed = 0;
		await ui.openDetails({ ui: { custom: async (factory: (
			tui: unknown,
			theme: unknown,
			keys: unknown,
			done: () => void,
		) => { render: (width: number) => string[]; dispose: () => void }) => {
			const component = factory(
				{ requestRender: () => {} },
				{ fg: (_tone: string, text: string) => text },
				{ matches: () => false },
				() => { closed += 1; },
			);
			active = false;
			expect(component.render(40)).toEqual([]);
			await Promise.resolve();
			component.dispose();
		} } }, () => active ? ({
			phase: "reviewing", round: 1, focus: "", roundStartedAt: Date.now(), advisorRunning: false, language: "zh", reviewers: [],
		}) : undefined);
		expect(closed).toBe(1);
	});

	test("reviewer monitor closes before the advisor scope replaces it", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let phase: "reviewing" | "needs_fix" = "reviewing";
		let closed = 0;
		await ui.openDetails({ ui: { custom: async (factory: (
			tui: unknown, theme: unknown, keys: unknown, done: () => void,
		) => { render: (width: number) => string[]; dispose: () => void }) => {
			const component = factory(
				{ requestRender: () => {} },
				{ fg: (_tone: string, text: string) => text },
				{ matches: () => false },
				() => { closed += 1; },
			);
			phase = "needs_fix";
			expect(component.render(40)).toEqual([]);
			await Promise.resolve();
			component.dispose();
		} } }, () => ({
			phase, round: 2, focus: "", roundStartedAt: Date.now(), advisorRunning: phase === "needs_fix", language: "zh", reviewers: [],
		}));
		expect(closed).toBe(1);
	});

	test("advisor monitor starts its own clock and uses the A1 scope key", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let output = "";
		await ui.openDetails({ ui: { custom: async (factory: (
			tui: unknown, theme: unknown, keys: unknown, done: () => void,
		) => { render: (width: number) => string[]; dispose: () => void }) => {
			const component = factory(
				{ requestRender: () => {}, terminal: { columns: 80, rows: 30 } },
				{ fg: (_tone: string, text: string) => text },
				{ matches: () => false },
				() => {},
			);
			output = component.render(80).join("\n");
			component.dispose();
		} } }, () => ({
			phase: "needs_fix", round: 2, focus: "", roundStartedAt: Date.now() - 65_000,
			progressStartedAt: Date.now(), advisorRunning: true, language: "zh",
			reviewers: [{ index: 0, label: "gpt-5.6-sol", status: "running", action: "思考中", toolCalls: 0, tokens: 0, activeTools: [], recentTools: [], trail: [] }],
		}));
		expect(output).toContain("顾问咨询");
		expect(output).toContain("A1 gpt-5.6-sol");
		expect(output).toContain("⏱ 0:00");
	});

	test("low terminals pack all models within the original 70% height budget", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let lines: string[] = [];
		await ui.openDetails({ ui: { custom: async (factory: (
			tui: unknown, theme: unknown, keys: unknown, done: () => void,
		) => { render: (width: number) => string[]; dispose: () => void }) => {
			const component = factory(
				{ requestRender: () => {}, terminal: { columns: 100, rows: 12 } },
				{ fg: (_tone: string, text: string) => text },
				{ matches: () => false },
				() => {},
			);
			lines = component.render(80);
			component.dispose();
		} } }, () => ({
			phase: "reviewing", round: 1, focus: "", roundStartedAt: Date.now(), advisorRunning: false, language: "zh",
			reviewers: Array.from({ length: 5 }, (_, index) => ({
				index, label: `model-${index + 1}`, status: "running", action: "思考中", toolCalls: 0, tokens: 0, activeTools: [], recentTools: [], trail: [],
			})),
		}));
		expect(lines.length).toBeLessThanOrEqual(Math.floor(12 * 0.7));
		for (let index = 1; index <= 5; index += 1) expect(lines.join("\n")).toContain(`M${index}`);
	});

	test("wide monitor shows model keys, token metrics, current tool, and tool history", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			openDetails: (ctx: unknown, view: unknown) => Promise<void>;
		};
		let output = "";
		await ui.openDetails({ ui: { custom: async (factory: (
			tui: unknown,
			theme: unknown,
			keys: unknown,
			done: () => void,
		) => { render: (width: number) => string[]; dispose: () => void }) => {
			const component = factory(
				{ requestRender: () => {}, terminal: { columns: 100, rows: 40 } },
				{ fg: (_tone: string, text: string) => text },
				{ matches: () => false },
				() => {},
			);
			output = component.render(80).join("\n");
			component.dispose();
		} } }, () => ({
			phase: "reviewing",
			round: 2,
			focus: "",
			roundStartedAt: Date.now() - 65_000,
			advisorRunning: false,
			language: "zh",
			reviewers: [{
				index: 0,
				label: "gpt-5.6-sol",
				status: "running",
				action: "读 review/state.ts",
				toolCalls: 2,
				tokens: 1_250,
				activeTools: [{ id: "t2", tool: "bash", args: "bun test", startedAt: Date.now() - 1_500 }],
				recentTools: [{ id: "t1", tool: "read", args: "review/state.ts", startedAt: 1, endedAt: 1_500 }],
				trail: [],
			}],
		}));
		expect(output).toContain("第 2 轮审查");
		expect(output).toContain("M1 gpt-5.6-sol");
		expect(output).toContain("2 calls · 1.3k tok");
		expect(output).toMatch(/● 操作 \$ bun test\s+1\.5s/u);
		expect(output).toMatch(/读取 review\/state\.ts\s+1\.4s/u);
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

	test("hides the editor completely while quality checks run", async () => {
		const { editor } = await makeEditor("en");
		expect(editor.render(80)).toEqual([]);
	});

	test("accepts pi-flow Alt+S terminal escape variants", async () => {
		const { editor, ctx } = await makeEditor();
		let opened = 0;
		ctx.ui.custom = async () => { opened += 1; };
		editor.handleInput("\u001bs");
		await Promise.resolve();
		expect(opened).toBe(1);
	});

	test("unlock restores the default editor", async () => {
		const { ctx, ui, hasFactory } = await makeEditor();
		expect(hasFactory()).toBe(true);
		ui.unlockEditor(ctx);
		expect(hasFactory()).toBe(false);
	});
});
