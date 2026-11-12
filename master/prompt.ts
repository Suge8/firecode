import { readPrompt } from "../i18n.js";
import { msg } from "./messages.js";

const PROMPTS = new URL("./prompts/", import.meta.url);
/** 视图来源标记只有文案表一份：指挥官靠它认出用户直接派的结果，事件标题与提示词必须逐字相同。 */
export const MASTER_PROMPT = readPrompt(PROMPTS, "master").trim().replace("{{viewMark}}", msg.event.viewMark.trim());
export const WORKER_PROMPT = readPrompt(PROMPTS, "worker").trim();

export function assembleMasterPrompt(prompt: string, roles: string): string {
	return `${prompt}\n\n${msg.roles.prompt(roles)}`;
}

export function assembleWorkerPrompt(name: string): string {
	return `<firecode_worker name="${name}">\n${WORKER_PROMPT}\n</firecode_worker>`;
}
