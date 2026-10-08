/**
 * 输入框边框纯布局：状态嵌进上下边框横线。所有片段由调用方预先着色，
 * 本文件只按显示宽度逐级退让，宽窄布局不保存状态。
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "../format.js";
import { HEAT_COLORS, type Rgb, mix, paint } from "../flame.js";

/** 回合进行时边框左端的暖光渐隐距离（列）。 */
const GLOW_SPAN = 18;
const LINE_BASE: Rgb = [78, 74, 70];
export const SEPARATOR = ` ${paint([88, 84, 79], "·")} `;

type Line = (text: string) => string;
/** 一条边框的一档候选：左、右两段（已着色）。 */
export type BorderParts = readonly [left: string, right: string];

/**
 * 一条边框：`─ 左 ───── 右 ─`。左端按 glow 渐变成暖橙；横线放不下（填充不足两格）返回空串。
 * 左右为空时对应空位并入横线。
 */
function border(width: number, left: string, right: string, line: Line, glow: number): string {
	const fill = width - 2 - (left ? visibleWidth(left) + 2 : 0) - (right ? visibleWidth(right) + 2 : 0);
	if (fill < 2) return "";
	const lit = (index: number) => glow * Math.max(0, 1 - index / GLOW_SPAN);
	const dash = (index: number) => {
		const k = lit(index);
		return k > 0.02 ? paint(mix(LINE_BASE, HEAT_COLORS.orange, k), "─") : line("─");
	};
	let bar = "";
	for (let index = 0; index < fill; index++) bar += dash(index + (left ? 0 : 1));
	return `${dash(0)}${left ? ` ${left} ` : ""}${bar}${right ? ` ${right} ` : ""}${line("─")}`;
}

/**
 * 边框布局：依次尝试由长到短的候选，取第一个放得下的；全都放不下就是一条纯横线。
 * 主会话输入框与子代理视图输入区共用这一个函数，退让档由各自给出。
 */
export function fitBorder(width: number, line: Line, glow: number, candidates: Iterable<BorderParts>): string {
	for (const [left, right] of candidates) {
		const text = border(width, left, right, line, glow);
		if (text && visibleWidth(text) <= width) return text;
	}
	return line("─").repeat(Math.max(0, width));
}

export interface TopParts {
	/** 火苗或落定标记；空表示没有回合。 */
	mark: string;
	word: string;
	elapsed: string;
	/** 审查进度由长到短的退让档（已着色）；空数组表示没有审查。 */
	review: readonly string[];
	watcher: string;
	master: string;
	/** 0–1：回合进行时边框左端的暖光强度。 */
	glow: number;
}

/** 退让顺序：观察员 → 审查进度逐档缩短 → “处理中” → 审查进度最短档 → 指挥官。 */
export function topBorder(width: number, parts: TopParts, line: Line): string {
	const left = (word: boolean, review: string) => {
		const head = [parts.mark, word ? parts.word : "", parts.elapsed].filter(Boolean).join(" ");
		return [head, review].filter(Boolean).join(SEPARATOR);
	};
	const right = (...items: string[]) => items.filter(Boolean).join(" ");
	const at = (word: boolean, review: string, ...items: string[]): BorderParts => [left(word, review), right(...items)];
	const [full = "", ...shorter] = parts.review;
	return fitBorder(width, line, parts.glow, [
		at(true, full, parts.watcher, parts.master),
		...[full, ...shorter].map((review) => at(true, review, parts.master)),
		at(false, parts.review.at(-1) ?? "", parts.master),
		at(false, "", parts.master),
		at(false, ""),
	]);
}

export interface BottomParts {
	title: string;
	/** 生效中的预设名（已着色）；没有预设为空。 */
	preset: string;
	model: string;
	/** 含前导斜杠，如 `/high`；模型不支持思考档时为空。 */
	think: string;
	fast: string;
	percent: string;
	/** 含前导斜杠，如 `/1M`。 */
	capacity: string;
}

/** 标题裁到这么窄就先去裁模型名：再窄的标题认不出会话。 */
const TITLE_MIN = 8;

/** 退让顺序：容量 → 预设名 → 标题裁到 TITLE_MIN → 模型名逐列裁 → 丢标题；Fast 与百分比始终保留。 */
export function bottomBorder(width: number, parts: BottomParts, line: Line): string {
	const right = (preset: string, model: string, capacity: string) => {
		const name = [model + (model ? parts.think : ""), parts.fast].filter(Boolean).join(" ");
		return [preset, name, `${parts.percent}${capacity}`].filter(Boolean).join(SEPARATOR);
	};
	const at = (title: string, preset: string, model: string, capacity: string): BorderParts => [title, right(preset, model, capacity)];
	function* candidates() {
		yield at(parts.title, parts.preset, parts.model, parts.capacity);
		yield at(parts.title, parts.preset, parts.model, "");
		const titleWidth = visibleWidth(parts.title);
		for (let n = titleWidth; n >= Math.min(titleWidth, TITLE_MIN); n--) yield at(clip(parts.title, n), "", parts.model, "");
		const short = clip(parts.title, TITLE_MIN);
		for (let n = visibleWidth(parts.model) - 1; n >= 1; n--) yield at(short, "", clip(parts.model, n), "");
		yield at("", "", parts.model, "");
		for (let n = visibleWidth(parts.model) - 1; n >= 1; n--) yield at("", "", clip(parts.model, n), "");
		yield at("", "", "", "");
	}
	return fitBorder(width, line, 0, candidates());
}
