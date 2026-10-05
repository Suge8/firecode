/**
 * 活动行：输入框上方子代理活动列表（master/activity-list.ts）的一行布局。
 * 标记 名字  角色 · 当前动作 …… 耗时；动作文字按剩余宽度截短（保留开头，带 …），角色保留与否由调用方整表决定。
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "./format.js";
import { HEAT_COLORS, paint } from "./flame.js";

/** 动作文字至少留这么宽才值得显示（一个字加省略号）。 */
const MIN_ACTION_WIDTH = 4;
/** 角色是次要信息：动作文字保不住这么宽（约“操作 $ bun t…”）时丢角色。 */
const ROLE_MIN_ACTION_WIDTH = 12;
const SEP = " · ";

export interface ActivityRow {
	/** 已着色的单格标记：火苗、◈、‖、◌、✓、✗。 */
	mark: string;
	name: string;
	role: string;
	action: string;
	/** 当前动作的语气：审查金色，失败红色，被中断与卡住黄色。 */
	tone?: "review" | "failed" | "warning";
	elapsed: string;
	/** 已落定的行文字退为暗色，只有标记保留颜色。 */
	settled?: boolean;
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** 固定部分（缩进、标记、名字列、耗时）之外留给“角色 · 动作”的宽度。 */
function middleRoom(row: ActivityRow, width: number, nameWidth: number): number {
	return width - (2 + 1 + 1 + nameWidth + 2 + visibleWidth(row.elapsed) + 1) - 1;
}

/** 这一行在给定宽度下是否值得保留角色；列表据此整表决定，列才对得齐。 */
export function roleFits(row: ActivityRow, width: number, nameWidth: number): boolean {
	return middleRoom(row, width, nameWidth) - visibleWidth(row.role) - SEP.length >= ROLE_MIN_ACTION_WIDTH;
}

export function renderActivityRow(
	row: ActivityRow,
	width: number,
	nameWidth: number,
	theme: Theme,
	showRole = roleFits(row, width, nameWidth),
): string {
	const color = (base: ThemeColor) => (row.settled ? "dim" : base);
	const head = `  ${row.mark} ${theme.fg(color("text"), pad(row.name, nameWidth))}`;
	const room = middleRoom(row, width, nameWidth);
	if (room < 0) return clip(head, width, "end", "");
	const paintAction = (text: string) =>
		row.tone === "review" ? paint(HEAT_COLORS.gold, text)
			: row.tone === "failed" ? theme.fg("error", text)
				: row.tone === "warning" ? theme.fg("warning", text)
					: theme.fg(color("muted"), text);
	const actionRoom = showRole ? room - visibleWidth(row.role) - SEP.length : room;
	const action = actionRoom >= MIN_ACTION_WIDTH ? paintAction(clip(row.action, actionRoom)) : "";
	const middle = showRole ? `${theme.fg(color("muted"), row.role)}${theme.fg("dim", SEP)}${action}` : action;
	return `${head}  ${pad(middle, room + 1)}${theme.fg(color("muted"), row.elapsed)} `;
}
