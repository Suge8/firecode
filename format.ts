/** 宽度、文本与数值格式化：状态栏与工具行共用。 */
import { visibleWidth } from "@earendil-works/pi-tui";

const ELLIPSIS = "…";
const ANSI_SEQUENCE = /(\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)))/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 消息 content 里的正文：字符串原样；块数组只取 text 块，按行拼接。全插件只此一处。 */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

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

/** 1234 → 1.2k，1_500_000 → 1.5M，整数不带小数（1M、200k）；0 与 undefined 显示为 ?。 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${scaled(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${scaled(tokens / 1_000)}k`;
	return tokens ? `${tokens}` : "?";
}

const scaled = (value: number) => (value >= 10 ? Math.round(value) : Number(value.toFixed(1)));

const FENCE = /^\s*```/u;
const HEADING = /^\s*#{1,6}\s+/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/u;
/** 块级标记：引用符、列表符、序号（含任务框）。 */
const BLOCK_MARK = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/u;
/** 句末：中文句末标点，或后接空白/行尾的英文句末标点——但缩写的点不算。 */
const SENTENCE_END = /[。！？]|(?<!\b(?:e\.g|i\.e|etc|vs|cf|Mr|Mrs|Ms|Dr|St|No))[.!?](?=\s|$)/u;

/**
 * 一行预览用的首句（机器消息行、中间回复、Master 事件卡与会话标题共用）：认 Markdown 结构，
 * 跳过标题、围栏、表格行与分隔线，剥掉引用符、列表符与序号，去掉行内标记；只有标题没有正文时才用标题文字。
 * 首句以冒号结尾（如“标准输出：”）本身没有信息，并入下一有效行的首句。
 */
export function firstSentence(text: string): string {
	const lines = text.split("\n").filter((line) => !FENCE.test(line) && !TABLE_ROW.test(line) && !RULE.test(line));
	const body = lines.filter((line) => !HEADING.test(line));
	const source = body.some((line) => line.trim()) ? body : lines.map((line) => line.replace(HEADING, ""));
	return sentenceOf(source.map((line) => oneLine(inline(line.replace(BLOCK_MARK, "")))).filter(Boolean));
}

/** 预览是纯文本：链接只留文字，去掉粗体与行内代码标记。 */
function inline(line: string): string {
	return line
		.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/(\*\*|__)(.+?)\1/gu, "$2")
		.replace(/`([^`]+)`/gu, "$1");
}

function sentenceOf([head = "", ...rest]: string[]): string {
	const end = SENTENCE_END.exec(head);
	const sentence = end ? head.slice(0, end.index + 1) : head;
	const colon = /[：:]$/u.exec(sentence)?.[0];
	if (!colon || rest.length === 0) return sentence;
	return `${sentence}${colon === ":" ? " " : ""}${sentenceOf(rest)}`;
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
