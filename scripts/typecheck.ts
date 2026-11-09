/**
 * 类型检查：宿主类型取自 pi-mono 源码，定位与测试同源（scripts/pi-source.ts）。
 * tsconfig.json 继承 .pi-mono/tsconfig.json，因此这里把 .pi-mono 链到定位到的 pi-mono 根，并用它自带的 tsc。
 * 同时检查 master/ 的依赖规则（deps.ts），两项都过才算通过。
 */
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIRECODE_DIR, PI_PACKAGES } from "../tests/loader.ts";
import { dependencyViolations } from "./deps.ts";

const piRoot = dirname(PI_PACKAGES);
const link = join(FIRECODE_DIR, ".pi-mono");

const existing = lstatSync(link, { throwIfNoEntry: false });
if (existing && !existing.isSymbolicLink()) {
	console.error(`${link} 不是软链接，不会覆盖；请手工移除后重试`);
	process.exit(1);
}
if (!existing || readlinkSync(link) !== piRoot) {
	if (existing) unlinkSync(link);
	symlinkSync(piRoot, link);
}

const tsc = Bun.spawnSync([join(piRoot, "node_modules", ".bin", "tsc"), "--noEmit"], {
	cwd: FIRECODE_DIR,
	stdout: "inherit",
	stderr: "inherit",
});
const violations = dependencyViolations(FIRECODE_DIR);
for (const line of violations) console.error(line);
process.exit(tsc.exitCode || (violations.length ? 1 : 0));
