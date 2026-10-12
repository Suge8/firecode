/**
 * 一条命令搭好开发环境：把 pi 源码按 PI_VERSION 克隆到仓库之外的缓存目录并装好依赖。
 * 先在 .partial 目录里做完全部步骤并写入就绪标记，最后整体改名；失败不留半成品。已就绪则跳过；
 * 目标目录存在但没有匹配的标记（不是 setup 建的，或版本不同）时报错，不覆盖也不当作就绪。
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isReady, PI_REPOSITORY, PI_VERSION, piCheckoutDirectory, READY_MARKER } from "./pi-source.ts";

const target = piCheckoutDirectory();
if (isReady(target)) {
	console.log(`pi ${PI_VERSION} 已就绪：${target}`);
	process.exit(0);
}
if (existsSync(target)) {
	console.error(`${target} 已存在但不是 setup 为 ${PI_VERSION} 建的；换一个 FIRECODE_PI_DIR，或手工移除后重试`);
	process.exit(1);
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
writeFileSync(join(partial, READY_MARKER), PI_VERSION);
renameSync(partial, target);
console.log(`pi ${PI_VERSION} 已就绪：${target}`);
