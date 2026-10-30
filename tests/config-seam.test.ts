import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FIRECODE_DIR, loadFirecodeModule, featuresOnly, PI_PACKAGES } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

test("missing runtime config disables optional behavior and warns on each session_start", async () => {
	const { registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: null }) as any;
	const fake = fakePi();

	registerFirecode(fake.pi, true);

	expect([...fake.commands.keys()]).toEqual([]);
	expect([...fake.shortcuts.keys()]).toEqual([]);
	expect([...fake.tools.keys()]).toEqual([]);
	expect([...fake.messageRenderers.keys()]).toEqual(["firecode-review-card"]);
	const warnings: string[] = [];
	for (let occurrence = 0; occurrence < 2; occurrence++)
		await fake.fire("session_start", {}, { isIdle: () => true, ui: { notify: (message: string) => warnings.push(message) }, sessionManager: { getBranch: () => [] } });
	expect(warnings).toEqual([
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
	]);
});

test("runtime config enables only the switched-on feature: stats registers its commands and nothing else", async () => {
	const configJsonc = JSON.stringify({ features: await featuresOnly("stats") });
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc });
	const fake = fakePi();
	(registerFirecode as (pi: unknown) => void)(fake.pi);

	expect([...fake.entryRenderers.keys()]).toEqual([]);
	expect([...fake.commands.keys()]).toEqual(["quota", "tokens"]);
	expect([...fake.shortcuts.keys()]).toEqual([]);
});

/** 以给定的运行配置原文跑一遍 loadConfig（每份配置各自一个模块副本）。 */
async function loadFrom(configJsonc: string) {
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	return (loadConfig as () => any)();
}

test("Master 角色表按有序模型链解析", async () => {
	const features = await featuresOnly("master");
	const loaded = await loadFrom(JSON.stringify({
		features,
		master: {
			roles: {
				工程师: { model: ["test/shared/medium", "test/backup/high"], use: "实现" },
				哨兵: { model: "test/shared/low", use: "盯守" },
			},
		},
	}));
	expect(loaded.problems).toEqual([]);
	expect(loaded.master.config.roles).toEqual([
		{ role: "工程师", models: [{ model: "test/shared", thinking: "medium" }, { model: "test/backup", thinking: "high" }], use: "实现" },
		{ role: "哨兵", models: [{ model: "test/shared", thinking: "low" }], use: "盯守" },
	]);
});

// 旧写法与手误一律报出并拒绝启动对应功能，不静默回退成默认值（回退会拿用户没选的模型真实发起调用）。
test("旧写法、手误与缺失字段都被报出，对应功能拒绝启动", async () => {
	const features = await featuresOnly("master", "review");
	const rejected: [string, unknown, string][] = [
		["master 旧的分字段写法", { master: { roles: { 工程师: { model: "p/m/high", thinking: "medium", use: "x" } } } }, "未知字段 master.roles.工程师.thinking"],
		["master 无效思考档", { master: { roles: { 调研员: { model: "test/model", use: "x" } } } }, "master.roles.调研员.model 必须是“模型/thinking”字符串（思考档无效：model）"],
		["master 已删除的 fallback 字段", { master: { roles: { 工程师: { model: "p/m/low", use: "x", fallback: ["p/a/low", "p/b/low", "p/c/low"] } } } }, "未知字段 master.roles.工程师.fallback"],
		["master 空角色表", { master: { roles: {} } }, "master.roles 必须是至少包含一个角色的对象"],
		["master 旧数组写法", { master: { models: [] } }, "未知字段 master.models"],
		["review 旧的 { model, thinking } 对象", { review: { advisor: { model: "p/m", thinking: "max" } } }, "review.advisor 必须是“模型/thinking”字符串"],
		["review 已删除的审查者对象", { review: { reviewers: [{ model: "p/m/low", fallback: ["p/a/low", "p/b/low", "p/c/low"] }] } }, "review.reviewers[0] 必须是“模型/thinking”字符串"],
		["review 未知键", { review: { background: { cmd: "pi" } } }, "未知字段 review.background"],
		["review 不是对象", { review: "typo" }, "review 必须是对象"],
		["review 缺失的显式字段", { review: { maxRounds: 3 } }, "review.timeoutMinutes 必须显式配置"],
		["review.tools 不是数组", { review: { tools: "read" } }, "review.tools 必须是非空字符串数组"],
		["review.tools 为空", { review: { tools: [] } }, "review.tools 必须是非空字符串数组"],
		["review.tools 含写入工具", { review: { tools: ["read", "edit"] } }, "review.tools 不能包含 write 或 edit：审查者只读"],
		["preset 旧三字段", { presets: { old: { provider: "test", model: "model", thinkingLevel: "high" } } }, "未知字段 presets.old.thinkingLevel"],
		["已删除的 keys.cyclePreset", { keys: { cyclePreset: "ctrl+shift+u" } }, "未知字段 keys.cyclePreset"],
		["已删除的 tools 节", { tools: { replyLines: 3 } }, "未知配置节 tools"],
		["已删除的 features.rename", { features: { rename: true } }, "未知开关 features.rename，可用："],
	];
	for (const [name, section, expected] of rejected) {
		const loaded = await loadFrom(JSON.stringify({ features, ...(section as object) }));
		expect(`${name}: ${loaded.problems.some((problem: string) => problem.startsWith(expected))}`).toBe(`${name}: true`);
	}
	const broken = await loadFrom(JSON.stringify({ features, master: { roles: { 工程师: { model: "bad", use: "x" } } } }));
	expect(broken.master.error).toContain("Master 配置有问题");
	const bareReview = await loadFrom(JSON.stringify({ features, review: { advisor: "p/a/max", reviewers: ["p/r/high"] } }));
	expect(bareReview.review.error).toContain("review.maxRounds 必须显式配置");
});

