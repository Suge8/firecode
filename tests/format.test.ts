import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_TUI_URL } from "./loader.ts";

afterEach(cleanupFirecodeModules);

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
