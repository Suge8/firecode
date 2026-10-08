import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { cleanupFirecodeModules, FIRECODE_DIR, loadFirecodeModule, featuresOnly, PI_PACKAGES } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

afterEach(cleanupFirecodeModules);

test("missing runtime config disables optional behavior and warns on each session_start", async () => {
	const { registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: null }) as any;
	const fake = fakePi();

	registerFirecode(fake.pi, "worker");

	expect([...fake.commands.keys()]).toEqual([]);
	expect([...fake.shortcuts.keys()]).toEqual([]);
	expect([...fake.tools.keys()]).toEqual([]);
	expect([...fake.messageRenderers.keys()]).toEqual(["firecode-review-card"]);
	const warnings: string[] = [];
	for (let occurrence = 0; occurrence < 2; occurrence++)
		await fake.fire("session_start", {}, { ui: { notify: (message: string) => warnings.push(message) }, sessionManager: { getBranch: () => [] } });
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

test("Master 角色对象严格解析原子与 fallback", async () => {
	const features = await featuresOnly("master");
	const load = async (master: unknown) => {
		const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc: JSON.stringify({ features, master }) });
		return (loadConfig as () => { config: any; problems: string[] })();
	};
	const valid = await load({
		roles: {
			工程师: { model: "test/shared/medium", use: "实现", fallback: ["test/backup/high"] },
			哨兵: { model: "test/shared/low", use: "盯守" },
		},
	});
	expect(valid.problems).toEqual([]);
	expect(valid.config.master.roles).toEqual([
		{
			role: "工程师", model: "test/shared", thinking: "medium", use: "实现",
			fallback: [{ model: "test/backup", thinking: "high" }],
		},
		{ role: "哨兵", model: "test/shared", thinking: "low", use: "盯守", fallback: [] },
	]);

	const { problems } = await load({
		roles: {
			工程师: {
				model: "invalid-model/high", thinking: "medium", use: "旧写法",
				fallback: ["test/a/low", "test/b/low", "test/c/low"],
			},
			哨兵: { model: "test/model/turbo", use: "坏档" },
			调研员: { model: "test/model", use: "漏写思考档" },
		},
	});
	expect(problems).toContain("未知字段 master.roles.工程师.thinking");
	expect(problems).toContain(
		"master.roles.工程师.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：invalid-model）",
	);
	expect(problems).toContain("master.roles.哨兵.model 必须是“provider/model/thinking”字符串（思考档无效：turbo）");
	// 两段式旧写法同时踩中两项校验，仍然只报一条并给出目标形状。
	expect(problems).toContain(
		"master.roles.调研员.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：test；思考档无效：model）",
	);
	expect(problems).toContain("master.roles.工程师.fallback 必须是至多 2 项的数组");

	expect((await load({ roles: {} })).problems).toContain("master.roles 必须是至少包含一个角色的对象");
	expect((await load({ models: [{ role: "工程师", model: "test/model/low", use: "旧数组" }] })).problems)
		.toContain("未知字段 master.models");
});

test("已删除的配置项不被静默忽略：features.rename、keys.rename 与 keys.cyclePreset 报未知字段，tools 节报未知配置节", async () => {
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({ features: { rename: true }, keys: { rename: "ctrl+r", cyclePreset: "ctrl+shift+u" }, tools: { replyLines: 3 } }),
	});
	const { problems } = (loadConfig as () => { problems: string[] })();
	expect(problems.some((problem) => problem.startsWith("未知开关 features.rename"))).toBeTrue();
	expect(problems).toContain("未知字段 keys.rename");
	expect(problems).toContain("未知字段 keys.cyclePreset");
	expect(problems).toContain("未知配置节 tools");
});

