/**
 * Master 事件正文：第一行是给人看的标题“<名字> <结果词>”（名字是第一个空格前的词），给模型的指令放在后续正文。
 * 分节标记：事件产文用它拼标记行；折叠界面按“独占一行的 `<标记>：`”识别正文首句（见 tools/machine.ts），
 * 失败只由 `错误：` 分节表示，改词两侧都要同步。
 */
export const MASTER_EVENT_TYPE = "firecode-master-event";

const BODY_SECTIONS = {
	reply: "回复",
	error: "错误",
	finalReply: "最终回复",
	reason: "原因",
	advice: "顾问意见",
} as const;

/** 产文侧唯一入口：正文段一律以 `<标记>：` 独占一行开头。 */
export function sectionLine(section: keyof typeof BODY_SECTIONS): string {
	return `${BODY_SECTIONS[section]}：`;
}
