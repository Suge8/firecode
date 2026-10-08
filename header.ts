/**
 * 会话启动横幅：品牌 logo 的半格方块像素版（橙色火焰内嵌 >_ + 小写字标），够宽时画 logo，否则收成一行；
 * 两档都带同一行副标题（pi 版本 · 工作目录，放不下只留目录、从开头按整段省略）。字标用终端默认前景色，
 * 深浅主题都清楚。启动时火焰自下而上点燃、字标自左向右显现，约 1 秒后定格并退订动画时钟——横幅会滚出视口，
 * 定格后不再触发重绘。
 */
import { homedir } from "node:os";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { flame, HEAT_COLORS, mix, onFrame, paint, type Rgb } from "./flame.js";
import { clip } from "./format.js";

const WORD = "firecode";
const IGNITE_END = 0.6;
const REVEAL_START = 0.2;
const SETTLE_END = 1;
const TINY_FLAME_PHASE = 0.4;
const LOGO_GAP = 3;
/** 字标在火焰像素画里的起始行：logo 里字标约在火焰高度的中段。 */
const WORD_TOP = 3;
/** 副标题从这一深底色淡入成灰；终端底色不可知，取深色主题的近似底色。 */
const FADE_FROM: Rgb = [20, 19, 18];
const RULE: Rgb = [60, 57, 53];
/** 单行档副标题至少留这么宽才显示（省略号加几个字），右侧横线至少留这么长。 */
const TINY_SUBTITLE_MIN = 8;
const TINY_RULE_MIN = 3;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ease = (k: number) => 1 - (1 - clamp(k)) ** 3;

/** 像素画：每个终端格承载上下两个方形像素；INK 是终端默认前景色。 */
const INK = "ink";
type Pixel = Rgb | typeof INK | undefined;
type Pixels = Pixel[][];

/** 照 design/brand 的 logo 手绘：火焰主尖偏左、右侧副尖，>_ 镂空。 */
const FLAME = [
	"......#......",
	"......##.....",
	".....###.....",
	".....####....",
	"....#####....",
	"...######..#.",
	"..#######.##.",
	".###########.",
	"#############",
	"##..#########",
	"###..########",
	"####..#######",
	"###..########",
	"##..##.....##",
	".###########.",
	"...#######...",
];

/** 10 像素高的粗笔画小写字形：2 像素笔画，x 高 7，转角缺角做圆。 */
const FONT: Record<string, string[]> = {
	f: ["..###", ".####", ".##..", "#####", "#####", ".##..", ".##..", ".##..", ".##..", ".##.."],
	i: ["..", "##", "..", "##", "##", "##", "##", "##", "##", "##"],
	r: ["....", "....", "....", "##.##", "#####", "###..", "##...", "##...", "##...", "##..."],
	e: ["......", "......", "......", ".####.", "######", "##..##", "######", "##....", "######", ".####."],
	c: ["......", "......", "......", ".####.", "######", "##..#.", "##....", "##..#.", "######", ".####."],
	o: ["......", "......", "......", ".####.", "######", "##..##", "##..##", "##..##", "######", ".####."],
	d: ["....##", "....##", "....##", ".#####", "######", "##..##", "##..##", "##..##", "######", ".#####"],
};
const WORD_ROWS = FONT.f.map((_, y) => [...WORD].map((char) => FONT[char][y]).join("."));
const FLAME_WIDTH = FLAME[0].length;
const WORD_LEFT = FLAME_WIDTH + LOGO_GAP;
const LOGO_WIDTH = WORD_LEFT + WORD_ROWS[0].length;
const LARGE_MIN_WIDTH = LOGO_WIDTH + 2;

const background = (color: Rgb) => `\x1b[48;2;${color[0] | 0};${color[1] | 0};${color[2] | 0}m`;
const ink = (pixel: Pixel, glyph: string) => (pixel === INK ? glyph : paint(pixel as Rgb, glyph));

function cell(top: Pixel, bottom: Pixel): string {
	if (!top && !bottom) return " ";
	if (!bottom) return ink(top, "▀");
	if (!top) return ink(bottom, "▄");
	if (top === bottom) return ink(top, "█");
	return top === INK ? `${background(bottom as Rgb)}▀\x1b[49m` : `${background(top)}${ink(bottom, "▄")}\x1b[49m`;
}

/** 每两行像素合成一行终端格，返回逐格字符串，便于按列拼接。 */
function halfBlocks(pixels: Pixels): string[][] {
	const rows: string[][] = [];
	for (let y = 0; y < pixels.length; y += 2) rows.push(pixels[y].map((top, x) => cell(top, pixels[y + 1]?.[x])));
	return rows;
}

