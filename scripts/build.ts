/**
 * 发布构建：把运行时代码打成单文件 dist/index.js，提示词复制到 dist 里与源码相同的相对位置。
 * 宿主包由 pi 注入，必须 external；模块用 import.meta.url 定位同目录资源（提示词），打包后它指向 dist/index.js，
 * 所以构建时对每个含 import.meta.url 的源码模块把它改写成“该模块在 dist 里应在的位置”，源码因此不用为打包改动。
 */
import { cp, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");
const PROMPT_DIRS = ["master/prompts", "review/prompts", "watcher/prompts"];

await rm(DIST, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [join(ROOT, "index.ts")],
	outdir: DIST,
	target: "node",
	format: "esm",
	external: ["@earendil-works/*"],
	plugins: [
		{
			name: "import-meta-url",
			setup(build) {
				build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
					if (path.includes("node_modules")) return undefined;
					const virtual = relative(ROOT, path).replace(/\.ts$/, ".js").split("\\").join("/");
					const source = await Bun.file(path).text();
					if (!source.includes("import.meta.url")) return undefined;
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
await cp(join(ROOT, "config.example.jsonc"), join(DIST, "config.example.jsonc"));
for (const dir of PROMPT_DIRS) await cp(join(ROOT, dir), join(DIST, dir), { recursive: true });
