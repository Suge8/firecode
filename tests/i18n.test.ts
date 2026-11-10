import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";
import { reviewVoter } from "./review-vote.ts";

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

// 解析与生产共用 review/messages.ts 的字段名；会话历史可能跨语言，所以两种语言的旧卡片都要能预览。
test("审查卡：machine 预览在 en 下取自同源字段名，切换语言前的中文旧卡片同样能解析", async () => {
	const en = JSON.stringify({ language: "en" });
	const enCard = await loadFirecodeModule("review/card.ts", { configJsonc: en }) as any;
	const zhCard = await loadFirecodeModule("review/card.ts") as any;
	const { machineEntries } = await loadFirecodeModule("tools/machine.ts", { configJsonc: en }) as any;
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts") as any;
	const preview = (built: any) => machineEntries(wrapEnvelope("firecode_review", built.content), built.details)[0];

	const failed = enCard.buildCard({ kind: "fail", round: 2, details: "Model 1 · m\n## Finding 1: Token never expires\n- **Severity**: High", advisor: null, elapsedMs: 1000 });
	expect(failed.details.title).toBe("Round 2 Review failed");
	expect(preview(failed)).toMatchObject({ title: "Round 2 Review failed", preview: "Token never expires", alarm: true });

	const errored = enCard.buildCard({ kind: "error", message: "provider down", elapsedMs: 1000 });
	expect(preview(errored)).toMatchObject({ title: "Review incomplete", preview: "provider down", alarm: true });

	const oldZh = zhCard.buildCard({ kind: "fail", round: 1, details: "模型 1 · m\n## 发现 1：令牌永不过期\n- **严重程度**: 高", advisor: null, elapsedMs: 1000 });
	expect(preview(oldZh)).toMatchObject({ title: "审查未通过", preview: "令牌永不过期" });
	expect(preview(zhCard.buildCard({ kind: "error", message: "供应商报错" }))).toMatchObject({ preview: "供应商报错" });
});

test("en：审查者格式不全的阻断发现仍判未通过，违例说明与会话证据不含中文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const voter = await reviewVoter({ configJsonc });
	const missing = await voter.vote("Checked a.ts.\nEvidence: files=a.ts; commands=bun test\n## Finding 1: x\n- **Condition**: every restart\n- **Frequency**: 10\n- **Impact**: 8\n- **Issue**: x");
	await voter.close();
	expect(missing.status).toBe("failed");
	expect(missing.details).not.toMatch(CJK);

	const { buildEvidence } = await loadFirecodeModule("review/evidence.ts", { configJsonc }) as any;
	const entry = (role: string, content: string) => ({ type: "message", message: { role, content } });
	const text = buildEvidence([entry("user", "write"), entry("assistant", "x".repeat(5_000))], { sessionFile: "/tmp/s/main.jsonl" });
	expect(text).not.toMatch(CJK);
});

test("修复反馈与顾问卡在 en 下是英文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { buildFixFeedback } = await loadFirecodeModule("review/prompt.ts", { configJsonc }) as any;
	for (const verdict of ["narrow", "continue"])
		expect(buildFixFeedback({ details: "FAIL\nx", advisor: { verdict, advice: "only the blocker" } })).not.toMatch(CJK);

	const { buildCard } = await loadFirecodeModule("review/card.ts", { configJsonc }) as any;
	const advisor = buildCard({ kind: "advisor", advisor: { verdict: "continue", advice: "keep going" }, advisorModel: "p/adv", elapsedMs: 1000 });
	expect([advisor.details.title, ...advisor.details.lines].join("\n")).not.toMatch(CJK);
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
