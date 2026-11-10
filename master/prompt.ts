import { readPrompt } from "../i18n.js";
import { msg } from "./messages.js";

const PROMPTS = new URL("./prompts/", import.meta.url);
export const MASTER_PROMPT = readPrompt(PROMPTS, "master").trim();
export const WORKER_PROMPT = readPrompt(PROMPTS, "worker").trim();

export function assembleMasterPrompt(prompt: string, roles: string): string {
	return `${prompt}\n\n${msg.roles.prompt(roles)}`;
}

export function assembleWorkerPrompt(name: string): string {
	return `<firecode_worker name="${name}">\n${WORKER_PROMPT}\n</firecode_worker>`;
}
