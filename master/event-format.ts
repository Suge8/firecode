/**
 * Master 事件正文的分节标记：事件产文用它拼标记行；折叠界面按“独占一行的 `<标记>：`”
 * 识别正文首句（见 tools/machine.ts），改词两侧都要同步。
 */
export const MASTER_EVENT_TYPE = "firecode-master-event";

export const BODY_SECTIONS = {
	reply: "回复",
	error: "错误",
	question: "问题",
	finalReply: "最终回复",
	lastOutput: "中断前最后输出",
} as const;

/** 产文侧唯一入口：正文段一律以 `<标记>：` 独占一行开头。 */
export function sectionLine(section: keyof typeof BODY_SECTIONS): string {
	return `${BODY_SECTIONS[section]}：`;
}
