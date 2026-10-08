/**
 * 类型检查：宿主类型取自 pi-mono 源码，定位与测试同源（tests/loader.ts 的 PI_PACKAGES）。
 * tsconfig.json 继承 .pi-mono/tsconfig.json，因此这里把 .pi-mono 链到定位到的 pi-mono 根，并用它自带的 tsc。
 */
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIRECODE_DIR, PI_PACKAGES } from "../tests/loader.ts";

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
process.exit(tsc.exitCode);
