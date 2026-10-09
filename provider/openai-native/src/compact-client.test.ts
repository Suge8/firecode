import { afterEach, expect, mock, test } from "bun:test";
import { executeNativeCompaction } from "./compact-client.js";
import type { NativeCompactionRuntime } from "./native-runtime.js";

const baseModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	name: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"] as Array<"text" | "image">,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

function createJwtWithAccountId(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function createRuntime(overrides: Partial<NativeCompactionRuntime> = {}): NativeCompactionRuntime {
	return {
		provider: "openai",
		api: "openai-responses",
		model: baseModel.id,
		baseUrl: baseModel.baseUrl,
		apiKey: "sk-test",
		responsesUrl: "https://api.openai.com/v1/responses",
		currentModel: baseModel,
		...overrides,
	};
}

const savedFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = savedFetch;
});

test("executeNativeCompaction posts a compaction_trigger to the responses endpoint", async () => {
	const token = createJwtWithAccountId("acct_123");
	let fetchArgs: { url?: string; init?: RequestInit } = {};
	const compactionItem = { type: "compaction", encrypted_content: "opaque" };
	const userItem = { role: "user", content: [{ type: "input_text", text: "hello" }] };
	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		fetchArgs = { url: String(url), init };
		return new Response(
			JSON.stringify({
				created_at: "2026-04-12T00:00:00.000Z",
				output: [
					{ type: "message", role: "assistant", content: [] },
					compactionItem,
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const result = await executeNativeCompaction({
		runtime: createRuntime({
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1",
			baseUrl: "https://chatgpt.com/backend-api",
			apiKey: token,
			headers: {
				"x-test-model-header": null,
				"x-test-runtime-header": "resolved",
			},
			responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
			currentModel: {
				...baseModel,
				headers: { "x-test-model-header": "removed" },
				provider: "openai-codex",
				api: "openai-codex-responses",
				id: "gpt-5.1",
				name: "gpt-5.1",
				baseUrl: "https://chatgpt.com/backend-api",
			},
		}),
		request: {
			model: "gpt-5.1",
			instructions: "compact this",
			input: [
				userItem,
				{ type: "message", role: "assistant", status: "completed", content: [] },
				{ type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
			],
		},
	});

	expect(result).toEqual({
		ok: true,
		compactedWindow: [userItem, compactionItem],
		createdAt: "2026-04-12T00:00:00.000Z",
	});
	expect(fetchArgs.url).toBe("https://chatgpt.com/backend-api/codex/responses");
	const headers = new Headers(fetchArgs.init?.headers);
	expect(headers.has("x-test-model-header")).toBe(false);
	expect(headers.get("x-test-runtime-header")).toBe("resolved");
	expect(headers.get("authorization")).toBe(`Bearer ${token}`);
	expect(headers.get("chatgpt-account-id")).toBe("acct_123");
	expect(headers.get("originator")).toBe("pi");
	expect(headers.get("openai-beta")).toBe("responses=experimental");
	expect(JSON.parse(String(fetchArgs.init?.body))).toEqual({
		model: "gpt-5.1",
		instructions: "compact this",
		store: false,
		stream: true,
		input: [
			userItem,
			{ type: "message", role: "assistant", status: "completed", content: [] },
			{ type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
			{ type: "compaction_trigger" },
		],
	});
});

test("executeNativeCompaction accepts a streamed responses payload", async () => {
	const compactionItem = { type: "compaction", encrypted_content: "streamed" };
	const userItem = { role: "user", content: "keep me" };
	globalThis.fetch = mock(async () =>
		new Response(
			[
				"event: response.output_item.done",
				`data: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}`,
				"",
				"event: response.completed",
				`data: ${JSON.stringify({
					type: "response.completed",
					response: { created_at: "2026-04-12T00:00:00.000Z", output: [] },
				})}`,
				"",
				"data: [DONE]",
				"",
			].join("\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		),
	) as typeof fetch;

	const result = await executeNativeCompaction({
		runtime: createRuntime(),
		request: {
			model: baseModel.id,
			instructions: "compact this",
			input: [userItem, { type: "compaction", encrypted_content: "stale" }],
		},
	});

	expect(result).toEqual({
		ok: true,
		compactedWindow: [userItem, compactionItem],
		createdAt: "2026-04-12T00:00:00.000Z",
	});
});

const failureRequest = { model: baseModel.id, instructions: "compact this", input: [{ role: "user", content: "hello" }] };

test.each([
	[
		"a failed Responses event over the context window",
		() => new Response(
			[
				"event: response.failed",
				`data: ${JSON.stringify({
					type: "response.failed",
					response: { status: "failed", error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } },
				})}`,
				"",
				"data: [DONE]",
				"",
			].join("\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		),
		{
			reason: "input-too-large",
			status: 200,
			detail: '{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}',
		},
	],
	[
		"any other failed response",
		() => Response.json({ status: "failed", error: { code: "server_error", message: "The response failed while processing." } }),
		{ reason: "response-failed", status: 200, detail: '{"code":"server_error","message":"The response failed while processing."}' },
	],
	[
		"a response without exactly one compaction item",
		() => Response.json({ output: [{ type: "message", role: "assistant", content: [] }] }),
		{ reason: "missing-compaction", status: 200 },
	],
	[
		"an HTTP error, keeping the provider's validation message",
		() => Response.json({ error: { message: "Invalid input type 'compaction_trigger'." } }, { status: 400 }),
		{ reason: "non-2xx", status: 400, detail: "Invalid input type 'compaction_trigger'." },
	],
])("executeNativeCompaction reports %s", async (_name, respond, failure) => {
	globalThis.fetch = mock(async () => respond()) as typeof fetch;

	expect(await executeNativeCompaction({ runtime: createRuntime(), request: failureRequest })).toEqual({ ok: false, ...failure });
});
