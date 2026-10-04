import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

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
	const keys = {
		matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b",
		getKeys: (action: string) => (action === "app.interrupt" ? ["escape"] : []),
	};

	async function lock(previous?: unknown, bindings = keys) {
		const ui = await loadFirecodeModule("review/ui.js") as any;
		const installed: unknown[] = [];
		const ctx = { ui: { getEditorComponent: () => previous, setEditorComponent: (next: unknown) => installed.push(next) } };
		const cancelled: string[] = [];
		const unlock = ui.lockEditor(ctx, () => cancelled.push("cancel"));
		const editor = (installed[0] as any)(tui, theme, bindings);
		return { editor, unlock, installed, cancelled };
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
