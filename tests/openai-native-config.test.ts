import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule } from "./loader.ts";
import { parseJsonc } from "../jsonc.ts";

// 加速档写回用户手写的 config.jsonc：只能动 openai 节，其余内容与注释原样保留。
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
			// OpenAI 与 xAI 自己的列表不带档位：openai-codex 给 Fast 与 Ultrafast，xai 只给 Fast。
			model: { provider, id: "gpt-6-sol", api: provider === "xai" ? "openai-completions" : "openai-codex-responses" },
			hasUI: false,
			ui: { notify() {} },
		}),
	};
}
const read = (path: string) => readFileSync(path, "utf8");

test("/fast cycles the provider's tier off → Fast → Ultrafast → off and leaves everything else in the file alone", async () => {
	const fast = await fastCommand(`{
	// keep me
	// "openai": { "providers": { "old": {} } }
	"keys": { "fast": "ctrl+shift+s" },
	"note": "see \\"openai\\": { below",
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
	expect(afterOn).toContain('// "openai": { "providers": { "old": {} } }');
	expect(afterOn).toContain("/* trailing note */");
	expect(parseJsonc(afterOn)).toEqual({
		keys: { fast: "ctrl+shift+s" },
		note: 'see "openai": { below',
		openai: {
			nativeCompaction: true,
			experimental: 1,
			providers: { "openai-codex": { textVerbosity: "low", serviceTier: "fast" }, xai: { priority: true } },
		},
		language: "zh",
	});

	await fast.toggle("openai-codex");
	expect((parseJsonc(read(fast.path)) as any).openai.providers["openai-codex"]).toEqual({ textVerbosity: "low", serviceTier: "ultrafast" });
	await fast.toggle("openai-codex");
	expect((parseJsonc(read(fast.path)) as any).openai.providers["openai-codex"]).toEqual({ textVerbosity: "low" });
});

test("without an openai section one is added at the end and the comments stay", async () => {
	const fast = await fastCommand(`{
	// the only setting
	"language": "en"
}
`);

	await fast.toggle("xai");

	expect(read(fast.path)).toContain("// the only setting");
	expect(parseJsonc(read(fast.path))).toEqual({ language: "en", openai: { providers: { xai: { serviceTier: "fast" } } } });
});