// features.review 写成字符串 "false" 时因 `!== false` 仍会启用，而启用 review 意味着真实模型调用，必须报出来而不是静默放行。
test("features 不是对象时报出并全部关闭；开关不是布尔时报出", async () => {
	const broken = await loadFrom(`{ "features": "false" }`);
	expect(broken.problems.join()).toContain("features 必须是对象");
	expect(Object.values(broken.config.features).every((enabled) => enabled === false)).toBe(true);

	expect((await loadFrom(`{ "features": { "review": "false" } }`)).problems.join()).toContain("features.review 必须是 true 或 false");
});

test("配置文件读不出来时只报文件级那一条：尾逗号与 BOM 照常读，真有语法错不刷各节的派生问题", async () => {
	const features = await featuresOnly("review", "master", "watcher");
	const lenient = await loadFrom("\uFEFF" + `{ "features": ${JSON.stringify(features)}, "keys": { "fast": "alt+f", }, // note
	}`);
	expect(lenient.problems.filter((problem: string) => problem.includes("解析失败"))).toEqual([]);
	expect(lenient.config.keys.fast).toBe("alt+f");

	const broken = await loadFrom(`{ "features": { "review": true }, "master" `);
	expect(broken.problems).toHaveLength(1);
	expect(broken.problems[0]).toContain("config.jsonc 解析失败");
	for (const section of [broken.review, broken.master, broken.watcher]) {
		expect(section.error).toContain("解析失败");
		expect(section.error).not.toContain("必须");
	}
});

test("openai 节：字段拼错、类型不对都报问题，写错的字段按省略处理", async () => {
	const features = await featuresOnly("openaiNative");
	const loaded = await loadFrom(JSON.stringify({
		features,
		openai: {
			nativeCompaction: "yes",
			experimental: 1,
			providers: {
				"openai-codex": { textVerbosity: "loud", priority: "on", extra: true },
				xai: { priority: true },
				bad: "x",
			},
		},
	}));
	expect(loaded.problems).toEqual([
		"未知字段 openai.experimental",
		"openai.nativeCompaction 必须是 true 或 false",
		"未知字段 openai.providers.openai-codex.extra",
		"openai.providers.openai-codex.textVerbosity 必须是 low 或 medium 或 high",
		"openai.providers.openai-codex.priority 必须是 true 或 false",
		"openai.providers.bad 必须是对象",
	]);
	expect(loaded.config.openai).toEqual({ nativeCompaction: false, providers: { xai: { priority: true } } });
});

test("公共配置模板可解析并启用完整推荐工作流", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => any)();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["claudeSub", "claudeFiles", "openaiNative", "review", "master", "watcher"])
		expect(loaded.config.features[feature]).toBeTrue();
	expect(loaded.master.config.autoActivate).toBeTrue();
	expect(loaded.watcher.config.enabled).toBeFalse();
});

test("功能关闭时它那一节的配置错误不全局警告；开启时照常警告", async () => {
	const warningsFor = async (master: boolean) => {
		const configJsonc = JSON.stringify({
			features: { ...(await featuresOnly()), master },
			master: { roles: { 工程师: { model: "bad", use: "坏原子" } } },
		});
		const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc });
		const fake = fakePi();
		(registerFirecode as (pi: unknown) => void)(fake.pi);
		const warnings: string[] = [];
		await fake.fire("session_start", {}, { isIdle: () => true, ui: { notify: (message: string) => warnings.push(message) }, sessionManager: { getBranch: () => [] } });
		return warnings.filter((message) => message.includes("master.roles"));
	};
	expect(await warningsFor(false)).toEqual([]);
	expect(await warningsFor(true)).not.toEqual([]);
});

