import { afterEach, expect, test } from "bun:test";
import { registerQuota } from "../session/quota.ts";
import { fakePi } from "./fake-pi.ts";

const anthropic = { limits: [
	{ kind: "session", percent: 0, is_active: false },
	{ kind: "weekly_all", percent: 37, is_active: false },
	{ kind: "weekly_scoped", percent: 67, is_active: true, scope: { model: { display_name: "Fable" } } },
] };
const codex = { rate_limit: {
	primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
	secondary_window: { used_percent: 38, limit_window_seconds: 604_800 },
} };
const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 第三方额度接口以替换全局 fetch 的方式桩掉，用例结束后恢复。 */
function setup(fetcher: typeof fetch, oauth = ["openai-codex", "anthropic"]) {
	const fake = fakePi();
	const messages: string[] = [];
	const models = ["openai-codex", "anthropic"].map((provider) => ({ provider, id: "test" }));
	globalThis.fetch = fetcher;
	registerQuota(fake.pi);
	const ctx = {
		modelRegistry: {
			getAll: () => models,
			isUsingOAuth: (model: any) => oauth.includes(model.provider),
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: provider === "anthropic" ? "test-claude" : jwt } }),
		},
		ui: { notify: (message: string) => messages.push(message) },
	};
	return { run: (args = "") => fake.commands.get("quota").handler(args, ctx), messages, fake, ctx };
}

test("/quota 并行查询 Codex 与 Claude，报出剩余额度（含 Fable），请求带各自的账号头", async () => {
	const calls: Array<{ url: string; headers: Headers }> = [];
	const s = setup((async (url: string, options: RequestInit) => {
		calls.push({ url, headers: new Headers(options.headers) });
		return Response.json(url.includes("anthropic") ? anthropic : codex);
	}) as typeof fetch);
	await s.run();
	const report = s.messages.at(-1)!;
	expect(report).toMatch(/Codex[^\n]*80%[^\n]*62%/u);
	expect(report).toMatch(/Claude[^\n]*100%[^\n]*63%[^\n]*33%/u);
	expect(calls.find((call) => call.url.includes("chatgpt"))?.headers.get("ChatGPT-Account-Id")).toBe("test-account");
	expect(calls.find((call) => call.url.includes("anthropic"))?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
});

test("未登录不发请求，一家失败不隐藏另一家结果也不泄露响应体，缺少 Fable 不冒充零额度，接口结构变化明确失败", async () => {
	let calls = 0;
	const s = setup((async () => { calls++; return Response.json({ limits: anthropic.limits.slice(0, 2) }); }) as typeof fetch, ["anthropic"]);
	await s.run();
	expect(calls).toBe(1);
	expect(s.messages.at(-1)).not.toMatch(/Fable[^\n]*0%/u);
	const partial = setup((async (url: string) => url.includes("anthropic") ? new Response("secret body", { status: 429 }) : Response.json(codex)) as typeof fetch);
	await partial.run();
	expect(partial.messages.at(-1)).toContain("80%");
	expect(partial.messages.at(-1)).toContain("429");
	expect(partial.messages.at(-1)).not.toContain("secret body");
	const changed = setup((async () => Response.json({ unexpected: true })) as typeof fetch);
	await changed.run();
	expect(changed.messages.at(-1)).toContain("额度响应格式已变化");
});
