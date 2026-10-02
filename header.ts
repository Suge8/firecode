/**
 * 会话启动横幅：半格方块像素火焰 + 字标，按终端宽度分三档。启动时字标自左向右点亮、扫光一道，
 * 约 1.5 秒后定格并退订动画时钟——横幅会滚出视口，定格后不再触发重绘。
 */
import { homedir } from "node:os";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { flame, flicker, HEAT_COLORS, heat, mix, onFrame, paint, type Rgb } from "./flame.js";
import { clip } from "./format.js";

const LARGE_MIN_WIDTH = 83;
const MID_MIN_WIDTH = 52;
const REVEAL_END = 0.7;
const SWEEP_END = 1.5;
const TINY_FLAME_PHASE = 0.4;
/** 副标题从这一深底色淡入成灰；终端底色不可知，取深色主题的近似底色。 */
const FADE_FROM: Rgb = [20, 19, 18];
const RULE: Rgb = [60, 57, 53];

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ease = (k: number) => 1 - (1 - clamp(k)) ** 3;

/** 像素画：每个终端格承载上下两个方形像素，▀ 的前景画上半、背景画下半。 */
type Pixels = (Rgb | undefined)[][];

const background = (color: Rgb) => `\x1b[48;2;${color[0] | 0};${color[1] | 0};${color[2] | 0}m`;

function halfBlocks(pixels: Pixels): string[] {
	const lines: string[] = [];
	for (let y = 0; y < pixels.length; y += 2) {
		let line = "";
		pixels[y].forEach((top, x) => {
			const bottom = pixels[y + 1]?.[x];
			if (top && bottom) line += `${background(bottom)}${paint(top, "▀")}\x1b[49m`;
			else if (top) line += paint(top, "▀");
			else if (bottom) line += paint(bottom, "▄");
			else line += " ";
		});
		lines.push(line);
	}
	return lines;
}

/** 水滴火焰：下部半圆、上部按幂曲线收成火尖，火尖随时间摆动；离焰芯越近越接近白金。 */
function roundFlame(widthPx: number, heightPx: number, t: number): Pixels {
	const radius = widthPx / 2;
	const belly = 0.36;
	const tall = 0.9 + 0.1 * flicker(0.2, t);
	return Array.from({ length: heightPx }, (_, y) => {
		const row: (Rgb | undefined)[] = Array(widthPx).fill(undefined);
		const v = (heightPx - 0.5 - y) / heightPx / tall;
		if (v > 1) return row;
		const half = v < belly
			? radius * Math.sqrt(1 - ((belly - v) / belly) ** 2)
			: radius * ((1 - v) / (1 - belly)) ** 1.25;
		const sway = 1.3 * v * v * Math.sin(Math.PI * 2 * 0.6 * t) + 0.4 * v * Math.sin(Math.PI * 2 * (1.7 * t + v * 2));
		const reach = half + 0.25 * flicker(v * 3.1, t) * v;
		for (let x = 0; x < widthPx; x++) {
			const distance = Math.abs(x + 0.5 - radius - sway);
			if (distance > reach) continue;
			const core = 1 - distance / (reach + 0.01);
			row[x] = heat(0.12 + 0.55 * core * (1 - v * 0.6) + 0.45 * (1 - v) ** 2);
		}
		return row;
	});
}

/** 8 像素高的细笔画字形：1 像素笔画，转角缺一角做出圆角。 */
const FONT: Record<string, string[]> = {
	F: ["#####", "#....", "#....", "####.", "#....", "#....", "#....", "#...."],
	i: ["#", ".", "#", "#", "#", "#", "#", "#"],
	r: ["....", "....", ".###", "#...", "#...", "#...", "#...", "#..."],
	e: [".....", ".....", ".###.", "#...#", "#####", "#....", "#....", ".####"],
	C: [".####", "#....", "#....", "#....", "#....", "#....", "#....", ".####"],
	o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", "#...#", ".###."],
	d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", "#...#", ".####"],
};
const WORD = "FireCode";

const wordBits = (gap: number): boolean[][] =>
	FONT.F.map((_, y) => [...WORD].flatMap((char, index) => [
		...Array<boolean>(index ? gap : 0).fill(false),
		...[...FONT[char][y]].map((pixel) => pixel === "#"),
	]));
const WORD_BITS = { 1: wordBits(1), 2: wordBits(2) } as const;

