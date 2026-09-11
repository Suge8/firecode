/** 状态栏纯布局：宽度变化只影响本次绘制。 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatTokens } from "../format.js";
import { contextColor } from "../theme.js";

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
	return `${theme.fg(contextColor(percent), percentText)}${
		compact ? "" : theme.fg("dim", `/${formatTokens(contextWindow)}`)
	}`;
}

type FooterParts = {
	title: string;
	model: string;
	fast: string;
	context: string;
	contextCompact: string;
	watcher: string;
	master: string;
	masterCompact: string;
};

export function fitFooter(parts: FooterParts, width: number, separator: string): string {
	const join = (values: string[]) => values.filter(Boolean).join(separator);
	const model = (text: string) => [text, parts.fast].filter(Boolean).join(" · ");
	const fit = (context: string, watcher: string, master: string): string | undefined => {
		const rest = join([model(parts.model), context, watcher, master]);
		const budget = width - visibleWidth(rest) - visibleWidth(separator);
		if (budget < 1) return undefined;
		return join([clip(parts.title, budget), rest]);
	};
	const full = fit(parts.context, parts.watcher, parts.master);
	if (full !== undefined) return full;
	const compact = fit(parts.context, "", parts.masterCompact);
	if (compact !== undefined) return compact;
	const percent = fit(parts.contextCompact, "", parts.masterCompact);
	if (percent !== undefined) return percent;

	const trimModel = (title: string, master: string): string | undefined => {
		const fixed = join([title, model(""), parts.contextCompact, master]);
		const budget = width - visibleWidth(fixed) - visibleWidth(parts.fast ? " · " : separator);
		if (budget < 1) return undefined;
		return join([title, model(clip(parts.model, budget)), parts.contextCompact, master]);
	};
	const shortened = trimModel(clip(parts.title, 1), parts.masterCompact);
	if (shortened !== undefined) return shortened;
	const minimal = trimModel("", "");
	if (minimal !== undefined) return minimal;
	const fast = join([parts.fast, parts.contextCompact]);
	if (visibleWidth(fast) <= width) return fast;
	return visibleWidth(parts.contextCompact) <= width ? parts.contextCompact : "";
}
