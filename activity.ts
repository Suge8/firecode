/**
 * 活动行：输入框上方子代理活动列表（master/activity-list.ts）的一行布局。
 * 标记 名字  角色 · 当前动作 · 提醒 …… 耗时。宽度不够时的退让顺序：先缩名字列（整表一致，名字截短带 …）、
 * 再丢角色（整表一致），提醒（卡住行的“无输出”）先换短写法，最后才截动作文字。
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "./format.js";
import { HEAT_COLORS, paint } from "./flame.js";

/** 动作文字至少留这么宽才值得显示（一个字加省略号）。 */
const MIN_ACTION_WIDTH = 4;
/** 动作文字想要的最小宽度：保得住它才保名字全长与角色（约“操作 $ bun t…”）。 */
const COMFORT_ACTION_WIDTH = 12;
/** 名字列再窄就认不出是谁了。 */
const MIN_NAME_WIDTH = 9;
const SEP = " · ";

export interface ActivityRow {
	/** 已着色的单格标记：火苗、◈、‖、◌、✓、✗。 */
	mark: string;
	name: string;
	role: string;
	/** 当前动作；为空时只显示角色（如空闲行）。 */
	action: string;
	/** 当前动作的语气：审查金色，失败红色，被中断黄色。 */
	tone?: "review" | "failed" | "warning";
	/** 动作后追加的黄色提醒（卡住行的“无输出”）：比动作重要，宽度不够先换短写法，再截动作。 */
	note?: { full: string; short: string };
	elapsed: string;
	/** 已落定的行文字退为暗色，只有标记保留颜色。 */
	settled?: boolean;
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** 缩进、标记、名字列与耗时之外留给“角色 · 动作 · 提醒”的宽度。 */
function middleRoom(row: ActivityRow, width: number, nameWidth: number): number {
	return width - (2 + 1 + 1 + nameWidth + 2 + visibleWidth(row.elapsed) + 1) - 1;
}

/** 一行至少要给动作和提醒留多少：动作想要的宽度加提醒的短写法。 */
function wanted(row: ActivityRow): number {
	return (row.action ? COMFORT_ACTION_WIDTH : 0) + (row.note ? visibleWidth(row.note.short) : 0);
}

/** 名字列按剩余空间分配：每行都给动作留够了还有余，名字就不截；不够才缩到下限。 */
export function nameWidthFor(rows: readonly ActivityRow[], width: number): number {
	const longest = Math.max(0, ...rows.map((row) => visibleWidth(row.name)));
	const room = Math.min(...rows.map((row) => middleRoom(row, width, longest) - wanted(row)));
	return room >= 0 ? longest : Math.min(longest, Math.max(MIN_NAME_WIDTH, longest + room));
}

/** 这一行在给定宽度下是否值得保留角色；列表据此整表决定，列才对得齐。 */
export function roleFits(row: ActivityRow, width: number, nameWidth: number): boolean {
	return middleRoom(row, width, nameWidth) - visibleWidth(row.role) - SEP.length - wanted(row) >= 0;
}

export function renderActivityRow(
	row: ActivityRow,
	width: number,
	nameWidth: number,
	theme: Theme,
	showRole = roleFits(row, width, nameWidth),
): string {
	const color = (base: ThemeColor) => (row.settled ? "dim" : base);
	const head = `  ${row.mark} ${theme.fg(color("text"), pad(clip(row.name, nameWidth), nameWidth))}`;
	const room = middleRoom(row, width, nameWidth);
	if (room < 0) return clip(head, width, "end", "");
	const paintAction = (text: string) =>
		row.tone === "review" ? paint(HEAT_COLORS.gold, text)
			: row.tone === "failed" ? theme.fg("error", text)
				: row.tone === "warning" ? theme.fg("warning", text)
					: theme.fg(color("muted"), text);
	const actionRoom = showRole ? room - visibleWidth(row.role) - SEP.length : room;
	const note = noteFor(row, actionRoom);
	const textRoom = actionRoom - visibleWidth(note);
	const action = (row.action && textRoom >= MIN_ACTION_WIDTH ? paintAction(clip(row.action, textRoom)) : "") + (note && theme.fg("warning", note));
	const role = theme.fg(color("muted"), row.role);
	const middle = showRole ? (action ? `${role}${theme.fg("dim", SEP)}${action}` : role) : action;
	return `${head}  ${pad(middle, room + 1)}${theme.fg(color("muted"), row.elapsed)} `;
}

/** 提醒优先于动作：全写法放得下且还能给动作留一点就用全写法，否则短写法，再不够才截。 */
function noteFor(row: ActivityRow, room: number): string {
	if (!row.note) return "";
	if (visibleWidth(row.note.full) + MIN_ACTION_WIDTH <= room) return row.note.full;
	return clip(row.note.short, room);
}
