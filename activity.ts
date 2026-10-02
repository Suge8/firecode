/**
 * 活动行：输入框上方子代理与审查共用的一行布局。
 * 标记 名字  角色 · 当前动作 …… 耗时；窄屏先丢当前动作再丢角色，截断不加省略号。
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "./format.js";
import { HEAT_COLORS, paint } from "./flame.js";

/** 输入框上方最多几行活动；超出时最后一行换成“… +N 个”。 */
export const ACTIVITY_ROWS = 4;

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
	const action = row.tone === "review"
		? paint(HEAT_COLORS.gold, row.action)
		: row.tone === "failed" ? theme.fg("error", row.action) : theme.fg(color("muted"), row.action);
	const right = theme.fg(color("muted"), row.elapsed);
	const fixed = visibleWidth(head) + 2 + visibleWidth(right) + 1;
	for (const middle of [`${role}${theme.fg("dim", " · ")}${action}`, role, ""]) {
		if (fixed + visibleWidth(middle) + 1 <= width) return `${head}  ${pad(middle, width - fixed)}${right} `;
	}
	return clip(head, width, "end", "");
}

export function renderMoreRow(hidden: number, width: number, theme: Theme): string {
	return clip(`    ${theme.fg("muted", `… +${hidden} 个`)}`, width, "end", "");
}
