/**
 * 开发环境依赖的 pi 源码：版本的唯一事实源与定位规则，测试 loader、类型检查、setup 脚本和 CI 共用。
 * 升级 pi 只改 PI_VERSION，再跑 `bun run setup`。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

export const PI_VERSION = "v1.4.0";
export const PI_REPOSITORY = "https://github.com/earendil-works/pi";

/** setup 把 pi 源码放在仓库之外：测试 loader 会复制整个仓库目录。 */
export function piCheckoutDirectory(): string {
	return process.env.FIRECODE_PI_DIR
		?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "firecode", `pi-${PI_VERSION}`);
}

/** setup 全部步骤做完才写入的标记；目录存在不代表就绪，所以以它为准。 */
export const READY_MARKER = ".firecode-ready";

export function isReady(directory: string): boolean {
	try {
		return readFileSync(join(directory, READY_MARKER), "utf8") === PI_VERSION;
	} catch {
		return false;
	}
}

/** 返回 pi-mono 的 packages 目录；找不到返回 undefined。 */
export function findPiPackages(): string | undefined {
	if (process.env.PI_PACKAGES_DIR) return process.env.PI_PACKAGES_DIR;
	const checkout = piCheckoutDirectory();
	if (isReady(checkout)) return join(checkout, "packages");
	const marker = `${sep}packages${sep}coding-agent${sep}`;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const executable = join(directory, process.platform === "win32" ? "pi.exe" : "pi");
		if (!existsSync(executable)) continue;
		const resolved = realpathSync(executable);
		const boundary = resolved.lastIndexOf(marker);
		if (boundary >= 0) return join(resolved.slice(0, boundary), "packages");
	}
	return undefined;
}

export function requirePiPackages(): string {
	const packages = findPiPackages();
	if (!packages) throw new Error("找不到 pi 源码；先运行 `bun run setup`（或设置 PI_PACKAGES_DIR 指向 pi-mono 的 packages 目录）");
	return packages;
}
