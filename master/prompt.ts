import { readPrompt } from "../i18n.js";
import { msg } from "./messages.js";

const PROMPTS = new URL("./prompts/", import.meta.url);
export const MASTER_PROMPT = readPrompt(PROMPTS, "master").trim();
export const WORKER_PROMPT = readPrompt(PROMPTS, "worker").trim();

export function assembleMasterPrompt(prompt: string, roster: string): string {
	return `${prompt}\n\n${msg.roster.prompt(roster)}`;
}

export function assembleWorkerPrompt(prompt: string, name: string): string {
	return `<firecode_worker name="${name}">\n${prompt}\n</firecode_worker>`;
}