// 每个用例用不同的 extraFiles 拿独立的临时 Agent 目录：播种会写盘，不能和共用「无配置」副本的用例互相污染。
let seedCase = 0;
async function seedHarness(options: { configJsonc: string | null; subsession?: boolean; hasUI?: boolean; beforeRegister?: (configPath: string) => Promise<void> }) {
	const loadOptions = { configJsonc: options.configJsonc, extraFiles: { ["seed-case-" + ++seedCase]: "" } };
	const { registerFirecode } = await loadFirecodeModule("index.ts", loadOptions) as any;
	const { CONFIG_PATH } = await loadFirecodeModule("config-file.ts", loadOptions) as { CONFIG_PATH: string };
	await options.beforeRegister?.(CONFIG_PATH);
	const fake = fakePi({ registerProvider() {} });
	registerFirecode(fake.pi, options.subsession ?? false);
	const notices: [string, string][] = [];
	const sessionStart = () => fake.fire("session_start", {}, {
		isIdle: () => true,
		mode: "tui",
		hasUI: options.hasUI ?? true,
		cwd: "/tmp",
		ui: new Proxy({ notify: (message: string, level: string) => notices.push([level, message]) }, { get: (target, key) => (target as any)[key] ?? (() => {}) }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionName: () => undefined, getSessionId: () => "test-session" },
	});
	return { CONFIG_PATH, fake, notices, sessionStart };
}

test("扩展加载时配置缺失：主会话写入随包模板，本次会话即按新配置生效，提示只出现一次", async () => {
	const { CONFIG_PATH, notices, sessionStart } = await seedHarness({ configJsonc: null });

	expect(await readFile(CONFIG_PATH, "utf8")).toBe(await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8"));
	await sessionStart();
	await sessionStart();

	expect(notices).toEqual([["info", "已生成配置：" + CONFIG_PATH + "，按需修改模型后重启生效"]]);
});

test("全新安装（播种的推荐配置、宿主默认键位）注册的快捷键不与任何宿主键位重叠，启动无冲突提示", async () => {
	const { fake } = await seedHarness({ configJsonc: null });
	const { KeybindingsManager } = await import(pathToFileURL(join(PI_PACKAGES, "coding-agent/src/core/keybindings.ts")).href);
	const hostKeys = new Set(
		Object.values(KeybindingsManager.create(await mkdtemp(join(tmpdir(), "firecode-keys-"))).getEffectiveConfig())
			.flatMap((keys) => (Array.isArray(keys) ? keys : [keys]))
			.map((key) => String(key).toLowerCase()),
	);

	const registered = [...fake.shortcuts.keys()];
	expect(registered).not.toEqual([]);
	expect(registered.filter((key) => hostKeys.has(key.toLowerCase()))).toEqual([]);
});

test("无界面的主会话也写盘，但不提示", async () => {
	const { CONFIG_PATH, notices, sessionStart } = await seedHarness({ configJsonc: null, hasUI: false });

	await sessionStart();

	expect(await Bun.file(CONFIG_PATH).exists()).toBe(true);
	expect(notices).toEqual([]);
});

test("配置文件已存在（含内容有问题）时绝不覆盖", async () => {
	const broken = JSON.stringify({ features: await featuresOnly(), bogus: 1 });
	const { CONFIG_PATH, notices, sessionStart } = await seedHarness({ configJsonc: broken });

	await sessionStart();

	const text = notices.map(([, message]) => message).join("\n");
	expect(await readFile(CONFIG_PATH, "utf8")).toBe(broken);
	expect(text).toContain("未知配置节 bogus");
	expect(text).not.toContain("已生成配置");
});

test("子会话不写盘", async () => {
	const { CONFIG_PATH, sessionStart } = await seedHarness({ configJsonc: null, subsession: true });

	await sessionStart();

	expect(await Bun.file(CONFIG_PATH).exists()).toBe(false);
});

/** 把配置目录换成同名文件，播种写入必然失败。 */
const blockConfigDir = async (configPath: string) => {
	const configDir = dirname(configPath);
	await rm(configDir, { recursive: true });
	await writeFile(configDir, "挡路的文件");
};

test("写入失败明确报错，不静默", async () => {
	const { CONFIG_PATH, notices, sessionStart } = await seedHarness({ configJsonc: null, beforeRegister: blockConfigDir });

	await sessionStart();

	const errors = notices.filter(([level]) => level === "error");
	expect(errors).toHaveLength(1);
	expect(errors[0][1]).toContain("无法生成配置：" + CONFIG_PATH);
});

test("无界面的主会话写入失败也明确报错（stderr），不静默", async () => {
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { CONFIG_PATH, sessionStart } = await seedHarness({ configJsonc: null, hasUI: false, beforeRegister: blockConfigDir });

		await sessionStart();

		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法生成配置：" + CONFIG_PATH);
	} finally {
		stderr.mockRestore();
	}
});
