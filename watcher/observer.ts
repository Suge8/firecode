/**
 * 观察会话：进程内 memory 子会话 + 只读工具 + 唯一自定义工具 advise。
 * 系统提示以 prompts/watch.{zh,en}.md 为唯一事实源（整体替换，不受项目文件改写）。
 */
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { InProcessSessionPool } from "../master/spawn.js";
import type { ThinkingLevelValue } from "../config.js";
import { readPrompt } from "../i18n.js";
import { msg } from "./messages.js";

const PROMPTS = new URL("./prompts/", import.meta.url);
const OBSERVER_TOOLS = ["read", "grep", "find", "ls", "advise"];

export interface Observer {
	/** 喂一段增量并等待评估；至多返回一条建议。 */
	evaluate(increment: string): Promise<string | undefined>;
	/** 观察会话自身上下文占比（百分数），未知时 undefined。 */
	contextPercent(): number | undefined;
	dispose(): Promise<void>;
}

interface ObserverOptions {
	cwd: string;
	model: Model<any>;
	thinking: ThinkingLevelValue;
	pool: InProcessSessionPool;
}

export async function createObserver(options: ObserverOptions): Promise<Observer> {
	let advice: string | undefined;
	const spawned = await options.pool.spawn({
		cwd: options.cwd,
		role: "observer",
		model: options.model,
		thinking: options.thinking,
		tools: OBSERVER_TOOLS,
		customTools: [adviseTool(() => advice, (note) => { advice = note; })],
		systemPrompt: { mode: "replace", text: readPrompt(PROMPTS, "watch") },
		contextFiles: true,
		persistence: { type: "memory" },
	});
	return {
		async evaluate(increment) {
			advice = undefined;
			await spawned.prompt(increment);
			return advice;
		},
		contextPercent: () => spawned.session.getContextUsage?.()?.percent ?? undefined,
		dispose: () => spawned.dispose(),
	};
}

function adviseTool(current: () => string | undefined, capture: (note: string) => void) {
	return {
		name: "advise",
		label: msg.advise.label,
		description: msg.advise.description,
		parameters: Type.Object({
			note: Type.String({ description: msg.advise.noteDescription }),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			if (current()) throw new Error(msg.advise.alreadySubmitted);
			const note = typeof params.note === "string" ? params.note.trim() : "";
			if (!note) throw new Error(msg.advise.emptyNote);
			capture(note);
			return { content: [{ type: "text" as const, text: msg.advise.recorded }], details: undefined };
		},
	};
}
