/** 机器消息（指挥官事件、观察员发言）的一行投影：卡片与折叠展开态共用，数据只来自信封正文。 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseEnvelopes } from "../deliver.js";
import { clip, oneLine } from "../format.js";

export interface MachineEntry {
	/** 一行标题；子代理结果归一为“<名字> 已返回/失败”。 */
	title: string;
	/** 子代理结果才有：名字与是否失败。 */
	returned?: { name: string; failed: boolean };
	/** 子代理本次运行时长。 */
	duration?: string;
	/** 正文首句，没有则为空。 */
	preview: string;
}

/** 正文分节标记独占一行（如“回复：”“错误：”）；预览取标记之后的第一行正文。 */
const SECTION = /^[^\s：]{1,8}：$/u;
const RETURNED = /^子代理 (.+) 已停下$/u;
const RUN_TIME = /本次运行 (\S+)/u;
const SENTENCE_END = /^.*?(?:[。！？]|[.!?](?=\s|$))/u;

export function machineEntries(text: string): MachineEntry[] | undefined {
	return parseEnvelopes(text)?.map(({ body }) => entryOf(body));
}

function entryOf(body: string): MachineEntry {
	const [heading = "", ...rest] = body.split("\n");
	const marker = rest.findIndex((line) => SECTION.test(line.trim()));
	const failed = marker >= 0 && rest[marker].trim() === "错误：";
	const preview = rest.slice(marker + 1).filter((line) => line.trim() && !line.startsWith("耗时：")).join("\n").trim();
	const name = RETURNED.exec(heading)?.[1];
	return {
		title: name === undefined ? heading : `${name} ${failed ? "失败" : "已返回"}`,
		...(name === undefined ? {} : { returned: { name, failed } }),
		...(RUN_TIME.exec(body) ? { duration: RUN_TIME.exec(body)![1] } : {}),
		preview,
	};
}

/**
 * 一行预览用的首句，机器消息行、中间回复与事件卡共用这一份规则：
 * 首句以冒号结尾（如“标准输出：”）本身没有信息，并入下一非空行的首句；围栏行与空行不算有效文字，行内 Markdown 标记去掉。
 */
export function firstSentence(text: string): string {
	const lines = text.split("\n").filter((line) => !FENCE.test(line)).map((line) => oneLine(plain(line))).filter(Boolean);
	return sentenceOf(lines);
}

const FENCE = /^\s*```/u;

/** 预览是纯文本：链接只留文字，去掉粗体与行内代码标记。 */
function plain(line: string): string {
	return line
		.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/(\*\*|__)(.+?)\1/gu, "$2")
		.replace(/`([^`]+)`/gu, "$1");
}

function sentenceOf([head = "", ...rest]: string[]): string {
	const sentence = SENTENCE_END.exec(head)?.[0] ?? head;
	const colon = /[：:]$/u.exec(sentence)?.[0];
	if (!colon || rest.length === 0) return sentence;
	return `${sentence}${colon === ":" ? " " : ""}${sentenceOf(rest)}`;
}

/** “↳ <名字> 已返回 · 时长 首句”；不铺背景，可直接用 clip 截断。 */
export function machineLine(entry: MachineEntry, theme: Theme, width: number): string {
	const tone = entry.returned?.failed ? "error" : "success";
	const head = `${theme.fg(tone, "↳")} ${theme.fg(entry.returned?.failed ? "error" : "text", entry.title)}`;
	const duration = entry.duration ? `${theme.fg("dim", " · ")}${theme.fg("muted", entry.duration)}` : "";
	const preview = entry.preview ? ` ${theme.fg("muted", firstSentence(entry.preview))}` : "";
	return clip(`${head}${duration}${preview}`, Math.max(1, width));
}
