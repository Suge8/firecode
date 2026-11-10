import { expect, test } from "bun:test";
import { loadFirecodeModule, PI_CODING_AGENT_URL } from "./loader.ts";

// 旧会话落盘的卡片（version 1）和损坏的载荷都要能显示，不能让整段会话渲染崩掉。
test("a card from an older session still renders, and a broken payload falls back to plain text", async () => {
	const { initTheme } = await import(new URL("./modes/interactive/theme/theme.ts", PI_CODING_AGENT_URL).href) as { initTheme: (name: string) => void };
	initTheme("dark");
	const card = (await loadFirecodeModule("review/card.js")) as { registerCardRenderer: (pi: unknown) => void };
	let render: (message: unknown, options: unknown, theme: unknown) => { render: (width: number) => string[] };
	card.registerCardRenderer({ registerMessageRenderer: (_type: string, next: typeof render) => { render = next; } });
	const older = render!({ details: { version: 1, kind: "pass", title: "审查通过", lines: ["ok"], tone: "success", icon: "✓" }, content: "x" }, {}, { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t });
	expect(older.render(48).join("\n")).toContain("审查通过");
	const broken = render!({ details: { kind: "nope" }, content: "## 原始内容\n- 保留为纯文本" }, {}, {});
	expect(broken.render(48).join("\n")).toContain("## 原始内容");
});

// 每次写入只带变化的部分：快照带整个历史时，五轮审查曾把会话文件写到约 2MB。
test("a review writes a linear amount of checkpoint data and a restore still has every round's text", async () => {
	const state = (await loadFirecodeModule("review/state.js")) as any;
	const { CheckpointWriter, readCheckpoint } = (await loadFirecodeModule("review/checkpoint.js")) as any;
	const entries: { type: "custom"; customType: string; data: unknown }[] = [];
	const pi = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
	const limits = { maxRounds: 12, advisorAfterFailures: 99, advisor: [{ model: "p/a", thinking: "low" }], reviewers: [0, 1, 2].map((i) => [{ model: `p/m${i}`, thinking: "low" }]) };
	const vote = { status: "failed", summary: "x".repeat(3000), details: `## 发现 1\n- 问题: ${"x".repeat(3000)}` };
	let current = state.reduce(state.reduce(state.initialState("run"), { type: "START", focus: "" }, limits, 1).state, { type: "ADVANCE" }, limits, 2).state;
	const writer = new CheckpointWriter(pi);
	const totals: number[] = [];
	for (let round = 1; round <= 10; round += 1) {
		for (const index of [0, 1, 2]) {
			current = state.reduce(current, { type: "REVIEWER_SETTLED", index, result: { index, model: `p/m${index}`, thinking: "low", ...vote } }, limits, 10 + round).state;
			writer.write(current);
		}
		for (const event of [{ type: "TURN_STARTED" }, { type: "TURN_ENDED", aborted: false }, { type: "ADVANCE" }]) {
			current = state.reduce(current, event, limits, 100 + round).state;
			writer.write(current);
		}
		totals.push(entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0));
	}
	// 线性增长时十轮累计是五轮的两倍；平方增长会接近四倍。
	expect(totals[9]).toBeLessThan(totals[4] * 2.5);
	const restored = readCheckpoint({ sessionManager: { getBranch: () => entries } });
	expect(restored?.history).toHaveLength(10);
	expect(restored?.history[0].reviewers[2].details).toBe(vote.details);
});
