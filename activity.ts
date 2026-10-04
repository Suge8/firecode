/**
 * 活动行：输入框上方子代理与审查共用的一行布局。
 * 标记 名字  角色 · 当前动作 …… 耗时；窄屏先截短动作（保留开头，带 …），放不下再丢角色。
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "./format.js";
import { HEAT_COLORS, paint } from "./flame.js";

/** 输入框上方活动行数的下限；超出时最后一行换成“… +N 个”。终端更高时由调用方放宽。 */
export const ACTIVITY_ROWS = 4;
/** 动作文字至少留这么宽才值得显示（一个字加省略号）。 */
const MIN_ACTION_WIDTH = 4;

export interface ActivityRow {
	/** 已着色的单格标记：火苗、◈、✓、✗。 */
	mark: string;
	name: string;
	role: string;
	action: string;
	/** 当前动作的语气：审查用金色，失败用红色。 */
	tone?: "review" | "failed";
	elapsed: string;
	/** 已落定的行文字退为暗色，只有标记保留颜色。 */
	settled?: boolean;
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

export function renderActivityRow(row: ActivityRow, width: number, nameWidth: number, theme: Theme): string {
	const color = (base: ThemeColor) => (row.settled ? "dim" : base);
	const head = `  ${row.mark} ${theme.fg(color("text"), pad(row.name, nameWidth))}`;
	const role = theme.fg(color("muted"), row.role);
	const paintAction = (text: string) => row.tone === "review"
		? paint(HEAT_COLORS.gold, text)
		: row.tone === "failed" ? theme.fg("error", text) : theme.fg(color("muted"), text);
	const right = theme.fg(color("muted"), row.elapsed);
	const fixed = visibleWidth(head) + 2 + visibleWidth(right) + 1;
	const room = width - fixed - 1;
	const sep = " · ";
	// 退让顺序：完整 → 截短动作（保留开头）→ 丢角色只留截短动作 → 只留角色 → 都不留。
	const roleRoom = room - visibleWidth(row.role) - sep.length;
	const middles = [
		roleRoom >= MIN_ACTION_WIDTH ? `${role}${theme.fg("dim", sep)}${paintAction(clip(row.action, roleRoom))}` : undefined,
		room >= MIN_ACTION_WIDTH ? paintAction(clip(row.action, room)) : undefined,
		role,
		"",
	];
	for (const middle of middles) {
		if (middle !== undefined && fixed + visibleWidth(middle) + 1 <= width) return `${head}  ${pad(middle, width - fixed)}${right} `;
	}
	return clip(head, width, "end", "");
}

export function renderMoreRow(hidden: number, width: number, theme: Theme): string {
	return clip(`    ${theme.fg("muted", `… +${hidden} 个`)}`, width, "end", "");
}
