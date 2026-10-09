import { describe, expect, test } from "bun:test";
import { resolveNativeCompactionRuntime, resolveNativeCompactionTarget } from "../src/native-runtime.js";

function createContext(args: {
	provider?: string;
	api?: string;
	id?: string;
	baseUrl?: string;
	getApiKeyAndHeaders?: () => Promise<unknown>;
} = {}) {
	return {
		model: {
			provider: args.provider ?? "openai",
			api: args.api ?? "openai-responses",
			id: args.id ?? "gpt-5.4",
			baseUrl: args.baseUrl ?? "https://example.com/v1",
		},
		modelRegistry: {
			getApiKeyAndHeaders:
				args.getApiKeyAndHeaders ??
				(async () => ({
					ok: true,
					apiKey: "sk-openai",
					headers: { "x-test-request-header": "present" },
				})),
		},
	} as never;
}

const CODEX = { provider: "openai-codex", api: "openai-codex-responses" };

describe("native compaction runtime", () => {
	test.each([
		["openai", {}, "https://example.com/v1", "https://example.com/v1/responses"],
		["openai, base already ends in /responses", {}, "https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"],
		["codex backend root", CODEX, "https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex/responses"],
		["codex base ends in /codex", CODEX, "https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex/responses"],
		["codex base ends in /codex/responses", CODEX, "https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex/responses"],
	])("resolves the responses URL: %s", (_name, provider, baseUrl, responsesUrl) => {
		expect(resolveNativeCompactionTarget(createContext({ ...provider, baseUrl }))).toMatchObject({ ok: true, target: { responsesUrl } });
	});

	test("resolves auth only when a native compact request is about to run", async () => {
		let authCalls = 0;
		const ctx = createContext({
			getApiKeyAndHeaders: async () => {
				authCalls += 1;
				return { ok: true, apiKey: "sk-openai", headers: { "x-test-request-header": "present" } };
			},
		});
		const target = resolveNativeCompactionTarget(ctx);
		if (!target.ok) throw new Error("Expected a native compaction target");

		expect(authCalls).toBe(0);
		expect(await resolveNativeCompactionRuntime(ctx, target.target)).toEqual({
			ok: true,
			runtime: expect.objectContaining({ apiKey: "sk-openai", headers: { "x-test-request-header": "present" } }),
		});
		expect(authCalls).toBe(1);
	});

	test("cancels native compaction when direct-provider auth has no API key", async () => {
		const ctx = createContext({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: undefined }) });
		const target = resolveNativeCompactionTarget(ctx);
		if (!target.ok) throw new Error("Expected a native compaction target");

		expect(await resolveNativeCompactionRuntime(ctx, target.target)).toEqual({ ok: false, reason: "missing-api-key" });
	});

	test("does not send native compaction to OpenAI-compatible proxies", () => {
		expect(resolveNativeCompactionTarget(createContext({ provider: "custom-litellm", baseUrl: "https://proxy.example.com/v1" })))
			.toEqual({ ok: false, reason: "unsupported-provider" });
	});
});
