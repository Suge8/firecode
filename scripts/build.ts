/**
 * 发布构建：把运行时代码打成单文件 dist/index.js，提示词复制到 dist 里与源码相同的相对位置。
 * 宿主包由 pi 注入，必须 external；提示词读取靠 import.meta.url，打包后它指向 dist/index.js，
 * 所以读取提示词的三个模块在构建时把它改写成“该模块在 dist 里应在的位置”，源码因此不用为打包改动。
 */
import { cp, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");
const PROMPT_DIRS = ["master/prompts", "review/prompts", "watcher/prompts"];
const PROMPT_READERS = /[\\/](master[\\/]prompt|review[\\/]prompt|watcher[\\/]observer)\.ts$/;

await rm(DIST, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [join(ROOT, "index.ts")],
	outdir: DIST,
	target: "node",
	format: "esm",
	external: ["@earendil-works/*"],
	plugins: [
		{
			name: "prompt-location",
			setup(build) {
				build.onLoad({ filter: PROMPT_READERS }, async ({ path }) => {
					const virtual = relative(ROOT, path).replace(/\.ts$/, ".js").split("\\").join("/");
					const source = await Bun.file(path).text();
					return { contents: source.replaceAll("import.meta.url", `new URL("./${virtual}", import.meta.url).href`), loader: "ts" };
				});
			},
		},
	],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
for (const dir of PROMPT_DIRS) await cp(join(ROOT, dir), join(DIST, dir), { recursive: true });
