/** 机器消息（指挥官事件、观察员发言、审查卡）的一行投影：卡片与折叠展开态共用，数据只来自信封正文。 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type EnvelopeTag, parseEnvelopes } from "../deliver.js";
import { clip, firstSentence } from "../format.js";

export interface MachineEntry {
	/** 一行标题：Master 事件与审查卡是信封正文第一行原样，观察员固定为“观察员”。 */
	title: string;
	/** 正文首句，没有则为空。 */
	preview: string;
	/** 画失败色：只认生产端声明的事实——Master 事件带“错误：”分节，审查卡的 details.tone 为 warning/error。 */
	alarm: boolean;
	/** Master 事件才有：标题第一个空格前的子代理名。 */
	worker?: string;
	/** Master 事件正文带独占一行的“错误：”分节：子代理失败。 */
	failed?: boolean;
	/** 落定类 Master 事件的子代理本次运行时长；有它即触发摘要行的到达高亮。 */
	duration?: string;
}

/** 正文分节标记独占一行（如“回复：”“错误：”）；失败时预览取错误分节之后的正文，否则取首个分节之后的。 */
const SECTION = /^[^\s：]{1,8}：$/u;
const ERROR_SECTION = "错误：";
const RUN_TIME = /^耗时：本次运行 (\S+)/mu;
/** 审查卡生产端（review/card.ts）在 details.tone 里声明的失败色。 */
const ALARM_TONES = new Set(["warning", "error"]);
/** 审查卡正文里的发现标题（“## 发现 1：…”）与原因行（“原因：…”）。 */
const FINDING = /^#{1,6}\s*(?:发现|Finding)\s*[^：:]*[：:]\s*(.+)$/mu;
const REASON = /^(?:原因|Reason)[：:]\s*(.+)$/mu;
/** 审查卡里不是结论的行：模型分节、模型清单、卡点、分隔线与用时脚注。 */
const REVIEW_NOISE = /^(?:\*\*(?:模型|Model)[ ·].*\*\*|(?:模型|Models)[：:].*|(?:卡点|Blocker)[：:].*|---|⏱.*)$/u;

/** details 是承载信封的 CustomMessage 的 details（审查卡带 tone）；用户消息形态没有。 */
export function machineEntries(text: string, details?: unknown): MachineEntry[] | undefined {
	return parseEnvelopes(text)?.map(({ tag, body }) => entryOf(tag, body, details));
}

function entryOf(tag: EnvelopeTag, body: string, details: unknown): MachineEntry {
	const [heading = "", ...rest] = body.split("\n");
	if (tag === "firecode_watcher") return { title: "观察员", preview: firstSentence(rest.join("\n")), alarm: false };
	if (tag === "firecode_review")
		return { title: heading, preview: reviewPreview(rest), alarm: ALARM_TONES.has((details as { tone?: string } | undefined)?.tone ?? "") };
	// 失败只看是否有独占一行的“错误：”，不论它是第几个分节；失败时预览从错误分节取。
	const errorAt = rest.findIndex((line) => line.trim() === ERROR_SECTION);
	const failed = errorAt >= 0;
	const marker = failed ? errorAt : rest.findIndex((line) => SECTION.test(line.trim()));
	const content = rest.slice(marker + 1).filter((line) => !RUN_TIME.test(line)).join("\n");
	const duration = RUN_TIME.exec(body)?.[1];
	return {
		title: heading,
		preview: firstSentence(content),
		alarm: failed,
		worker: heading.split(" ", 1)[0],
		failed,
		...(duration ? { duration } : {}),
	};
}

/** 审查卡的预览是结论：首条发现标题，否则原因，否则第一句非模型名的正文。 */
function reviewPreview(lines: string[]): string {
	const text = lines.join("\n");
	const pick = FINDING.exec(text)?.[1] ?? REASON.exec(text)?.[1];
	return firstSentence(pick ?? lines.filter((line) => !REVIEW_NOISE.test(line.trim())).join("\n"));
}

/** “↳ 标题 · 时长 首句”；不铺背景，可直接用 clip 截断。 */
export function machineLine(entry: MachineEntry, theme: Theme, width: number): string {
	const head = `${theme.fg(entry.alarm ? "error" : "success", "↳")} ${theme.fg(entry.alarm ? "error" : "text", entry.title)}`;
	const duration = entry.duration ? `${theme.fg("dim", " · ")}${theme.fg("muted", entry.duration)}` : "";
	const preview = entry.preview ? ` ${theme.fg("muted", entry.preview)}` : "";
	return clip(`${head}${duration}${preview}`, Math.max(1, width));
}