/** 火焰自下而上点燃，刚点亮的一排金色、随后冷却成品牌橙；字标逐列显现。 */
function logo(t: number): Pixels {
	const flameLine = ease(t / IGNITE_END) * (FLAME.length + 4);
	const wordEdge = ((t - REVEAL_START) / (SETTLE_END - REVEAL_START)) * WORD_ROWS[0].length;
	return FLAME.map((row, y) => {
		const burnt = flameLine - (FLAME.length - y);
		const pixels: Pixel[] = [...row].map((dot) =>
			dot === "#" && burnt >= 0 ? mix(HEAT_COLORS.gold, HEAT_COLORS.orange, clamp(burnt / 4)) : undefined);
		pixels.push(...Array<Pixel>(LOGO_GAP).fill(undefined));
		const word = WORD_ROWS[y - WORD_TOP] ?? "";
		for (let x = 0; x < WORD_ROWS[0].length; x++) pixels.push(word[x] === "#" && x < wordEdge ? INK : undefined);
		return pixels;
	});
}

/** 副标题的来源：两档共用同一份。 */
interface Subtitle {
	version: string;
	cwd: string;
}

/** 放得下就是“pi 版本 · 工作目录”；放不下只留目录，从开头按整段省略（…/末尾几段），连末段都放不下才裁字。 */
function fitSubtitle({ version, cwd }: Subtitle, width: number): string {
	const full = `pi ${version} · ${cwd}`;
	if (visibleWidth(full) <= width) return full;
	const segments = cwd.split("/");
	for (let index = 1; index < segments.length; index++) {
		const tail = `…/${segments.slice(index).join("/")}`;
		if (visibleWidth(tail) <= width) return tail;
	}
	return clip(segments.at(-1) ?? cwd, width, "start");
}

/** 副标题：从深底色淡入成灰。 */
function subtitleLine(subtitle: Subtitle, width: number, t: number): string {
	return paint(mix(FADE_FROM, HEAT_COLORS.ash, ease((t - 0.4) / 0.6)), fitSubtitle(subtitle, width));
}

/** 副标题压在火焰最后一行的右侧，与字标左对齐。 */
function large(t: number, subtitle: Subtitle): string[] {
	const rows = halfBlocks(logo(t));
	const last = rows.pop()!.slice(0, WORD_LEFT).join("") + subtitleLine(subtitle, LOGO_WIDTH - WORD_LEFT, t);
	return [...rows.map((row) => row.join("").trimEnd()), last];
}

/** 一行档：火苗 + 字标逐字显现 + 副标题 + 向右渐隐的横线；太窄时只留横线。 */
function tiny(width: number, t: number, glyph: string, subtitle: Subtitle): string {
	const shown = Math.ceil(((t - REVEAL_START) / (SETTLE_END - REVEAL_START)) * WORD.length);
	const letters = [...WORD].map((char, index) => (index < shown ? char : " ")).join("");
	const word = `${glyph} \x1b[1m${letters}\x1b[22m `;
	const room = width - visibleWidth(word) - 1 - TINY_RULE_MIN;
	const head = room >= TINY_SUBTITLE_MIN ? `${word}${subtitleLine(subtitle, room, t)} ` : word;
	const length = width - visibleWidth(head);
	const reveal = clamp((t - REVEAL_START) / (SETTLE_END - REVEAL_START));
	let rule = "";
	for (let index = 0; index < length; index++)
		rule += index / length <= reveal
			? paint(mix(HEAT_COLORS.gold, RULE, ease(index / Math.max(8, length * 0.7))), "─")
			: " ";
	return clip(head + rule, width, "end", "");
}

/** 按 logo 的固定宽度居中：入场时各行长短在变，按内容宽度居中会让 logo 左右跳。 */
function center(lines: string[], width: number): string[] {
	const pad = " ".repeat(Math.max(0, Math.floor((width - LOGO_WIDTH) / 2)));
	return lines.map((line) => clip(pad + line, width, "end", ""));
}

function banner(width: number, t: number, glyph: string, subtitle: Subtitle): string[] {
	if (width >= LARGE_MIN_WIDTH) return ["", ...center(large(t, subtitle), width), ""];
	return [tiny(width, t, glyph, subtitle), ""];
}

function createBanner(tui: TUI, subtitle: Subtitle) {
	const start = Date.now();
	const elapsed = () => Math.min(SETTLE_END, (Date.now() - start) / 1000);
	let unsubscribe: (() => void) | undefined;
	const dispose = () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	unsubscribe = onFrame(() => {
		tui.requestRender();
		if (elapsed() >= SETTLE_END) dispose();
	});
	let frozenGlyph: string | undefined;
	let frozen: { width: number; lines: string[] } | undefined;
	return {
		invalidate() {},
		dispose,
		render(width: number): string[] {
			const t = elapsed();
			if (t < SETTLE_END) return banner(width, t, flame(3, TINY_FLAME_PHASE), subtitle);
			if (frozen?.width !== width) {
				frozenGlyph ??= flame(3, TINY_FLAME_PHASE);
				frozen = { width, lines: banner(width, t, frozenGlyph, subtitle) };
			}
			return frozen.lines;
		},
	};
}

export function registerHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const home = homedir();
		const cwd = ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
		ctx.ui.setHeader((tui) => createBanner(tui, { version: VERSION, cwd }));
	});
}
