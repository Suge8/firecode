import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FIRECODE_DIR, loadFirecodeModule, featuresOnly, PI_PACKAGES } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

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
	// 后台模型省略即关闭（每次都是真实调用）；写成模型链才开启，闲置压缩默认开。
	expect(loaded.config.background).toBeUndefined();
	const withBackground = await loadFrom(JSON.stringify({ features, master: { roles: { 哨兵: { model: "test/shared/low", use: "盯守" } } }, background: { lineModel: ["test/a/low", "test/b/low"], compactionModel: "test/b/medium" } }));
	expect(withBackground.problems).toEqual([]);
	expect(withBackground.config.background).toEqual({ lineModel: [{ model: "test/a", thinking: "low" }, { model: "test/b", thinking: "low" }], compactionModel: [{ model: "test/b", thinking: "medium" }], idleCompaction: true, sessionNames: true });
});

// 手误与缺失字段一律报出并拒绝启动对应功能，不静默回退成默认值（回退会拿用户没选的模型真实发起调用）。
test("手误与缺失字段都被报出，对应功能拒绝启动", async () => {
	const features = await featuresOnly("master", "review");
	const rejected: [string, unknown, string][] = [
		["master 角色里的未知字段", { master: { roles: { 工程师: { model: "p/m/high", thinking: "medium", use: "x" } } } }, "master.roles.工程师.thinking"],
		["master 无效思考档", { master: { roles: { 调研员: { model: "test/model", use: "x" } } } }, "master.roles.调研员.model"],
		["master 空角色表", { master: { roles: {} } }, "master.roles"],
		["background 缺模型链", { background: { lineModel: "p/m/low", idleCompaction: true } }, "background.compactionModel"],
		["background.idleCompaction 不是布尔", { background: { lineModel: "p/m/low", compactionModel: "p/m/low", idleCompaction: "yes" } }, "background.idleCompaction"],
		["review 旧的 { model, thinking } 对象", { review: { advisor: { model: "p/m", thinking: "max" } } }, "review.advisor"],
		["review 不是对象", { review: "typo" }, "review"],
		["review 缺失的显式字段", { review: { maxRounds: 3 } }, "review.timeoutMinutes"],
		["review.tools 含写入工具", { review: { tools: ["read", "edit"] } }, "review.tools"],
		["未知配置节", { tools: { replyLines: 3 } }, "tools"],
		["未知开关", { features: { rename: true } }, "features.rename"],
		["language 取值非法", { language: "fr" }, "language"],
	];
	for (const [name, section, path] of rejected) {
		const loaded = await loadFrom(JSON.stringify({ features, ...(section as object) }));
		expect(`${name}: ${loaded.problems.some((problem: string) => problem.includes(path))}`).toBe(`${name}: true`);
	}
	// 有问题的 background 整节不生效：后台活都是真实调用，不替用户补模型。
	expect((await loadFrom(JSON.stringify({ features, background: { lineModel: "bad", compactionModel: "bad" } }))).config.background).toBeUndefined();
	const broken = await loadFrom(JSON.stringify({ features, master: { roles: { 工程师: { model: "bad", use: "x" } } } }));
	expect(broken.master.error).toBeTruthy();
});

// features.review 写成字符串 "false" 时因 `!== false` 仍会启用，而启用 review 意味着真实模型调用，必须报出来而不是静默放行。
test("features 不是对象时报出并全部关闭；开关不是布尔时报出", async () => {
	const broken = await loadFrom(`{ "features": "false" }`);
	expect(broken.problems.join()).toContain("features 必须是对象");
	expect(Object.values(broken.config.features).every((enabled) => enabled === false)).toBe(true);

	expect((await loadFrom(`{ "features": { "review": "false" } }`)).problems.join()).toContain("features.review 必须是 true 或 false");
});

test("配置文件读不出来时只报文件级那一条：尾逗号与 BOM 照常读，真有语法错不刷各节的派生问题", async () => {
	const features = await featuresOnly("review", "master");
	const lenient = await loadFrom("\uFEFF" + `{ "features": ${JSON.stringify(features)}, "keys": { "fast": "alt+f", }, // note
	}`);
	expect(lenient.problems.filter((problem: string) => problem.includes("解析失败"))).toEqual([]);
	expect(lenient.config.keys.fast).toBe("alt+f");

	const broken = await loadFrom(`{ "features": { "review": true }, "master" `);
	expect(broken.problems).toHaveLength(1);
	expect(broken.problems[0]).toContain("config.jsonc 解析失败");
	for (const section of [broken.review, broken.master]) {
		expect(section.error).toContain("解析失败");
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
	expect(loaded.problems).toHaveLength(6);
	expect(loaded.config.openai).toEqual({ nativeCompaction: false, providers: { xai: { priority: true } } });
});

test("公共配置模板可解析并启用完整推荐工作流", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => any)();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["claudeSub", "claudeFiles", "openaiNative", "review", "master"])
		expect(loaded.config.features[feature]).toBeTrue();
	expect(loaded.master.config.autoActivate).toBeTrue();
	expect(loaded.config.background.lineModel.length).toBeGreaterThan(0);
	expect(loaded.config.background.compactionModel.length).toBeGreaterThan(0);
	expect(loaded.config.background.idleCompaction).toBeTrue();
});

