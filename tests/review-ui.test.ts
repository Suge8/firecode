import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type Progress = typeof import("../review/progress.js");

async function loadProgress(): Promise<Progress> {
	return (await loadFirecodeModule("review/progress.js")) as Progress;
}

const reviewers = [{ model: "openai-codex/gpt-5.6-sol" }, { model: "openai-codex/gpt-5.6-luna" }];

afterEach(cleanupFirecodeModules);

describe("reviewer progress derived from structured session events", () => {
	test("starts every reviewer as running with a readable label", async () => {
		const { initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		expect(progress.map((item) => item.label)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
		expect(progress.every((item) => item.status === "running")).toBe(true);
		expect(progress[0].action).toBe("思考中");
	});

	test("turns tool calls into human actions and counts them per reviewer", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applySessionEvent(
			progress,
			0,
			{ type: "tool_execution_start", toolName: "read", args: { path: "agent/review/state.ts" } },
			"zh",
		);
		progress = applySessionEvent(
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

	test("tracks tool completion and token usage for progress monitoring", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "review/state.ts" },
		}, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "tool_execution_end",
			toolCallId: "call-1",
		}, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "message_end",
			message: { usage: { totalTokens: 1250 } },
		}, "zh");
		expect(progress[0].activeTools).toEqual([]);
		expect(progress[0].recentTools[0]).toMatchObject({ tool: "read", args: "review/state.ts" });
		expect(progress[0].tokens).toBe(1250);
	});

	test("ignores non-tool events so the bar does not churn", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		const next = applySessionEvent(progress, 0, { type: "message_update" }, "zh");
		expect(next).toBe(progress);
	});

	test("settling replaces the action with the verdict and extracts details from realistic output", async () => {
		const { initialProgress, settleProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		const rawFail = `FAIL\n\n## 发现 1：状态竞态\n- **严重程度**: 高\n- **问题**:\n并发写入导致丢失\n- **违反的约定与期望行为**:\n原子写入\n- **证据**:\nx\n- **验证命令**:\ny`;
		progress = settleProgress(
			progress,
			1,
			"failed",
			"zh",
			"发现 1 项问题",
			rawFail,
		);
		expect(progress[1].status).toBe("failed");
		expect(progress[1].action).toBe("发现问题");
		expect(progress[1].details).not.toContain("FAIL");
		// 首行数量汇总 + 每发现一行带严重度标签的标题；问题正文不进活动条。
		expect(progress[1].details?.[0]).toBe("发现 1 个问题");
		expect(progress[1].details).toContain("[严重·高] 状态竞态");
		expect(progress[1].details?.join("\n")).not.toContain("问题: 并发写入导致丢失");
		// 每模型自己的耗时：启动时刻来自 initialProgress，落定时刻冻结在 settle。
		expect(progress[1].startedAt).toBeGreaterThan(0);
		expect(progress[1].settledAt).toBeGreaterThanOrEqual(progress[1].startedAt);
		expect(progress[0].settledAt).toBeUndefined();
		expect(progress[0].status).toBe("running");
	});

	test("extracts suggestions in PASS output with summary first", async () => {
		const { extractReviewDetails } = await loadProgress();
		const raw = `PASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=a.ts；命令=bun test\n\n## 建议（非阻塞）\n- 可为超时边界补充测试用例`;
		const details = extractReviewDetails("passed", "验证命令 exit 0，核心逻辑已核对。", raw, "zh");
		expect(details[0]).toBe("验证命令 exit 0，核心逻辑已核对。");
		expect(details).toContain("建议：可为超时边界补充测试用例");
	});
});

const reviewer = (index: number, status: string) => ({
	index, label: `model-${index + 1}`, status, action: "读 a.ts", toolCalls: 1, trail: [],
});

describe("review activity row", () => {
	async function render(view: Record<string, unknown>, width = 100) {
		const { showActivity } = await loadFirecodeModule("review/ui.js") as any;
		let factory: any;
		const widgets: any[] = [];
		const ctx = { ui: { setWidget: (_key: string, next: any, options: any) => { factory = next; widgets.push(options); } } };
		showActivity(ctx, () => view);
		const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text });
		try { return { lines: component.render(width) as string[], widgets }; } finally { component.dispose(); }
	}
	const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/gu, "");

	test("主会话审查是编辑器上方的一行，写明轮次与通过进度", async () => {
		const { lines, widgets } = await render({
			phase: "reviewing", round: 2, startedAt: Date.now() - 90_000, language: "zh",
			reviewers: [reviewer(0, "passed"), reviewer(1, "running"), reviewer(2, "running")],
		});
		expect(widgets).toEqual([{ placement: "aboveEditor" }]);
		expect(lines).toHaveLength(1);
		expect(plain(lines[0])).toMatch(/^ {2}◈ 本轮改动 +审查 · 第 2 轮 · 1\/3 位审查者通过 +1m30s $/u);
	});

	test("有审查者未通过时注明阻断", async () => {
		const { lines } = await render({
			phase: "reviewing", round: 1, startedAt: Date.now(), language: "zh",
			reviewers: [reviewer(0, "passed"), reviewer(1, "failed"), reviewer(2, "running")],
		});
		expect(lines).toHaveLength(1);
		expect(plain(lines[0])).toContain("1/3 位审查者通过，1 位阻断");
	});

	test("窄屏不超宽，顾问与修复相仍是单行", async () => {
		for (const phase of ["queued", "needs_fix", "awaiting_fix", "summarizing"])
			for (const width of [26, 40, 72]) {
				const { lines } = await render({
					phase, round: 2, startedAt: Date.now(), language: "zh", consecutiveFailures: 2,
					reviewers: [reviewer(0, "running")],
				}, width);
				expect(lines).toHaveLength(1);
				expect([...plain(lines[0])].length).toBeLessThanOrEqual(width);
			}
	});
});

describe("review editor lock", () => {
	const tui = { requestRender: () => {}, terminal: { rows: 40 } };
	const theme = { borderColor: (text: string) => text, selectList: {} };
	const keys = { matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" };

	async function lock(previous?: unknown) {
		const ui = await loadFirecodeModule("review/ui.js") as any;
		const installed: unknown[] = [];
		const ctx = { ui: { getEditorComponent: () => previous, setEditorComponent: (next: unknown) => installed.push(next) } };
		const cancelled: string[] = [];
		const unlock = ui.lockEditor(ctx, () => cancelled.push("cancel"));
		const editor = (installed[0] as any)(tui, theme, keys);
		return { editor, unlock, installed, cancelled };
	}

	test("输入不进缓冲区，esc 立即取消", async () => {
		const { editor, cancelled } = await lock();
		editor.handleInput("这段字不该出现");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b");
		expect(cancelled).toEqual(["cancel"]);
	});

	test("锁定期间输入区收起，只留上下边框承载状态", async () => {
		const { editor } = await lock();
		expect(editor.render(80)).toHaveLength(2);
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
