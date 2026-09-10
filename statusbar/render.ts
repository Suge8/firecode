/** 状态栏的纯渲染与布局：给定数据和宽度产出字符串，不触碰会话状态。 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatTokens } from "../format.js";
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

/** 首行模块状态由各模块的 setStatus/onChange 驱动，状态栏只负责组合。 */
export function statusBadges(statuses: ReadonlyMap<string, string>, separator: string): string {
	return [statuses.get("master"), statuses.get("watcher")].filter(Boolean).join(separator);
}

export function fitMetadataLine(title: string, badge: string, width: number, separator: string): string {
	const full = [title, badge].filter(Boolean).join(separator);
	return visibleWidth(full) <= width ? full : clip(title, width);
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
