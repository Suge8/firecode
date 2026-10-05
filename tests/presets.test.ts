import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { parseJsonc } from "../jsonc.ts";
import { FIRECODE_DIR, cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("binds exactly the shortcuts declared by preset key fields", async () => {
	const configJsonc = readFileSync(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { presets, keys } = parseJsonc(configJsonc) as {
		presets: Record<string, { key?: string }>;
		keys: { cyclePreset: string };
	};
	const declared = Object.values(presets)
		.map((preset) => preset.key)
		.filter((key): key is string => !!key);
	expect(declared.length).toBeGreaterThan(0);

	const shortcuts: string[] = [];
	const { registerPresets } = await loadFirecodeModule("session/presets.ts", { configJsonc });
	(registerPresets as (pi: unknown) => void)({
		registerFlag() {},
		registerShortcut(key: string) {
			shortcuts.push(key);
		},
		registerCommand() {},
		on() {},
	} as never);

	for (const key of declared) expect(shortcuts).toContain(key);
	expect(shortcuts).toContain(keys.cyclePreset);
	// 没写 key 的预设不占用按键。
	expect(shortcuts).toHaveLength(declared.length + 1);
});

const PRESET_CONFIG = JSON.stringify({
	keys: { rename: "ctrl+r", cyclePreset: "ctrl+shift+u", fast: "ctrl+f" },
	presets: {
		deep: { model: "test/deep/high", tools: ["read", "bash"], instructions: "深度模式指令" },
		quick: { model: "test/quick/low", instructions: "快速模式指令" },
		plain: { model: "test/plain/low" },
	},
});

/** 宿主替身：模型、思考档与工具集都由宿主记在会话里，并在 session_start 之前按记录恢复（真实宿主的工具集随运行记入 transcript）。 */
async function presetHost() {
	const { registerPresets } = await loadFirecodeModule("session/presets.ts", { configJsonc: PRESET_CONFIG });
	const models: Record<string, { provider: string; id: string }> = {
		"test/base": { provider: "test", id: "base" },
		"test/deep": { provider: "test", id: "deep" },
		"test/quick": { provider: "test", id: "quick" },
		"test/plain": { provider: "test", id: "plain" },
	};
	const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const state = { model: models["test/base"], thinking: "medium", tools: DEFAULT_TOOLS, recordedTools: DEFAULT_TOOLS, branch: [] as unknown[], status: undefined as string | undefined };
	const emit = async (name: string, event: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	const ctx = {
		get model() { return state.model; },
		modelRegistry: { find: (provider: string, id: string) => models[`${provider}/${id}`] },
		sessionManager: { getEntries: () => state.branch, getBranch: () => state.branch },
		ui: { notify() {}, setStatus: (_key: string, text?: string) => { state.status = text; }, theme: { fg: (_color: string, text: string) => text } },
	};
	(registerPresets as (pi: unknown) => void)({
		registerFlag() {}, registerShortcut() {}, getFlag: () => undefined,
		registerCommand: (name: string, command: never) => commands.set(name, command),
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getThinkingLevel: () => state.thinking,
		setThinkingLevel: (level: string) => { state.thinking = level; },
		setModel: async (model: typeof state.model) => {
			const previousModel = state.model;
			state.model = model;
			await emit("model_select", { model, previousModel, source: "set" });
			return true;
		},
		getActiveTools: () => state.tools,
		setActiveTools: (tools: string[]) => { state.tools = tools; state.recordedTools = tools; },
		getAllTools: () => DEFAULT_TOOLS.map((name) => ({ name })),
		appendEntry: (customType: string, data: unknown) => state.branch.push({ type: "custom", customType, data }),
	});
	/** 重开会话：宿主先按记录恢复模型（可能回落到别的模型）与工具集，再发 session_start。 */
	const reopen = async (restoredModel: string) => {
		state.model = models[restoredModel];
		state.tools = state.recordedTools;
		await emit("session_start");
	};
	const instructions = async () =>
		((await emit("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt?: string } | undefined)?.systemPrompt ?? "BASE";
	const preset = (name: string) => commands.get("preset")!.handler(name, ctx);
	return { state, emit, reopen, instructions, preset, models, DEFAULT_TOOLS };
}

test("重开会话时宿主恢复的仍是预设模型：预设整套生效——工具集仍是预设的、指令照常注入、状态显示预设名", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	await host.preset("deep");
	await host.reopen("test/deep");
	expect(host.state.tools).toEqual(["read", "bash"]);
	expect(await host.instructions()).toContain("深度模式指令");
	expect(host.state.status).toContain("Deep");
	// 输入框下边框直接显示发布串：只有名字，不带图标。
	expect(host.state.status).toBe("Deep");
});

test("重开会话时宿主恢复的模型已不是预设的：预设失效，名字与指令清掉，再重开也不复活", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	await host.preset("deep");
	await host.reopen("test/base");
	expect(await host.instructions()).toBe("BASE");
	expect(host.state.status).toBeUndefined();
	// 失效只清预设自己的状态（名字与指令），宿主恢复的工具集不动。
	expect(host.state.tools).toEqual(["read", "bash"]);
	await host.reopen("test/deep");
	expect(await host.instructions()).toBe("BASE");
	expect(host.state.status).toBeUndefined();
});

test("会话中手动切走预设模型即失效且记入会话；切到另一个预设不算失效", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	await host.preset("deep");
	await host.preset("quick");
	expect(host.state.status).toContain("Quick");
	await host.preset("deep");
	expect(host.state.status).toContain("Deep");

	// 用户经 /model 手动换模型：宿主改模型并发 model_select。
	const previousModel = host.state.model;
	host.state.model = host.models["test/base"];
	await host.emit("model_select", { model: host.state.model, previousModel, source: "set" });
	expect(host.state.status).toBeUndefined();
	expect(await host.instructions()).toBe("BASE");
	await host.reopen("test/base");
	expect(host.state.status).toBeUndefined();
});

test("清除预设后重开不复活；新会话（空记录）不继承上一个会话的预设", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	await host.preset("deep");
	await host.preset("（无）");
	await host.reopen("test/deep");
	expect(host.state.status).toBeUndefined();
	expect(await host.instructions()).toBe("BASE");

	await host.preset("deep");
	host.state.branch = [];
	await host.reopen("test/deep");
	expect(host.state.status).toBeUndefined();
	expect(await host.instructions()).toBe("BASE");
});

test("预设的模型套用失败（找不到或没有凭据）就整套不套：不设预设名、不注入指令、不改工具与模型", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	delete host.models["test/deep"];
	await host.preset("deep");
	expect(host.state.status).toBeUndefined();
	expect(await host.instructions()).toBe("BASE");
	expect(host.state.tools).toEqual(host.DEFAULT_TOOLS);
	expect(host.state.model).toEqual({ provider: "test", id: "base" });
});

test("只改模型与思考档的预设不发布名字（边框已显示模型）；改了工具集或附加指令的才发布", async () => {
	const host = await presetHost();
	await host.emit("session_start");
	await host.preset("plain");
	expect(host.state.model).toEqual({ provider: "test", id: "plain" });
	expect(host.state.status).toBeUndefined();
	await host.preset("quick");
	expect(host.state.status).toBe("Quick");
	await host.preset("deep");
	expect(host.state.status).toBe("Deep");
	await host.preset("plain");
	expect(host.state.status).toBeUndefined();
});
