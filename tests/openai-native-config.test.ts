import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule } from "./loader.ts";
import { parseJsonc } from "../jsonc.ts";

// 加速档开关写回用户手写的 config.jsonc：只能动 openai 节，其余内容与注释原样保留。
// 经真实的 /fast 命令与测试 Agent 目录里的真实配置文件验证。
async function fastCommand(configJsonc: string) {
	const [{ registerOpenAINative }, { CONFIG_PATH }] = await Promise.all([
		loadFirecodeModule("provider/openai-native/index.ts", { configJsonc }),
		loadFirecodeModule("config-file.ts", { configJsonc }),
	]) as any[];
	const fake = fakePi();
	registerOpenAINative(fake.pi);
	return {
		path: CONFIG_PATH as string,
		toggle: (provider: string) => fake.commands.get("fast").handler("", {
			// xai 的所有模型都支持加速档；openai-codex 要用清单里的模型。
			model: { provider, id: "gpt-6-sol", api: provider === "xai" ? "openai-completions" : "openai-codex-responses" },
			hasUI: false,
			ui: { notify() {} },
		}),
	};
}
const read = (path: string) => readFileSync(path, "utf8");

test("toggling fast flips the provider's priority and leaves everything else in the file alone", async () => {
	const fast = await fastCommand(`{
	// keep me
	"keys": { "fast": "ctrl+shift+s" },
	"openai": {
		"nativeCompaction": true,
		"experimental": 1,
		"providers": { "openai-codex": { "textVerbosity": "low", "priority": false }, "xai": { "priority": true } }
	},
	/* trailing note */
	"language": "zh"
}
`);

	await fast.toggle("openai-codex");
	const afterOn = read(fast.path);
	expect(afterOn).toContain("// keep me");
	expect(afterOn).toContain("/* trailing note */");
	expect(parseJsonc(afterOn)).toEqual({
		keys: { fast: "ctrl+shift+s" },
		openai: {
			nativeCompaction: true,
			experimental: 1,
			providers: { "openai-codex": { textVerbosity: "low", priority: true }, xai: { priority: true } },
		},
		language: "zh",
	});

	await fast.toggle("openai-codex");
	expect((parseJsonc(read(fast.path)) as any).openai.providers["openai-codex"]).toEqual({ textVerbosity: "low", priority: false });
});

test("an \"openai\": { inside a comment or a string is not the openai section", async () => {
	const fast = await fastCommand(`{
	// "openai": { "providers": { "old": {} } }
	"master": { "note": "see \\"openai\\": { below" },
	"openai": { "providers": { "openai-codex": { "priority": false } } }
}
`);

	await fast.toggle("openai-codex");

	const after = read(fast.path);
	expect(after).toContain('// "openai": { "providers": { "old": {} } }');
	expect(parseJsonc(after)).toMatchObject({
		master: { note: 'see "openai": { below' },
		openai: { providers: { "openai-codex": { priority: true } } },
	});
});

test("without an openai section one is added at the end and the comments stay", async () => {
	const fast = await fastCommand(`{
	// the only setting
	"language": "en"
}
`);

	await fast.toggle("xai");

	expect(read(fast.path)).toContain("// the only setting");
	expect(parseJsonc(read(fast.path))).toEqual({ language: "en", openai: { providers: { xai: { priority: true } } } });
});
