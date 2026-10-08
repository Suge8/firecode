import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelValue } from "../config.js";
import type { InProcessSessionPool } from "../master/spawn.js";
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

export interface ReviewSessionRequest {
	role: "reviewer" | "advisor";
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
}

export type ReviewSessionRunner = (request: ReviewSessionRequest) => Promise<ReviewSessionResult>;

export function createReviewSessionRunner(pool: InProcessSessionPool): ReviewSessionRunner {
	return (request) => runReviewSession(pool, request);
}

async function runReviewSession(
	pool: InProcessSessionPool,
	{ role, config, prompt, cwd, signal }: ReviewSessionRequest,
): Promise<ReviewSessionResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let spawned: Awaited<ReturnType<InProcessSessionPool["spawn"]>>;
	try {
		spawned = await pool.spawn({
			cwd,
			role,
			model: await pool.resolveModel(config.model),
			thinking: config.thinking,
			tools: [...new Set(config.tools)].filter((tool) => tool !== "write" && tool !== "edit"),
			systemPrompt: { mode: "replace", text: clean(prompt.system) },
			contextFiles: false,
			persistence: { type: "memory" },
			isolated: true,
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
		if (finalError) return { kind: "error", message: finalError };
		return finalText?.trim() ? { kind: "output", text: finalText } : { kind: "empty" };
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
