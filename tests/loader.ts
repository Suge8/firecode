/**
 * 在测试里加载 FireCode 模块：扩展运行时由 pi 注入 `@earendil-works/*`，
 * 测试环境没有这层注入，因此把插件目录复制到临时目录并把包名改写到 pi 源码。
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIRECODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function piPackagesDirectory(): string {
	if (process.env.PI_PACKAGES_DIR) return process.env.PI_PACKAGES_DIR;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const executable = join(directory, process.platform === "win32" ? "pi.exe" : "pi");
		if (!existsSync(executable)) continue;
		const resolved = realpathSync(executable);
		const marker = `${sep}packages${sep}coding-agent${sep}`;
		const boundary = resolved.lastIndexOf(marker);
		if (boundary >= 0) return join(resolved.slice(0, boundary), "packages");
	}
	throw new Error("Cannot locate Pi sources; set PI_PACKAGES_DIR to the pi-mono packages directory");
}

export const PI_PACKAGES = piPackagesDirectory();
export const PI_CODING_AGENT_URL = pathToFileURL(join(PI_PACKAGES, "coding-agent/src/index.ts")).href;
export const PI_AI_URL = pathToFileURL(join(PI_PACKAGES, "ai/src/index.ts")).href;
export const PI_AI_COMPAT_URL = pathToFileURL(join(PI_PACKAGES, "ai/src/compat.ts")).href;
export const PI_TUI_URL = pathToFileURL(join(PI_PACKAGES, "tui/src/index.ts")).href;

/** 测试默认中文：配置未写 language 时 FireCode 跟随系统 locale，这里固定它，断言才与机器无关。 */
process.env.LC_ALL = "zh_CN.UTF-8";

/**
 * 模块缓存按路径区分实例，而配置在模块加载时读定，所以每份不同的配置/额外文件要一个独立目录。
 * 整仓复制并改写宿主包导入只做一次（基础副本）；其余副本用硬链接铺出同样的文件树——路径各异所以模块实例互不串，
 * 内容不再复制。只有因副本而异的文件（config-file.ts、额外文件）先删后写，绝不原地改共享内容；基础副本的文件设为只读，误写会当场报错。
 * 进程退出时统一删除。
 */
const copies = new Map<string, Promise<string>>();
const shared: string[] = [];
process.on("exit", () => {
	for (const directory of shared) rmSync(directory, { recursive: true, force: true });
});
const NON_RUNTIME_ROOTS = new Set([".git", ".github", ".pi-mono", "tests", "dist", "site", "design", "evals", "scripts"]);
export const TEST_REVIEW_CONFIG = {
	advisor: "test/advisor/high",
	reviewers: ["test/reviewer/high"],
	maxRounds: 3,
	advisorAfterFailures: 2,
	timeoutMinutes: 1,
	tools: ["read", "bash"],
};
const TEST_CONFIG_JSONC = JSON.stringify({
	features: {
		header: true,
		statusbar: true,
		tools: true,
		presets: true,
		stats: true,
		claudeSub: false,
		openaiNative: false,
		review: true,
		master: false,
	},
	keys: { fast: "ctrl+shift+s" },
	presets: { deep: { model: "test/deep/high", key: "alt+1" } },
	review: TEST_REVIEW_CONFIG,
});

async function copyFirecodeSource(destination: string): Promise<void> {
	await cp(FIRECODE_DIR, destination, {
		recursive: true,
		filter: (source) => {
			const path = relative(FIRECODE_DIR, source);
			const [root] = path.split(sep);
			if (NON_RUNTIME_ROOTS.has(root) || path.endsWith(".test.ts") || path === join("provider", "openai-native", "test")) return false;
			if (![".md", ".mdx"].includes(extname(path))) return true;
			return path.startsWith(`master${sep}prompts${sep}`)
				|| path.startsWith(`review${sep}prompts${sep}`)
				|| path.startsWith(`watcher${sep}prompts${sep}`);
		},
	});
}

async function rewriteImports(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await rewriteImports(path);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const source = (await readFile(path, "utf8"))
			.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(PI_CODING_AGENT_URL))
			.replaceAll('"@earendil-works/pi-ai"', JSON.stringify(PI_AI_URL))
			.replaceAll('"@earendil-works/pi-tui"', JSON.stringify(PI_TUI_URL));
		await writeFile(path, source);
	}
}

