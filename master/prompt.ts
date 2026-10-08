import { readPrompt } from "../i18n.js";
import { msg } from "./messages.js";

const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

export type MasterPromptKind = "master" | "worker";

export function readMasterPrompt(kind: MasterPromptKind): string {
	let prompt: string;
	try {
		prompt = readPrompt(PROMPTS_DIR, kind);
	} catch (error) {
		throw new Error(msg.prompt.readFailed(kind, error instanceof Error ? error.message : String(error)));
	}
	if (!prompt.trim()) throw new Error(msg.prompt.empty(kind));
	return prompt.trim();
}

export function assembleMasterPrompt(prompt: string, roster: string): string {
	return `${prompt}\n\n${msg.roster.prompt(roster)}`;
}

export function assembleWorkerPrompt(prompt: string, name: string): string {
	return `<firecode_worker name="${name}">\n${prompt}\n</firecode_worker>`;
}
