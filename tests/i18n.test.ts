import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

const CJK = /[\u3400-\u9fff]/u;

test("顶层 language 压过系统 locale；省略时跟随系统 locale（zh 开头为中文，其余英文）", async () => {
	const today = async (configJsonc: string) => ((await loadFirecodeModule("messages.ts", { configJsonc })) as any).msg.today("D");
	expect(await today(JSON.stringify({ language: "en" }))).toBe("Today is D.");
	expect(await today(JSON.stringify({ language: "zh" }))).toBe("今天是 D。");

	const saved = process.env.LC_ALL;
	try {
		for (const [locale, expected] of [["en_US.UTF-8", "Today is D."], ["ja-JP", "Today is D."], ["zh_TW.UTF-8", "今天是 D。"]]) {
			process.env.LC_ALL = locale;
			expect(await today(JSON.stringify({ features: {}, locale }))).toBe(expected);
		}
	} finally {
		process.env.LC_ALL = saved;
	}
});

test("session：en 下 /quota 输出英文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { fakePi } = await import("./fake-pi.ts");

	const { registerQuota } = await loadFirecodeModule("session/quota.ts", { configJsonc }) as any;
	const quota = fakePi();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => Response.json(url.includes("anthropic")
		? { limits: [{ kind: "session", percent: 0 }, { kind: "weekly_all", percent: 37 }] }
		: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } })) as typeof fetch;
	registerQuota(quota.pi);
	const notices: string[] = [];
	const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString("base64url")}.test`;
	const models = ["openai-codex", "anthropic"].map((provider) => ({ provider, id: "test" }));
	try {
		await quota.commands.get("quota").handler("", {
			modelRegistry: { getAll: () => models, isUsingOAuth: () => true, getProviderAuth: async (provider: string) => ({ auth: { apiKey: provider === "anthropic" ? "t" : jwt } }) },
			ui: { notify: (message: string) => notices.push(message) },
		});
	} finally {
		globalThis.fetch = realFetch;
	}
	expect(notices.at(-1)).toContain("80%");
	expect(notices.join("\n")).not.toMatch(CJK);
});
