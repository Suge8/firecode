#!/usr/bin/env bun
// 评测环境，全部装在 $EVAL_DIR，不碰维护者的共享缓存：
//   bun setup.ts [v1.1.0,…]   FireCode 历史样本用的宿主源码（默认四个版本）
//   bun setup.ts pi           pi 历史样本按各自 lockfile 装依赖
//   bun setup.ts fixtures     FireCode 样本预先构建 dist（pi-smoke 要它，开发者本地通常已构建）
//   bun setup.ts check [id,…] 每个样本在改动后的树上实跑验证命令，结果写 $EVAL_DIR/envcheck.json：合成会话的验证轨迹与交付声明取自它，
//                             正式比较前人工看一遍失败项是改动造成的还是环境造成的
// 模型目录由 hydrate 从今天的上游服务生成，可能含旧版源码还不认识的 API 分组（如 opencode-go 的 google-generative-ai），
// 那个版本发布时的目录不可能有它；只保留该供应商源码里写出的 API 分组，即还原成与该版本类型相容的目录。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseList, pool } from "../delegation/lib.ts";
import { CASES, headOf } from "./cases.ts";
import { type CheckResult, copyRepo, ENVCHECK, fixtureRepo } from "./fixture.ts";
import { fixtureHost, SOURCES, WORK } from "./lib.ts";

function compatibleCatalog(root: string): void {
	const data = join(root, "packages/ai/src/providers/data");
	for (const file of readdirSync(data).filter((name) => name.endsWith(".json"))) {
		const source = join(data, "..", file.replace(/\.json$/u, ".ts"));
		if (!existsSync(source)) continue;
		const text = readFileSync(source, "utf8");
		const groups = JSON.parse(readFileSync(join(data, file), "utf8")) as Record<string, unknown>;
		const kept = Object.fromEntries(Object.entries(groups).filter(([api]) => text.includes(`"${api}"`)));
		if (Object.keys(kept).length !== Object.keys(groups).length) writeFileSync(join(data, file), JSON.stringify(kept));
	}
}

const run = (cwd: string, command: string[], env?: Record<string, string>) =>
	execFileSync(command[0]!, command.slice(1), { cwd, stdio: "inherit", env: { ...process.env, ...env } });

const mode = process.argv[2];
if (mode === "pi") {
	for (const item of CASES.filter((item) => item.source === "pi")) {
		const cwd = fixtureRepo(item);
		if (existsSync(join(cwd, "node_modules"))) continue;
		run(cwd, ["npm", "ci", "--ignore-scripts"]);
		run(cwd, ["npm", "run", "hydrate:model-data"]);
		compatibleCatalog(cwd);
	}
} else if (mode === "fixtures") {
	for (const item of CASES.filter((item) => item.source === "firecode")) {
		const cwd = fixtureRepo(item);
		if (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts?.build) run(cwd, ["bun", "run", "build"], fixtureHost(cwd).env);
	}
} else if (mode === "check") {
	const results: Record<string, CheckResult[]> = existsSync(ENVCHECK) ? JSON.parse(readFileSync(ENVCHECK, "utf8")) : {};
	const only = parseList(process.argv[3]);
	await pool(CASES.filter((item) => !only || only.includes(item.id)).map((item) => async () => {
		const repo = copyRepo(item, join(WORK, "envcheck", item.id));
		const env = { ...process.env, ...(item.source === "firecode" ? fixtureHost(repo).env : {}) };
		results[item.id] = item.turns.at(-1)!.checks.map((command) => {
			const done = spawnSync("sh", ["-c", command], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 });
			return { command, exit: done.status, tail: `${done.stdout}\n${done.stderr}`.trim().split("\n").slice(-15).join("\n").replaceAll(repo, ".") };
		});
		rmSync(repo, { recursive: true, force: true });
		console.log(item.id, headOf(item), results[item.id]!.map((entry) => `${entry.command}=${entry.exit}`).join("  "));
	}), 3);
	writeFileSync(ENVCHECK, JSON.stringify(results, null, 1));
} else {
	const root = join(WORK, "hosts");
	mkdirSync(root, { recursive: true });
	for (const version of parseList(mode) ?? ["v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0"]) {
		if (!/^v\d+\.\d+\.\d+$/u.test(version)) throw new Error(`不是版本标签：${version}`);
		const target = join(root, version);
		if (existsSync(join(target, ".firecode-ready"))) continue;
		const partial = `${target}.partial-${process.pid}`;
		mkdirSync(partial);
		try {
			run(partial, ["git", "clone", "-q", "--depth", "1", "--branch", version, `file://${SOURCES.pi}`, "."]);
			run(partial, ["npm", "ci", "--ignore-scripts"]);
			run(partial, ["npm", "run", "hydrate:model-data"]);
			compatibleCatalog(partial);
			writeFileSync(join(partial, ".firecode-ready"), version);
			renameSync(partial, target);
			console.log(`${version} 已安装：${target}`);
		} finally {
			rmSync(partial, { recursive: true, force: true });
		}
	}
}
