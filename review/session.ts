import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelValue } from "../config.js";
import { msg } from "../messages.js";
import type { InProcessSessionPool } from "../spawn.js";
import type { PromptLayers } from "./prompt.js";
import { textOf } from "../format.js";

export type ReviewSessionResult =
	| { kind: "output"; text: string }
	| { kind: "empty" }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

export interface ReviewModelConfig {
	model: string;
	thinking: ThinkingLevelValue;
	tools: string[];
	timeoutMs: number;
}

interface ReviewSessionRequest {
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
}

/** 开一个隔离的内存会话跑一次提问，把结局归成 ReviewSessionResult；审查者与顾问共用。 */
export async function runReviewSession(
	pool: InProcessSessionPool,
	{ config, prompt, cwd, signal }: ReviewSessionRequest,
): Promise<ReviewSessionResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let spawned: Awaited<ReturnType<InProcessSessionPool["spawn"]>>;
	// 会话里的扩展出错没有自己的状态：并进这一票的错误原因，让用户看到它而不是只看到“无输出”。
	const extensionFailures: string[] = [];
	try {
		spawned = await pool.spawn({
			cwd,
			model: await pool.resolveModel(config.model),
			thinking: config.thinking,
			tools: config.tools,
			systemPrompt: { mode: "replace", text: clean(prompt.system) },
			contextFiles: false,
			persistence: { type: "memory" },
			isolated: true,
			onExtensionError: (error) => extensionFailures.push(msg.spawn.extensionFailed(error.event, error.error)),
		});
	} catch (error) {
		return signal?.aborted
			? { kind: "aborted" }
			: { kind: "error", message: errorText(error) };
	}
	if (signal?.aborted) {
		await spawned.dispose();
		return { kind: "aborted" };
	}

	let finalText: string | undefined;
	let finalError: string | undefined;
	const unsubscribe = spawned.session.subscribe((event) => {
		const assistant = assistantMessage(event);
		if (assistant) {
			finalText = textOf(assistant.content);
			finalError = assistant.stopReason === "error"
				? assistant.errorMessage || "model error"
				: undefined;
		}
	});
	let interrupted: "aborted" | "timeout" | undefined;
	let wake!: () => void;
	const interruption = new Promise<void>((resolve) => { wake = resolve; });
	const onAbort = () => { interrupted = "aborted"; wake(); };
	signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => { interrupted = "timeout"; wake(); }, config.timeoutMs);
	try {
		const run = spawned.prompt(clean(prompt.user)).catch((error) => {
			finalError = errorText(error);
		});
		await Promise.race([run, interruption]);
		// 中断只靠 finally 的 dispose 收尾：pi 的 abort 在模型流卡死时永不返回，等它会拖住整个关闭链。
		if (interrupted) return { kind: interrupted };
		if (finalError) return { kind: "error", message: [finalError, ...extensionFailures].join("；") };
		if (finalText?.trim()) return { kind: "output", text: finalText };
		return extensionFailures.length ? { kind: "error", message: extensionFailures.join("；") } : { kind: "empty" };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		await spawned.dispose();
	}
}

function assistantMessage(event: AgentSessionEvent): {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
} | undefined {
	if (event.type === "message_end") return event.message.role === "assistant" ? event.message : undefined;
	if (event.type !== "agent_end") return undefined;
	return [...event.messages].reverse().find((message) => message.role === "assistant");
}

function clean(text: string): string {
	return text.replaceAll("\0", "");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