/** 字标：横向红→橙→金；入场时自左向右点亮（亮边白热），随后一道斜向扫光。 */
function wordmark(gap: 1 | 2, t: number): Pixels {
	const bits = WORD_BITS[gap];
	const width = bits[0].length;
	const edge = (t / REVEAL_END) * (width + 8);
	const sweep = ((t - REVEAL_END - 0.1) / (SWEEP_END - REVEAL_END)) * (width + 16) - 8;
	return bits.map((row, y) => row.map((on, x) => {
		if (!on || x > edge) return undefined;
		const half = width / 2;
		const base = x < half
			? mix(HEAT_COLORS.red, HEAT_COLORS.orange, x / half)
			: mix(HEAT_COLORS.orange, HEAT_COLORS.gold, (x - half) / half);
		const hotEdge = t < REVEAL_END ? clamp(1 - (edge - x) / 6) : 0;
		const shine = t > REVEAL_END && t < SWEEP_END ? clamp(1 - Math.abs(x - y * 0.6 - sweep) / 4.5) : 0;
		return mix(base, HEAT_COLORS.white, Math.max(hotEdge, shine * 0.9));
	}));
}

function sideBySide(left: string[], right: string[], gap: number, rightTop = 0): string[] {
	const leftWidth = Math.max(...left.map(visibleWidth));
	return Array.from({ length: Math.max(left.length, right.length + rightTop) }, (_, index) => {
		const cell = left[index] ?? "";
		return `${cell}${" ".repeat(leftWidth - visibleWidth(cell) + gap)}${right[index - rightTop] ?? ""}`;
	});
}

function large(t: number, subtitle: string): string[] {
	const word = halfBlocks(wordmark(2, t));
	const text = clip(subtitle, visibleWidth(word[0]), "start");
	const line = paint(mix(FADE_FROM, HEAT_COLORS.ash, ease((t - 0.4) / 0.6)), text);
	return sideBySide(halfBlocks(roundFlame(10, 16, t)), [...word, "", line], 3, 2);
}

const mid = (t: number) => sideBySide(halfBlocks(roundFlame(6, 8, t)), halfBlocks(wordmark(1, t)), 2);

/** 一行档：火苗 + 渐变字标逐字亮起 + 向右渐隐的横线。 */
function tiny(width: number, t: number, glyph: string): string {
	const sweep = ((t - REVEAL_END) / (SWEEP_END - REVEAL_END)) * 14 - 3;
	const letters = [...WORD].map((char, index) => {
		if (t <= (index / WORD.length) * REVEAL_END) return " ";
		const shine = t > REVEAL_END && t < SWEEP_END ? clamp(1 - Math.abs(index - sweep) / 2) : 0;
		return paint(mix(mix(HEAT_COLORS.orange, HEAT_COLORS.gold, index / (WORD.length - 1)), HEAT_COLORS.white, shine), char);
	}).join("");
	const head = `${glyph} \x1b[1m${letters}\x1b[22m `;
	const length = width - visibleWidth(head);
	const reveal = clamp((t - 0.2) / REVEAL_END);
	let rule = "";
	for (let index = 0; index < length; index++)
		rule += index / length <= reveal
			? paint(mix(HEAT_COLORS.gold, RULE, ease(index / Math.max(8, length * 0.7))), "─")
			: " ";
	return clip(head + rule, width, "end", "");
}

function center(lines: string[], width: number): string[] {
	const pad = " ".repeat(Math.max(0, Math.floor((width - Math.max(...lines.map(visibleWidth))) / 2)));
	return lines.map((line) => clip(pad + line, width, "end", ""));
}

function banner(width: number, t: number, glyph: string, subtitle: string): string[] {
	if (width >= LARGE_MIN_WIDTH) return ["", ...center(large(t, subtitle), width), ""];
	if (width >= MID_MIN_WIDTH) return ["", ...center(mid(t), width), ""];
	return [tiny(width, t, glyph), ""];
}

function createBanner(tui: TUI, subtitle: string) {
	const start = Date.now();
	const elapsed = () => Math.min(SWEEP_END, (Date.now() - start) / 1000);
	let unsubscribe: (() => void) | undefined;
	const dispose = () => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	unsubscribe = onFrame(() => {
		tui.requestRender();
		if (elapsed() >= SWEEP_END) dispose();
	});
	let frozenGlyph: string | undefined;
	let frozen: { width: number; lines: string[] } | undefined;
	return {
		invalidate() {},
		dispose,
		render(width: number): string[] {
			const t = elapsed();
			if (t < SWEEP_END) return banner(width, t, flame(3, TINY_FLAME_PHASE), subtitle);
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
		ctx.ui.setHeader((tui) => createBanner(tui, `pi ${VERSION} · ${cwd}`));
	});
}
