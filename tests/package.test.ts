import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { FIRECODE_DIR } from "./loader.ts";

const PROMPT_DIRS = ["master/prompts", "review/prompts", "watcher/prompts"];
const transpiler = new Bun.Transpiler({ loader: "js" });

function run(command: string[]): string {
	const result = Bun.spawnSync(command, { cwd: FIRECODE_DIR, stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}

/** 构建会清空并重写 dist：两个用例共用一次构建。 */
let built: string[] | undefined;
function packedPaths(): string[] {
	if (built) return built;
	run(["bun", "scripts/build.ts"]);
	const packed = JSON.parse(run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"]));
	return (built = (packed[0].files as Array<{ path: string }>).map(({ path }) => path));
}

test("npm pack ships only the build output and user-facing files", async () => {
	const manifest = await Bun.file(join(FIRECODE_DIR, "package.json")).json();
	const packed = packedPaths();

	expect(packed.filter((path) => !path.startsWith("dist/") && !/^README(\.[\w-]+)?\.md$/.test(path) && !["LICENSE", "config.example.jsonc", "package.json"].includes(path))).toEqual([]);
	expect(packed.filter((path) => path.endsWith(".ts"))).toEqual([]);
	const entries = (manifest.pi.extensions as string[]).map((entry) => entry.replace(/^\.\//, ""));
	expect(entries.filter((entry) => !packed.includes(entry))).toEqual([]);
	const prompts = PROMPT_DIRS.flatMap((dir) => readdirSync(join(FIRECODE_DIR, dir)).map((name) => `dist/${dir}/${name}`));
	expect(prompts.filter((path) => !packed.includes(path))).toEqual([]);
	// 首次启动播种模板：打包后 config.ts 在 dist 里按自身位置找模板。
	expect(packed).toContain("dist/config.example.jsonc");
});

test("bundle leaves only Node built-ins and host packages to be resolved at load time", async () => {
	packedPaths();
	const bundle = await Bun.file(join(FIRECODE_DIR, "dist/index.js")).text();
	const bare = transpiler.scan(bundle).imports.map(({ path }) => path).filter((path) => !path.startsWith("node:") && !path.startsWith("@earendil-works/"));

	expect(bare).toEqual([]);
});
