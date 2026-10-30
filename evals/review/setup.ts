#!/usr/bin/env bun
// 历史 fixture 的宿主依赖放在评测临时目录；不改维护者的共享缓存。
// 模型目录来自当前上游服务，可能与旧版源码的类型不兼容；原样保留失败，不改供应商数据掩盖它。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseList } from "../delegation/lib.ts";
import { CASES } from "./cases.ts";
import { fixtureRepo } from "./fixture.ts";
import { WORK } from "./lib.ts";

if (process.argv[2] === "pi") {
	for (const item of CASES.filter((item) => item.source === "pi")) {
		const cwd = fixtureRepo(item);
		execFileSync("npm", ["ci", "--ignore-scripts"], { cwd, stdio: "inherit" });
		execFileSync("npm", ["run", "hydrate:model-data"], { cwd, stdio: "inherit" });
	}
	process.exit(0);
}
const versions = parseList(process.argv[2]) ?? ["v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0"];
const root = join(WORK, "hosts");
mkdirSync(root, { recursive: true });
for (const version of versions) {
	if (!/^v\d+\.\d+\.\d+$/u.test(version)) throw new Error(`不是版本标签：${version}`);
	const target = join(root, version);
	const marker = join(target, ".firecode-ready");
	if (existsSync(marker) && readFileSync(marker, "utf8") === version) continue;
	const partial = `${target}.partial-${process.pid}`;
	mkdirSync(partial);
	try {
		const run = (...command: string[]) => execFileSync(command[0]!, command.slice(1), { cwd: partial, stdio: "inherit" });
		run("git", "clone", "--depth", "1", "--branch", version, "https://github.com/earendil-works/pi", ".");
		run("npm", "ci", "--ignore-scripts");
		run("npm", "run", "hydrate:model-data");
		writeFileSync(join(partial, ".firecode-ready"), version);
		renameSync(partial, target);
		console.log(`${version} 已安装：${target}`);
	} finally {
		rmSync(partial, { recursive: true, force: true });
	}
}