test("preset 只认模型原子，旧的三字段写法被拒", async () => {
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({
			presets: {
				new: { model: "test/model/high", key: "alt+1" },
				old: { provider: "test", model: "model", thinkingLevel: "high" },
			},
		}),
	});
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.config.presets.new.model).toEqual({ model: "test/model", thinking: "high" });
	expect(loaded.problems).toContain("未知字段 presets.old.provider");
	expect(loaded.problems).toContain("未知字段 presets.old.thinkingLevel");
	expect(loaded.problems).toContain(
		"presets.old.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：model；思考档无效：model）",
	);
});

test("公共配置模板可解析并启用完整推荐工作流", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["claudeSub", "openaiNative", "review", "master", "watcher"])
		expect(loaded.config.features[feature]).toBeTrue();
	expect(loaded.config.master.autoActivate).toBeTrue();
	expect(loaded.config.watcher.enabled).toBeFalse();
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
		await fake.fire("session_start", {}, { ui: { notify: (message: string) => warnings.push(message) }, sessionManager: { getBranch: () => [] } });
		await cleanupFirecodeModules();
		return warnings.filter((message) => message.includes("master.roles"));
	};
	expect(await warningsFor(false)).toEqual([]);
	expect(await warningsFor(true)).not.toEqual([]);
});

// 每个用例用不同的 extraFiles 拿独立的临时 Agent 目录：播种会写盘，不能和共用「无配置」副本的用例互相污染。
let seedCase = 0;
async function seedHarness(options: { configJsonc: string | null; role?: string; hasUI?: boolean; beforeRegister?: (configPath: string) => Promise<void> }) {
	const loadOptions = { configJsonc: options.configJsonc, extraFiles: { ["seed-case-" + ++seedCase]: "" } };
	const { registerFirecode } = await loadFirecodeModule("index.ts", loadOptions) as any;
	const { CONFIG_PATH } = await loadFirecodeModule("config-file.ts", loadOptions) as { CONFIG_PATH: string };
	await options.beforeRegister?.(CONFIG_PATH);
	const fake = fakePi({ registerProvider() {} });
	registerFirecode(fake.pi, options.role ?? "main");
	const notices: [string, string][] = [];
	const sessionStart = () => fake.fire("session_start", {}, {
		mode: "tui",
		hasUI: options.hasUI ?? true,
		cwd: "/tmp",
		ui: new Proxy({ notify: (message: string, level: string) => notices.push([level, message]) }, { get: (target, key) => (target as any)[key] ?? (() => {}) }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionName: () => undefined, getSessionId: () => "test-session" },
	});
	return { CONFIG_PATH, fake, notices, sessionStart };
}

test("扩展加载时配置缺失：主会话写入随包模板，本次会话即按新配置生效，提示只出现一次", async () => {
	const { CONFIG_PATH, fake, notices, sessionStart } = await seedHarness({ configJsonc: null });

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
	const { CONFIG_PATH, sessionStart } = await seedHarness({ configJsonc: null, role: "worker" });

	await sessionStart();

	expect(await Bun.file(CONFIG_PATH).exists()).toBe(false);
});

test("写入失败明确报错，不静默", async () => {
	const { CONFIG_PATH, notices, sessionStart } = await seedHarness({
		configJsonc: null,
		beforeRegister: async (configPath) => {
			const configDir = dirname(configPath);
			await rm(configDir, { recursive: true });
			await writeFile(configDir, "挡路的文件");
		},
	});

	await sessionStart();

	const errors = notices.filter(([level]) => level === "error");
	expect(errors).toHaveLength(1);
	expect(errors[0][1]).toContain("无法生成配置：" + CONFIG_PATH);
});

test("无界面的主会话写入失败也明确报错（stderr），不静默", async () => {
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { CONFIG_PATH, sessionStart } = await seedHarness({
			configJsonc: null,
			hasUI: false,
			beforeRegister: async (configPath) => {
				const configDir = dirname(configPath);
				await rm(configDir, { recursive: true });
				await writeFile(configDir, "挡路的文件");
			},
		});

		await sessionStart();

		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法生成配置：" + CONFIG_PATH);
	} finally {
		stderr.mockRestore();
	}
});
