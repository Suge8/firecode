/**
 * 在测试里加载 FireCode 模块：扩展运行时由 pi 注入 `@earendil-works/*`，
 * 测试环境没有这层注入，因此把整个插件目录复制到临时目录并把包名改写到 pi 源码。
 */
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 从本文件位置推导插件目录，不能硬编码 ~/.pi：否则无论在哪个 checkout 跑测试，
// 加载的都是全局安装的那份工作树，对错误快照也会给出假绿。
export const FIRECODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = FIRECODE_DIR;
const PI_PACKAGES = join(homedir(), "Project/pi/packages");
export const PI_CODING_AGENT_URL = pathToFileURL(join(PI_PACKAGES, "coding-agent/src/index.ts")).href;
const PI_CODING_AGENT = PI_CODING_AGENT_URL;
const PI_AI = pathToFileURL(join(PI_PACKAGES, "ai/src/index.ts")).href;
const PI_TUI = pathToFileURL(join(PI_PACKAGES, "tui/src/index.ts")).href;

const created: string[] = [];

async function rewriteImports(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await rewriteImports(path);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const source = (await readFile(path, "utf8"))
			.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(PI_CODING_AGENT))
			.replaceAll('"@earendil-works/pi-ai"', JSON.stringify(PI_AI))
			.replaceAll('"@earendil-works/pi-tui"', JSON.stringify(PI_TUI));
		await writeFile(path, source);
	}
}

/**
 * 加载插件内某个模块，例如 `tools/index.ts`、`session/presets.ts`。
 * `configJsonc` 可覆写副本里的 config.jsonc，用于验证配置错误下的行为。
 */
export async function loadFirecodeModule(
	entry: string,
	options: {
		configJsonc?: string;
		replacements?: Record<string, string>;
		extraFiles?: Record<string, string>;
	} = {},
): Promise<Record<string, unknown>> {
	const directory = await mkdtemp(join(tmpdir(), "firecode-test-"));
	created.push(directory);
	await cp(SOURCE_DIR, directory, { recursive: true });
	await rm(join(directory, "tests"), { recursive: true, force: true });
	if (options.configJsonc !== undefined)
		await writeFile(join(directory, "config.jsonc"), options.configJsonc);
	for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
		const destination = join(directory, path);
		await writeFile(destination, content);
	}
	await rewriteImports(directory);
	for (const [oldText, newText] of Object.entries(options.replacements ?? {})) {
		const sourceEntry = entry.endsWith(".js") ? `${entry.slice(0, -3)}.ts` : entry;
		const path = join(directory, sourceEntry);
		await writeFile(path, (await readFile(path, "utf8")).replace(oldText, newText));
	}
	return import(`${pathToFileURL(join(directory, entry)).href}?test=${Date.now()}`);
}

export async function cleanupFirecodeModules(): Promise<void> {
	await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export const PI_TUI_URL = PI_TUI;
