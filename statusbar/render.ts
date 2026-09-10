/** 状态栏的纯渲染与布局：给定数据和宽度产出字符串，不触碰会话状态。 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatTokens, oneLine } from "../format.js";
import { contextColor } from "../theme.js";

export type StatusLineParts = {
	model: string;
	modelCompact: string;
	context: string;
	contextCompact: string;
};

type ForegroundTheme = {
	fg(color: ThemeColor, text: string): string;
};

export function renderContext(
	theme: ForegroundTheme,
	percent: number | null | undefined,
	contextWindow: number,
	compact = false,
): string {
	const percentText = percent == null ? "?" : `${percent.toFixed(1)}%`;
	return `${theme.fg("dim", "📦 ")}${theme.fg(contextColor(percent), percentText)}${
		compact ? "" : theme.fg("dim", `/${formatTokens(contextWindow)}`)
	}`;
}

/** /fire-review 广播的审查进度，右对齐挂在首行末尾。 */
export function reviewStatus(statuses: ReadonlyMap<string, string>): string {
	return oneLine(statuses.get("fire-review") ?? "");
}

/** 首行模块状态由各模块的 setStatus/onChange 驱动，状态栏只负责组合。 */
export function statusBadges(statuses: ReadonlyMap<string, string>, separator: string): string {
	return [statuses.get("master"), statuses.get("watcher")].filter(Boolean).join(separator);
}

export function alignRight(left: string, right: string, width: number): string {
	if (!right) return left;
	const padding = width - visibleWidth(left) - visibleWidth(right);
	return padding >= 2 ? `${left}${" ".repeat(padding)}${right}` : left;
}

export function fitMetadataLine(
	location: string,
	title: string,
	width: number,
	separator: string,
	badge = "",
): string {
	if (width <= 0) return "";
	// badge（如指挥官态）整段取舍：放不下就丢，不截半个，再走会话名截断阶梯。
	if (badge) {
		const full = [location, title, badge].filter(Boolean).join(separator);
		if (visibleWidth(full) <= width) return full;
	}
	if (!title) return clip(location, width, "end", visibleWidth(location) > width ? "…" : "");
	const full = `${location}${separator}${title}`;
	if (visibleWidth(full) <= width) return full;
	const titleWidth = width - visibleWidth(location) - visibleWidth(separator);
	if (titleWidth > 0) {
		const fittedTitle = clip(title, titleWidth, "end");
		if (fittedTitle) return `${location}${separator}${fittedTitle}`;
	}
	return clip(location, width, "end");
}

const joinParts = (parts: string[], separator: string) => parts.filter(Boolean).join(separator);

export function fitStatusLine(
	parts: StatusLineParts,
	width: number,
	separator: string,
): string {
	if (width <= 0) return "";
	const candidates = [
		[parts.model, parts.context],
		[parts.modelCompact, parts.context],
		[parts.modelCompact, parts.contextCompact],
	].map((candidate) => joinParts(candidate, separator));
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}

	const context = parts.contextCompact || parts.context;
	const contextWidth = visibleWidth(context);
	const modelBudget = width - contextWidth - visibleWidth(separator);
	if (modelBudget > 0 && contextWidth <= width) {
		return `${clip(parts.modelCompact, modelBudget, "end")}${separator}${context}`;
	}
	return clip(context, width, "end", "");
}
