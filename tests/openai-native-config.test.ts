import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { togglePriority } from "../provider/openai-native/src/config.ts";
import { parseJsonc } from "../jsonc.ts";

// 加速档开关写回用户手写的 config.jsonc：只能动 openai 节，其余内容与注释原样保留。
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configWith(text: string): string {
	const directory = mkdtempSync(join(tmpdir(), "firecode-fast-"));
	directories.push(directory);
	const path = join(directory, "config.jsonc");
	writeFileSync(path, text);
	return path;
}
const read = (path: string) => readFileSync(path, "utf8");

test("toggling fast flips the provider's priority and leaves everything else in the file alone", () => {
	const path = configWith(`{
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

	expect(togglePriority("openai-codex", path)).toBe(true);
	const afterOn = read(path);
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

	expect(togglePriority("openai-codex", path)).toBe(false);
	expect((parseJsonc(read(path)) as any).openai.providers["openai-codex"]).toEqual({ textVerbosity: "low", priority: false });
});

test("an \"openai\": { inside a comment or a string is not the openai section", () => {
	const path = configWith(`{
	// "openai": { "providers": { "old": {} } }
	"master": { "note": "see \\"openai\\": { below" },
	"openai": { "providers": { "openai-codex": { "priority": false } } }
}
`);

	expect(togglePriority("openai-codex", path)).toBe(true);

	const after = read(path);
	expect(after).toContain('// "openai": { "providers": { "old": {} } }');
	expect(parseJsonc(after)).toMatchObject({
		master: { note: 'see "openai": { below' },
		openai: { providers: { "openai-codex": { priority: true } } },
	});
});

test("without an openai section one is added at the end and the comments stay", () => {
	const path = configWith(`{
	// the only setting
	"language": "en"
}
`);

	togglePriority("xai", path);

	expect(read(path)).toContain("// the only setting");
	expect(parseJsonc(read(path))).toEqual({ language: "en", openai: { providers: { xai: { priority: true } } } });
});
