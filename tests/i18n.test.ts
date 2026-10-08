import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, featuresOnly, loadFirecodeModule, TEST_REVIEW_CONFIG } from "./loader.ts";

afterEach(cleanupFirecodeModules);

const CJK = /[\u3400-\u9fff]/u;

test("系统 locale：zh 开头为中文，其余为英文", async () => {
	const { inferLanguage } = await loadFirecodeModule("i18n.ts") as any;
	for (const locale of ["zh", "zh-CN", "zh_TW.UTF-8", "ZH_cn"]) expect(inferLanguage(locale)).toBe("zh");
	for (const locale of ["en_US.UTF-8", "ja-JP", "C", "", undefined]) expect(inferLanguage(locale)).toBe("en");
});

test("顶层 language 压过系统 locale；省略时跟随系统 locale", async () => {
	const explicit = await loadFirecodeModule("i18n.ts", { configJsonc: JSON.stringify({ language: "en" }) }) as any;
	expect(explicit.LANGUAGE).toBe("en");

	const saved = process.env.LC_ALL;
	process.env.LC_ALL = "en_US.UTF-8";
	try {
		const inferred = await loadFirecodeModule("i18n.ts", { configJsonc: JSON.stringify({ features: {} }) }) as any;
		expect(inferred.LANGUAGE).toBe("en");
	} finally {
		process.env.LC_ALL = saved;
	}
});

test("language 取值非法与旧的 review.language 都报配置问题，不留兼容", async () => {
	const features = await featuresOnly();
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({ features, language: "fr" }),
	}) as any;
	expect(loadConfig().problems).toEqual(["language 必须是 zh 或 en"]);

	const legacy = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({ features: { ...features, review: true }, review: { ...TEST_REVIEW_CONFIG, language: "zh" } }),
	}) as any;
	expect(legacy.loadConfig().problems).toEqual(["未知字段 review.language"]);
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

test("审查者按 en 提示词写的输出契约被解析；校验报错、证据截断标记与会话证据标签都是英文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { parseReviewOutput } = await loadFirecodeModule("review/reviewer.ts", { configJsonc }) as any;
	const passed = parseReviewOutput("PASS\nLooks right.\nEvidence: files=src/a.ts; commands=bun test");
	expect(passed.status).toBe("passed");

	const missing = parseReviewOutput("FAIL\n## Finding 1: x\n- **Severity**: High\n- **Issue**: x");
	expect(missing).toMatchObject({ status: "error" });
	expect(missing.details).toBe("review output format invalid: FAIL finding 1 is missing required fields: Evidence, Violated agreement & expected behavior, Verification command");

	const { buildEvidence } = await loadFirecodeModule("review/evidence.ts", { configJsonc }) as any;
	const entry = (role: string, content: string) => ({ type: "message", message: { role, content } });
	const { text } = buildEvidence([entry("user", "write"), entry("assistant", "x".repeat(5_000))], { sessionFile: "/tmp/s/main.jsonl" });
	expect(text).toContain("## User");
	expect(text).toContain("evidence truncated: this message has 5000 characters");
	expect(text).toContain("/tmp/s/main.jsonl");
	expect(text).not.toMatch(CJK);
});

test("修复反馈与顾问卡在 en 下是英文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { buildFixFeedback } = await loadFirecodeModule("review/prompt.ts", { configJsonc }) as any;
	const feedback = buildFixFeedback({ details: "FAIL\nx", advisor: { verdict: "narrow", advice: "only the blocker" } });
	expect(feedback).toContain("Advisor scope (authoritative):");
	expect(feedback).not.toMatch(CJK);

	const { buildCard } = await loadFirecodeModule("review/card.ts", { configJsonc }) as any;
	const advisor = buildCard({ kind: "advisor", advisor: { verdict: "continue", advice: "keep going" }, advisorModel: "p/adv", elapsedMs: 1000 });
	expect(advisor.details.title).toBe("Advisor guidance · Continue fixing");
	expect(advisor.details.lines[0]).toBe("**Model · adv**");
});

test("session：en 下 /quota 与 /tokens 输出英文，herdr 标签与预设提示同样", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { fakePi } = await import("./fake-pi.ts");

	const { registerQuota } = await loadFirecodeModule("session/quota.ts", { configJsonc }) as any;
	const quota = fakePi();
	registerQuota(quota.pi, (async (url: string) => Response.json(url.includes("anthropic")
		? { limits: [{ kind: "session", percent: 0 }, { kind: "weekly_all", percent: 37 }] }
		: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } })) as typeof fetch);
	const notices: string[] = [];
	const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString("base64url")}.test`;
	const models = ["openai-codex", "anthropic"].map((provider) => ({ provider, id: "test" }));
	await quota.commands.get("quota").handler("", {
		modelRegistry: { getAll: () => models, isUsingOAuth: () => true, getProviderAuth: async (provider: string) => ({ auth: { apiKey: provider === "anthropic" ? "t" : jwt } }) },
		ui: { notify: (message: string) => notices.push(message) },
	});
	expect(notices.at(-1)).toContain("Codex: 5h 80% left");
	expect(notices.at(-1)).toContain("Claude: 5h 100% left | Weekly 63% left");
	expect(notices.join("\n")).not.toMatch(CJK);

	const { registerStats } = await loadFirecodeModule("session/stats.ts", { configJsonc }) as any;
	const stats = fakePi();
	registerStats(stats.pi);
	const printed: string[] = [];
	const log = console.log;
	console.log = (line: string) => void printed.push(line);
	try {
		await stats.commands.get("tokens").handler("7", { mode: "print", hasUI: false });
	} finally {
		console.log = log;
	}
	expect(printed.join("\n")).toContain("# Token usage");
	expect(printed.join("\n")).not.toMatch(CJK);
});

test("观察员：en 时建议信封与系统提示都是英文，zh 时是中文", async () => {
	const configJsonc = JSON.stringify({ language: "en" });
	const { adviceMessage } = await loadFirecodeModule("watcher/card.js", { configJsonc }) as any;
	const message = adviceMessage({ note: "The rollback path is missing", turnIndex: 7 });
	expect(message).toStartWith("<firecode_watcher>\n");
	expect(message).toContain("turn 7");
	expect(message).not.toMatch(CJK);

	const { createObserver } = await loadFirecodeModule("watcher/observer.js", { configJsonc }) as any;
	let spawned: any;
	const pool = { spawn: async (options: unknown) => (spawned = options, { prompt: async () => {}, session: {}, dispose: async () => {} }) };
	await createObserver({ cwd: "/", model: {}, thinking: "low", pool });
	expect(spawned.systemPrompt.text).not.toMatch(CJK);
	expect(spawned.customTools[0].description).not.toMatch(CJK);

	const zh = await loadFirecodeModule("watcher/observer.js") as any;
	await zh.createObserver({ cwd: "/", model: {}, thinking: "low", pool });
	expect(spawned.systemPrompt.text).toMatch(CJK);
});
