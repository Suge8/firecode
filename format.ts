/** 宽度、文本与数值格式化：状态栏与工具行共用。 */
import { visibleWidth } from "@earendil-works/pi-tui";

const ELLIPSIS = "…";
const ANSI_SEQUENCE = /(\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)))/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 压平换行与连续空白，用于把任意文本塞进单行 UI。 */
export function oneLine(value = ""): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

export type ClipSide = "start" | "end";

/**
 * 按显示宽度截断，保留完整字素簇。
 * `from: "end"` 保留头部（命令），`from: "start"` 保留尾部（路径 basename）。
 */
export function clip(
	text: string,
	width: number,
	from: ClipSide = "end",
	ellipsis: string = ELLIPSIS,
): string {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth > width) return clip(ellipsis, width, "end", "");
	const target = width - ellipsisWidth;
	let output = from === "start" ? ellipsis : "";
	let column = 0;
	let clipped = false;
	const chunks = text.split(ANSI_SEQUENCE);
	for (let index = 0; index < chunks.length; index++) {
		if (index % 2) {
			// 连被裁掉文字后的颜色关闭/链接关闭也保留，避免样式泄漏；不注入全量 reset。
			output += chunks[index];
			continue;
		}
		for (const { segment } of segmenter.segment(chunks[index])) {
			const columns = visibleWidth(segment);
			if (from === "start") {
				if (column >= textWidth - target) output += segment;
			} else if (!clipped) {
				if (column + columns <= target) output += segment;
				else { output += ellipsis; clipped = true; }
			}
			column += columns;
		}
	}
	return output;
}

/** 1234 → 1.2k，1_500_000 → 1.5M；0 与 undefined 显示为 ?。 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return value >= 10 ? `${Math.round(value)}M` : `${value.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		const value = tokens / 1_000;
		return value >= 10 ? `${Math.round(value)}k` : `${value.toFixed(1)}k`;
	}
	return tokens ? `${tokens}` : "?";
}

/** 紧凑耗时：十秒以内保留一位小数，长耗时按小时、分钟、秒进位。 */
export function formatDuration(milliseconds: number): string {
	if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(milliseconds / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const seconds = totalSeconds % 60;
	return `${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}${seconds ? `${seconds}s` : ""}`;
}

/** 去掉模型 id 的 provider 前缀与日期后缀。 */
export function formatModelName(id: string | undefined): string {
	if (!id) return "no-model";
	return (id.split("/").pop() ?? id)
		.replace(/-\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
