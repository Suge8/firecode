import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, FIRECODE_DIR, loadFirecodeModule, featuresOnly } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

afterEach(cleanupFirecodeModules);

test("missing runtime config disables optional behavior and warns on each session_start", async () => {
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: null });
	const fake = fakePi();

	(registerFirecode as (pi: unknown) => void)(fake.pi);

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

test.each([
	{ feature: "rename", commands: ["rename"], shortcuts: ["alt+r"] },
	{ feature: "stats", commands: ["quota", "tokens"], shortcuts: [] },
])("runtime config enables only $feature behavior", async ({ feature, commands: expectedCommands, shortcuts: expectedShortcuts }) => {
	const configJsonc = JSON.stringify({
		features: await featuresOnly(feature),
		keys: { rename: "alt+r" },
	});
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc });
	const fake = fakePi();
	(registerFirecode as (pi: unknown) => void)(fake.pi);

	expect([...fake.entryRenderers.keys()]).toEqual([]);
	expect([...fake.commands.keys()]).toEqual(expectedCommands);
	expect([...fake.shortcuts.keys()]).toEqual(expectedShortcuts);
});

test("Master 角色对象严格解析原子与 fallback", async () => {
	const { parseMasterConfig } = await loadFirecodeModule("config.ts") as any;
	const validProblems: string[] = [];
	const parsed = parseMasterConfig({
		roles: {
			工程师: { model: "test/shared/medium", use: "实现", fallback: ["test/backup/high"] },
			哨兵: { model: "test/shared/low", use: "盯守" },
		},
	}, validProblems);
	expect(validProblems).toEqual([]);
	expect(parsed.roles).toEqual([
		{
			role: "工程师", model: "test/shared", thinking: "medium", use: "实现",
			fallback: [{ model: "test/backup", thinking: "high" }],
		},
		{ role: "哨兵", model: "test/shared", thinking: "low", use: "盯守", fallback: [] },
	]);

	const problems: string[] = [];
	parseMasterConfig({
		roles: {
			工程师: {
				model: "invalid-model/high", thinking: "medium", use: "旧写法",
				fallback: ["test/a/low", "test/b/low", "test/c/low"],
			},
			哨兵: { model: "test/model/turbo", use: "坏档" },
			调研员: { model: "test/model", use: "漏写思考档" },
		},
	}, problems);
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

	const emptyProblems: string[] = [];
	parseMasterConfig({ roles: {} }, emptyProblems);
	expect(emptyProblems).toContain("master.roles 必须是至少包含一个角色的对象");

	const legacyProblems: string[] = [];
	parseMasterConfig({ models: [{ role: "工程师", model: "test/model/low", use: "旧数组" }] }, legacyProblems);
	expect(legacyProblems).toEqual(["未知字段 master.models"]);
});

test("已删除的配置项不被静默忽略：keys.cyclePreset 报未知字段，tools 节报未知配置节", async () => {
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({ keys: { rename: "ctrl+r", cyclePreset: "ctrl+shift+u" }, tools: { replyLines: 3 } }),
	});
	const { problems } = (loadConfig as () => { problems: string[] })();
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
	// 指挥官提示词点名“哨兵”承接长等待，模板必须带着它。
	expect(loaded.config.master.roles.map((entry: any) => entry.role)).toContain("哨兵");
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
