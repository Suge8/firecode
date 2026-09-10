import { expect, test } from "bun:test";
import { registerQuota } from "../session/quota.ts";

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

function setup(fetcher: typeof fetch, oauth = ["openai-codex", "anthropic"]) {
	let command: any;
	const events = new Map<string, Function>();
	const messages: string[] = [];
	const models = ["openai-codex", "anthropic"].map((provider) => ({ provider, id: "test" }));
	registerQuota({
		registerCommand(name, definition) { expect(name).toBe("quota"); command = definition; },
		on(name: string, handler: Function) { events.set(name, handler); },
	} as never, fetcher);
	const ctx = {
		modelRegistry: {
			getAll: () => models,
			isUsingOAuth: (model: any) => oauth.includes(model.provider),
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: provider === "anthropic" ? "test-claude" : jwt } }),
		},
		ui: { notify: (message: string) => messages.push(message) },
	};
	return { run: (args = "") => command.handler(args, ctx), messages, events, ctx };
}

test("额度仅由命令并行查询，读取现代 Claude 窗口及 Fable，不把非活跃标记当作无额度", async () => {
	const calls: Array<{ url: string; headers: Headers }> = [];
	const pending: Array<() => void> = [];
	const s = setup(((url: string, options: RequestInit) => {
		calls.push({ url, headers: new Headers(options.headers) });
		return new Promise<Response>((resolve) => pending.push(() => resolve(Response.json(url.includes("anthropic") ? anthropic : codex))));
	}) as typeof fetch);
	expect(calls).toEqual([]);
	expect(s.events.has("agent_end")).toBe(false);
	const run = s.run();
	await new Promise((resolve) => setImmediate(resolve));
	expect(calls).toHaveLength(2);
	await s.run();
	expect(calls).toHaveLength(2);
	expect(s.messages.at(-1)).toContain("正在查询");
	pending.forEach((resolve) => resolve());
	await run;
	const report = s.messages.at(-1)!;
	expect(report).toContain("查询于");
	expect(report).toContain("Codex：5小时剩余 80% ｜ 本周剩余 62%");
	expect(report).toContain("Claude：5小时剩余 100% ｜ 本周剩余 63% ｜ Fable 本周剩余 33%");
	expect(calls.find((call) => call.url.includes("chatgpt"))?.headers.get("ChatGPT-Account-Id")).toBe("test-account");
	expect(calls.find((call) => call.url.includes("anthropic"))?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
	const again = s.run();
	await new Promise((resolve) => setImmediate(resolve));
	expect(calls).toHaveLength(4);
	pending.slice(2).forEach((resolve) => resolve());
	await again;
});

test("未登录不发请求，一家失败不隐藏另一家结果，缺少 Fable 不冒充零额度", async () => {
	let calls = 0;
	const s = setup((async () => { calls++; return Response.json({ limits: anthropic.limits.slice(0, 2) }); }) as typeof fetch, ["anthropic"]);
	await s.run();
	expect(calls).toBe(1);
	expect(s.messages.at(-1)).toContain("Codex：未通过 Pi OAuth 登录");
	expect(s.messages.at(-1)).toContain("Fable 本周：未提供独立额度");
	const partial = setup((async (url: string) => url.includes("anthropic") ? new Response("secret body", { status: 429 }) : Response.json(codex)) as typeof fetch);
	await partial.run();
	expect(partial.messages.at(-1)).toContain("Codex：5小时剩余 80%");
	expect(partial.messages.at(-1)).toContain("Claude：查询失败（HTTP 429）");
	expect(partial.messages.at(-1)).not.toContain("secret body");
});

test("接口结构变化明确失败，会话退出取消在途查询，不投递迟到通知", async () => {
	const changed = setup((async () => Response.json({ unexpected: true })) as typeof fetch);
	await changed.run();
	expect(changed.messages.at(-1)).toContain("额度响应格式已变化");
	let signal: AbortSignal | undefined;
	const s = setup(((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
		signal = options.signal!;
		signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
	})) as typeof fetch, ["anthropic"]);
	const run = s.run();
	await new Promise((resolve) => setImmediate(resolve));
	const notices = s.messages.length;
	s.events.get("session_shutdown")!();
	await run;
	expect(signal?.aborted).toBe(true);
	expect(s.messages).toHaveLength(notices);
});
