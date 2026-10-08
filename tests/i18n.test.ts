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

test("review 配置读取顶层 language", async () => {
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly("review"), language: "en", review: TEST_REVIEW_CONFIG }),
	}) as any;
	expect(loadConfig().review.config.language).toBe("en");
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
