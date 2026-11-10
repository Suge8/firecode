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