// 每个用例用不同的 extraFiles 拿独立的临时 Agent 目录：播种会写盘，不能和共用「无配置」副本的用例互相污染。
let seedCase = 0;
async function seedHarness(options: { configJsonc: string | null; hasUI?: boolean; beforeRegister?: (configPath: string) => Promise<void> }) {
	const loadOptions = { configJsonc: options.configJsonc, extraFiles: { ["seed-case-" + ++seedCase]: "" } };
	const { registerFirecode } = await loadFirecodeModule("index.ts", loadOptions) as any;
	const { CONFIG_PATH } = await loadFirecodeModule("config-file.ts", loadOptions) as { CONFIG_PATH: string };
	await options.beforeRegister?.(CONFIG_PATH);
	const register = () => {
		const instance = fakePi({ registerProvider() {} });
		registerFirecode(instance.pi, false);
		return instance;
	};
	let fake = register();
	const notices: [string, string][] = [];
	const agentDir = dirname(dirname(dirname(CONFIG_PATH)));
	const sessionStart = async () => {
		const environment = { ...process.env };
		try {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, { PATH: environment.PATH, HOME: agentDir, LC_ALL: "zh_CN.UTF-8", PI_CODING_AGENT_DIR: agentDir });
			return await fake.fire("session_start", {}, {
				isIdle: () => true,
				mode: "tui",
				hasUI: options.hasUI ?? true,
				cwd: "/tmp",
				ui: new Proxy({ notify: (message: string, level: string) => notices.push([level, message]) }, { get: (target, key) => (target as any)[key] ?? (() => {}) }),
				sessionManager: { getBranch: () => [], getEntries: () => [], getSessionName: () => undefined, getSessionId: () => "test-session" },
			});
		} finally {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, environment);
		}
	};
	/** 宿主的 reload、新建与切换会话都会重新执行扩展工厂：新实例只收到自己的一次 session_start。 */
	const reload = async () => {
		fake = register();
		await sessionStart();
	};
	return { CONFIG_PATH, get fake() { return fake; }, notices, sessionStart, reload };
}

test("扩展加载时配置缺失：主会话写入随包模板，本次会话即按新配置生效，生成提示只在这次启动出现", async () => {
	const { CONFIG_PATH, notices, sessionStart, reload } = await seedHarness({ configJsonc: null });

	expect(await readFile(CONFIG_PATH, "utf8")).toBe(await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8"));
	const seeded = () => notices.filter(([level, message]) => level === "info" && message.includes(CONFIG_PATH)).length;
	await sessionStart();
	expect(seeded()).toBe(1);
	await reload();
	expect(seeded()).toBe(1);
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

test("配置文件已存在（含内容有问题）时绝不覆盖", async () => {
	const broken = JSON.stringify({ features: await featuresOnly(), bogus: 1 });
	const { CONFIG_PATH, sessionStart } = await seedHarness({ configJsonc: broken });

	await sessionStart();

	expect(await readFile(CONFIG_PATH, "utf8")).toBe(broken);
});

/** 把配置目录换成同名文件，播种写入必然失败。 */
const blockConfigDir = async (configPath: string) => {
	const configDir = dirname(configPath);
	await rm(configDir, { recursive: true });
	await writeFile(configDir, "挡路的文件");
};

test.each([["有界面：notify", true], ["无界面：stderr", false]])("写入失败明确报错，不静默（%s）", async (_name, hasUI) => {
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { CONFIG_PATH, notices, sessionStart } = await seedHarness({ configJsonc: null, hasUI, beforeRegister: blockConfigDir });

		await sessionStart();

		const reported = hasUI ? notices.filter(([level]) => level === "error").map(([, message]) => message) : stderr.mock.calls.map(([message]) => String(message));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain(CONFIG_PATH);
	} finally {
		stderr.mockRestore();
	}
});
