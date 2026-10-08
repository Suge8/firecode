import { describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

type Event = Record<string, unknown>;

function fakeRuntime(run: (emit: (event: Event) => void, aborted: Promise<void>) => Promise<void>) {
	let listener: ((event: Event) => void) | undefined;
	let abort!: () => void;
	const aborted = new Promise<void>((resolve) => { abort = resolve; });
	const session = {
		subscribe(next: (event: Event) => void) { listener = next; return () => { listener = undefined; }; },
		// 模型流卡在半开连接上时 pi 的 abort 永不返回；运行器只能靠 dispose 收尾，不得等它。
		abort: () => new Promise<void>(() => {}),
	};
	const pool = {
		options: undefined as Record<string, unknown> | undefined,
		resolveModel: async () => ({ id: "model" }),
		async spawn(options: Record<string, unknown>) {
			this.options = options;
			return {
				session,
				prompt: async () => run((event) => listener?.(event), aborted),
				dispose() { abort(); },
			};
		},
	};
	return { pool, session };
}

/** 经生产入口 createReviewSessionRunner 跑一场审查会话：池在构造时注入，其余是每次调用的选项。 */
async function runner() {
	const { createReviewSessionRunner } = await loadFirecodeModule("review/session.js") as {
		createReviewSessionRunner: (pool: unknown) => (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
	};
	return { runReviewSession: ({ pool, ...options }: Record<string, unknown>) => createReviewSessionRunner(pool)(options) };
}

const config = { model: "provider/model", thinking: "high", tools: ["read", "bash", "write", "edit"], timeoutMs: 1_000 };
const base = (pool: unknown) => ({
	pool,
	role: "reviewer",
	config,
	prompt: { system: "policy", user: "evidence" },
	cwd: process.cwd(),
});

describe("review in-process session", () => {
	test("returns the complete assistant output", async () => {
		const body = `PASS\n${"完整结论 ".repeat(4000)}`;
		const runtime = fakeRuntime(async (emit) => {
			emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
			emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: body }] } });
		});
		const { runReviewSession } = await runner();
		const result = await runReviewSession(base(runtime.pool));
		expect(result).toEqual({ kind: "output", text: body });
		expect(runtime.pool.options).toMatchObject({
			role: "reviewer",
			tools: ["read", "bash"],
			contextFiles: false,
			isolated: true,
			persistence: { type: "memory" },
			systemPrompt: { mode: "replace", text: "policy" },
		});
	});

	test("a successful retry replaces the transient error result", async () => {
		const runtime = fakeRuntime(async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary failure" }],
					stopReason: "error",
					errorMessage: "429 rate limited",
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "PASS\n重试成功" }],
					stopReason: "stop",
				},
			});
		});
		const { runReviewSession } = await runner();
		expect(await runReviewSession(base(runtime.pool))).toEqual({
			kind: "output",
			text: "PASS\n重试成功",
		});
	});

	test("caller cancellation returns without waiting for the session to settle", async () => {
		const runtime = fakeRuntime(async (_emit, aborted) => aborted);
		const controller = new AbortController();
		const { runReviewSession } = await runner();
		const pending = runReviewSession({ ...base(runtime.pool), signal: controller.signal });
		controller.abort();
		expect(await pending).toEqual({ kind: "aborted" });
	});

	test("deadline expiry returns timeout without waiting for the session to settle", async () => {
		const runtime = fakeRuntime(async (_emit, aborted) => aborted);
		const { runReviewSession } = await runner();
		expect(await runReviewSession({ ...base(runtime.pool), config: { ...config, timeoutMs: 5 } })).toEqual({ kind: "timeout" });
	});
});