const GET_AGENT_DIR_IMPORT = `import { getAgentDir } from ${JSON.stringify(PI_CODING_AGENT_URL)};`;

type Base = { directory: string; dirs: string[]; files: string[]; symlinks: [string, string][]; configFile: string };
let base: Promise<Base> | undefined;

async function prepareBase(): Promise<Base> {
	const directory = await mkdtemp(join(tmpdir(), "firecode-base-"));
	shared.push(directory);
	await copyFirecodeSource(directory);
	await rewriteImports(directory);
	const dirs: string[] = [];
	const files: string[] = [];
	const symlinks: [string, string][] = [];
	for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
		const path = relative(directory, join(entry.parentPath, entry.name));
		if (entry.isDirectory()) dirs.push(path);
		else if (entry.isSymbolicLink()) symlinks.push([path, await readlink(join(directory, path))]);
		else files.push(path);
	}
	await Promise.all(files.map((file) => chmod(join(directory, file), 0o444)));
	const configFile = await readFile(join(directory, "config-file.ts"), "utf8");
	if (!configFile.includes(GET_AGENT_DIR_IMPORT)) throw new Error("FireCode config path seam changed");
	return { directory, dirs, files, symlinks, configFile };
}

/** 先删后写：目标可能是与基础副本共享的硬链接，原地写会污染所有副本。 */
async function writeOwn(path: string, content: string): Promise<void> {
	await rm(path, { force: true });
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

type LoadOptions = { configJsonc?: string | null; extraFiles?: Record<string, string> };

/** 与 loadFirecodeModule 同一份副本里某个模块的绝对路径：供测试写进子会话扩展文件，让子会话加载同一份代码。 */
export async function firecodeModulePath(entry: string, options: LoadOptions = {}): Promise<string> {
	return join(await copyFor(options), entry);
}

/**
 * 加载插件内某个模块，例如 `tools/index.ts`、`session/presets.ts`。
 * `configJsonc` 可覆写或移除测试 Agent 目录里的运行配置，用于验证配置边界。
 */
export async function loadFirecodeModule(entry: string, options: LoadOptions = {}): Promise<Record<string, unknown>> {
	const directory = await copyFor(options);
	const sourceEntry = entry.endsWith(".js") ? `${entry.slice(0, -3)}.ts` : entry;
	return import(`${pathToFileURL(join(directory, sourceEntry)).href}?test=${Date.now()}-${Math.random()}`);
}

function copyFor(options: LoadOptions): Promise<string> {
	// undefined（默认测试配置）与 null（没有运行配置）必须分开：JSON 会把两者都写成 null。
	const config = options.configJsonc === undefined ? { default: true } : { text: options.configJsonc };
	const key = JSON.stringify([config, options.extraFiles]);
	let copy = copies.get(key);
	if (!copy) copies.set(key, copy = prepareCopy(options));
	return copy;
}

async function prepareCopy(options: LoadOptions): Promise<string> {
	const source = await (base ??= prepareBase());
	const directory = await mkdtemp(join(tmpdir(), "firecode-test-"));
	shared.push(directory);
	await Promise.all(source.dirs.map((dir) => mkdir(join(directory, dir), { recursive: true })));
	await Promise.all([
		...source.files.map((file) => link(join(source.directory, file), join(directory, file))),
		...source.symlinks.map(([path, target]) => symlink(target, join(directory, path))),
	]);
	const agentDir = join(directory, "agent");
	const configDir = join(agentDir, "extensions", "firecode");
	await mkdir(configDir, { recursive: true });
	if (options.configJsonc !== null) await writeFile(join(configDir, "config.jsonc"), options.configJsonc ?? TEST_CONFIG_JSONC);
	for (const [path, content] of Object.entries(options.extraFiles ?? {})) await writeOwn(join(directory, path), content);
	await writeOwn(
		join(directory, "config-file.ts"),
		source.configFile.replace(GET_AGENT_DIR_IMPORT, `const getAgentDir = () => ${JSON.stringify(agentDir)};`),
	);
	return directory;
}

/** 注册入口测试只开启指定功能，其余开关从运行配置的唯一功能清单派生。 */
export async function featuresOnly(...enabled: string[]): Promise<Record<string, boolean>> {
	const { FEATURES } = await loadFirecodeModule("config.ts") as { FEATURES: readonly string[] };
	return Object.fromEntries(FEATURES.map((feature) => [feature, enabled.includes(feature)]));
}
