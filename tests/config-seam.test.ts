import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, copyFirecodeSource, FIRECODE_DIR, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("portable loader copies runtime sources without repository metadata or development docs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-copy-"));
	try {
		await copyFirecodeSource(directory);
		expect(existsSync(join(directory, "index.ts"))).toBeTrue();
		expect(existsSync(join(directory, ".git"))).toBeFalse();
		expect(existsSync(join(directory, "docs"))).toBeFalse();
		expect(existsSync(join(directory, "tests"))).toBeFalse();
		expect(
			(await readdir(directory, { recursive: true }))
				.filter((path) => /\.mdx?$/.test(path))
				.map((path) => path.split(sep).join("/"))
				.sort(),
		).toEqual([
			"master/prompts/master.zh.md",
			"master/prompts/worker.zh.md",
			"review/prompts/advisor.en.md",
			"review/prompts/advisor.zh.md",
			"review/prompts/review.en.md",
			"review/prompts/review.zh.md",
			"watcher/prompts/watch.zh.md",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing runtime config disables optional behavior and warns on each session_start", async () => {
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: null });
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const tools: string[] = [];
	const renderers: string[] = [];
	const events = new Map<string, Array<(...args: unknown[]) => void>>();
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => shortcuts.push(key),
		registerTool: ({ name }: { name: string }) => tools.push(name),
		registerMessageRenderer: (name: string) => renderers.push(name),
		on: (name: string, handler: (...args: unknown[]) => void) =>
			events.set(name, [...(events.get(name) ?? []), handler]),
	};

	(registerFirecode as (pi: unknown) => void)(pi);

	expect(commands).toEqual([]);
	expect(shortcuts).toEqual([]);
	expect(tools).toEqual([]);
	expect(renderers).toEqual(["firecode-review-card"]);
	const warnings: string[] = [];
	for (let occurrence = 0; occurrence < 2; occurrence++)
		for (const handler of events.get("session_start") ?? [])
			handler({}, { ui: { notify: (message: string) => warnings.push(message) } });
	expect(warnings).toEqual([
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
	]);
});

test("runtime config enables only its declared behavior", async () => {
	const configJsonc = JSON.stringify({
		features: Object.fromEntries([
			"header",
			"statusbar",
			"tools",
			"presets",
			"stats",
			"claudeSub",
			"openaiNative",
			"workingFlame",
			"bark",
			"review",
			"master",
			"watcher",
		].map((feature) => [feature, false]).concat([["rename", true]])),
		keys: { rename: "alt+r" },
	});
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc });
	const commands: string[] = [];
	const shortcuts: string[] = [];
	(registerFirecode as (pi: unknown) => void)({
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => shortcuts.push(key),
		registerMessageRenderer() {},
		on() {},
	});

	expect(commands).toEqual(["rename"]);
	expect(shortcuts).toEqual(["alt+r"]);
});

test("Master 角色表严格解析原子、唯一角色与 fallback", async () => {
	const { parseMasterConfig } = await loadFirecodeModule("config.ts") as any;
	const validProblems: string[] = [];
	const parsed = parseMasterConfig({
		models: [
			{ role: "工程师", model: "test/shared/medium", use: "实现", fallback: ["test/backup/high"] },
			{ role: "哨兵", model: "test/shared/low", use: "盯守" },
		],
	}, validProblems);
	expect(validProblems).toEqual([]);
	expect(parsed.models).toEqual([
		{
			role: "工程师", model: "test/shared", thinking: "medium", use: "实现",
			fallback: [{ model: "test/backup", thinking: "high" }],
		},
		{ role: "哨兵", model: "test/shared", thinking: "low", use: "盯守", fallback: [] },
	]);

	const problems: string[] = [];
	parseMasterConfig({
		models: [
			{ role: "重复", model: "invalid-model/high", thinking: "medium", use: "旧写法" },
			{ role: "重复", model: "test/model/turbo", use: "坏档", fallback: ["test/a/low", "test/b/low", "test/c/low"] },
		],
	}, problems);
	expect(problems).toContain("未知字段 master.models[0].thinking");
	expect(problems).toContain("master.models[0].model 模型无效：必须是 provider/model");
	expect(problems).toContain("master.models[1].model 思考档无效：turbo");
	expect(problems).toContain("master.models[1].fallback 必须是至多 2 项的数组");
	expect(problems).toContain("master.models 角色名不能重复");
});

test("公共配置模板可解析并启用完整推荐工作流", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["claudeSub", "openaiNative", "review", "master", "watcher"])
		expect(loaded.config.features[feature]).toBeTrue();
	expect(loaded.config.features.bark).toBeFalse();
	expect(loaded.config.master.autoActivate).toBeTrue();
	expect(loaded.config.master.models.map((entry: any) => entry.role)).toEqual([
		"调研员", "工程师", "全栈", "架构师", "设计师", "哨兵",
	]);
	expect(loaded.config.watcher.enabled).toBeTrue();
	expect(configJsonc).toContain("每个主会话回合后调用模型");
});
