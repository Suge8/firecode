import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { loadFirecodeModule, PI_TUI_URL } from "./loader.ts";

test("单行裁剪保留字素、完整颜色与链接控制序列，不重置外层背景", async () => {
	const { clip } = await loadFirecodeModule("format.ts") as any;
	const { visibleWidth } = await import(PI_TUI_URL);
	const red = "\x1b[31m";
	const clear = "\x1b[39m";
	expect(clip(`${red}abcdef${clear}`, 4)).toBe(`${red}abc…${clear}`);
	expect(stripVTControlCharacters(clip(`${red}ab${clear}cdef`, 4))).toBe("abc…");
	expect(clip(`${red}abcdef${clear}`, 4, "start")).toBe(`…${red}def${clear}`);
	const linkStart = "\x1b]8;;https://example.com\x1b\\";
	const linkEnd = "\x1b]8;;\x1b\\";
	const text = `${linkStart}${red}你👩‍💻好世界${clear}${linkEnd}`;
	for (const side of ["start", "end"]) {
		for (const width of [0, 1, 3, 6, 20]) {
			const clipped = clip(text, width, side);
			expect(visibleWidth(clipped)).toBeLessThanOrEqual(width);
			expect(clipped).not.toContain("\x1b[0m");
			if (width > 0) {
				expect(clipped).toContain(linkStart);
				expect(clipped).toContain(linkEnd);
			}
		}
	}
	expect(clip("👩‍💻好世界", 5)).toBe("👩‍💻好…");
	expect(clip("abcdef", 1, "end", "...")).toBe(".");
});

test("耗时在分秒边界进位，小时保留余分秒且不转换成天", async () => {
	const { formatDuration } = await loadFirecodeModule("format.ts") as any;
	for (const [milliseconds, expected] of [
		[900, "0.9s"], [12_400, "12s"], [59_500, "1m"], [93_000, "1m33s"],
		[3_599_000, "59m59s"], [3_599_500, "1h"], [3_600_000, "1h"],
		[3_605_000, "1h5s"], [3_660_000, "1h1m"], [15_217_000, "4h13m37s"],
		[90_061_000, "25h1m1s"],
	]) expect(formatDuration(milliseconds)).toBe(expected);
});

test("一行预览的首句认 Markdown：跳过标题、列表符、序号、引用与表格行，序号与缩写的点不算句末", async () => {
	const { firstSentence } = await loadFirecodeModule("format.ts") as any;
	for (const [text, expected] of [
		["## 交付\n- 修好了 refresh 竞态。", "修好了 refresh 竞态。"],
		["### 1. 根因\n刷新没有单飞。", "刷新没有单飞。"],
		["1. 第一步：读代码。\n2. 第二步", "第一步：读代码。"],
		["- 改动 a.ts\n- 改动 b.ts", "改动 a.ts"],
		["> 引用一句。后面", "引用一句。"],
		["| 列 | 值 |\n|---|---|\n| a | b |\n结论在这里。", "结论在这里。"],
		["e.g. this works. Next", "e.g. this works."],
		["Done. All tests pass.", "Done."],
		["版本 v0.6.1 已发布。下一步", "版本 v0.6.1 已发布。"],
		["**结论**：没问题。", "结论：没问题。"],
		["改动如下：\n- a.ts\n- b.ts", "改动如下：a.ts"],
		["## 交付", "交付"],
	]) expect(firstSentence(text)).toBe(expected);
});

test("容量取整的百万与千不带小数：1M、200k，非整保留一位", async () => {
	const { formatTokens } = await loadFirecodeModule("format.ts") as any;
	for (const [tokens, expected] of [[1_000_000, "1M"], [1_500_000, "1.5M"], [200_000, "200k"], [2_000, "2k"], [1_234, "1.2k"]])
		expect(formatTokens(tokens)).toBe(expected);
});
