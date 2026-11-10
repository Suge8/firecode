import { expect, test } from "bun:test";
import { loadFirecodeModule, PI_TUI_URL } from "./loader.ts";

test("单行裁剪不超宽、保留链接控制序列、不用全量重置掐断外层背景", async () => {
	const { clip } = await loadFirecodeModule("format.ts") as any;
	const { visibleWidth } = await import(PI_TUI_URL);
	const red = "\x1b[31m";
	const clear = "\x1b[39m";
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
});
