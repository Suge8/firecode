/**
 * 一条命令搭好开发环境：把 pi 源码按 PI_VERSION 克隆到仓库之外的缓存目录并装好依赖。
 * 先在 .partial 目录里做完全部步骤，最后整体改名，所以目录存在就代表已就绪；失败不留半成品。重复运行直接跳过。
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PI_REPOSITORY, PI_VERSION, piCheckoutDirectory } from "./pi-source.ts";

const target = piCheckoutDirectory();
if (existsSync(target)) {
	console.log(`pi ${PI_VERSION} 已就绪：${target}`);
	process.exit(0);
}

const partial = `${target}.partial`;
function run(command: string[], cwd?: string): void {
	const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) {
		rmSync(partial, { recursive: true, force: true });
		console.error(`失败（退出码 ${result.exitCode}）：${command.join(" ")}`);
		process.exit(result.exitCode || 1);
	}
}

mkdirSync(dirname(target), { recursive: true });
rmSync(partial, { recursive: true, force: true });
run(["git", "clone", "--depth", "1", "--branch", PI_VERSION, PI_REPOSITORY, partial]);
// 用 cwd 而不是 --prefix：npm 11.20 的 --prefix 会拿目录名当根包名，与 lockfile 对不上。
run(["npm", "ci", "--ignore-scripts"], partial);
// 生成 pi-ai 导入的、被 git 忽略的模型数据。
run(["npm", "run", "hydrate:model-data"], partial);
renameSync(partial, target);
console.log(`pi ${PI_VERSION} 已就绪：${target}`);
