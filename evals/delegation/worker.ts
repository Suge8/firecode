#!/usr/bin/env bun
// 角色选型：同一批任务换 Worker 模型原子跑，比质量、耗时、花费。直接以 Worker 身份（追加 worker.zh.md）跑 pi -p，
// 不经指挥官，所以只测模型本身，不测派单决策（那是 decide.ts / run.ts 的事）。
//   bun worker.ts <原子[,原子…]> [--tasks audit,research,wait,impl] [--runs 2] [--conc 8]
//   bun worker.ts report
// 原子写法同配置："provider/model/thinking"。结果在 $EVAL_DIR/worker/，已跑完的跳过。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { PI_PACKAGES } from "../../tests/loader.ts";
import { citedTruth, fixtureDir, T9_TRUTH_FILE } from "./fixtures.ts";
import { finalText, jsonlFiles, killTree, parseList, pool, prepareRun, readJsonl, REPO, startPi, USER_AGENT_DIR, WORK } from "./lib.ts";

const OUT = join(WORK, "worker");
const VARIANT = "worker";
const MINUTE = 60_000;
const TMP_NOTE = " 需要临时文件时只能放在环境变量 TMPDIR 指向的目录里。";
const audit = (scope: string) => "审计这个仓库的 " + scope + "：找真实缺陷——代码行为与各目录 AGENTS.md、代码注释和命名所表达的契约不符，或会导致错误结果、状态错乱、数据丢失的逻辑错误。给我一份带文件:行号和触发条件的清单，按严重度排序，不要改任何代码。" + TMP_NOTE;

// bash 的 ${...} 与模板字符串冲突，脚本按行拼。
const E2E = [
	"#!/bin/bash",
	"cases=(boot preset-switch rename review-pass review-fail master-start master-steer master-kill watcher-quiet quota-query herdr-label compaction)",
	"failed=()",
	'for c in ${cases[@]}; do',
	'	echo "[e2e] $c ..."; sleep 12',
	'	case "$c" in review-fail|compaction) echo "[e2e] $c FAIL: expected settled got timeout"; failed+=("$c");; *) echo "[e2e] $c PASS";; esac',
	"done",
	'echo "[e2e] 失败：${failed[*]:-无}"',
	'[ ${#failed[@]} -eq 0 ]',
	"",
].join("\n");
const DEPLOY = [
	"#!/bin/bash",
	'cd "$(dirname "$0")/.."',
	'( echo "[deploy] build"; sleep 40; echo "[deploy] upload"; sleep 40; echo "[deploy] migrate"; sleep 30; echo "DEPLOY FAILED: migration 0042_add_index timed out after 30s (lock held by pid 8812)" ) > deploy.log 2>&1 &',
	'echo "deploy started, see deploy.log"',
	"",
].join("\n");

interface Task {
	group: string;
	fixture: "base" | "t9";
	prompt: string;
	timeoutMin: number;
	setup?: Record<string, string>;
	/** audit：植入缺陷按文件前缀归到这一块。 */
	scope?: (file: string) => boolean;
	/** 自动判对错；返回 undefined 表示只能人读（research 用 check.ts t3，impl-quota 读 diff）。 */
	verdict?: (final: string, repo: string) => boolean;
}

const TASKS: Record<string, Task> = {
	"audit-master": { group: "audit", fixture: "t9", prompt: audit("master/ 目录和根目录的 format.ts"), timeoutMin: 40, scope: (f) => f.startsWith("master/") || f === "format.ts" },
	"audit-misc": { group: "audit", fixture: "t9", prompt: audit("session/、statusbar/、watcher/ 三个目录"), timeoutMin: 40, scope: (f) => /^(session|statusbar|watcher)\//.test(f) },
	research: { group: "research", fixture: "base", timeoutMin: 30, prompt: "联网调研一下：现在 Node/Bun 生态里能在终端渲染 Markdown 的库有哪些（至少 8 个，pi-tui 自带的不算）。逐个查最新版本、最近一次发布时间、依赖数量、是否支持表格和代码高亮，最后给对比表和你的推荐。" + TMP_NOTE },
	"wait-e2e": { group: "wait", fixture: "base", timeoutMin: 15, setup: { "scripts/e2e.sh": E2E }, prompt: "把 scripts/e2e.sh 完整跑一遍（全套大约 2 分半），告诉我哪些场景挂了、各自的失败输出。", verdict: (f) => /review-fail/.test(f) && /compaction/.test(f) },
	"wait-deploy": { group: "wait", fixture: "base", timeoutMin: 15, setup: { "scripts/deploy.sh": DEPLOY }, prompt: "跑 scripts/deploy.sh 发起部署（它在后台跑、立即返回，日志写到仓库根的 deploy.log，大约 2 分钟后出现 DEPLOY OK 或 DEPLOY FAILED 终态行）。等到终态后告诉我结果；失败就给出失败原因原文。不要尝试修复。", verdict: (f) => /0042_add_index/.test(f) && /8812/.test(f) },
	"impl-duration": { group: "impl", fixture: "base", timeoutMin: 25, prompt: "format.ts 的 formatDuration 超过 24 小时现在显示成 25h30m，改成 1d1h30m（天以上照样省略为 0 的单位）；补测试并跑通对应测试文件。", verdict: (_, repo) => durationCorrect(repo) },
	"impl-quota": { group: "impl", fixture: "base", timeoutMin: 25, prompt: "给 session/quota.ts 的供应商查询加 8 秒超时：超时算该家失败、报超时原因，不影响另一家的结果；补测试并跑通。" },
};

/** 隐藏验收：不看 Worker 自己写的测试，直接按需求调它改过的 formatDuration。 */
function durationCorrect(repo: string): boolean {
	const modules = join(repo, "node_modules");
	if (!existsSync(modules)) symlinkSync(join(dirname(PI_PACKAGES), "node_modules"), modules);
	const H = 3_600_000;
	const cases: Array<[number, string]> = [[25.5 * H, "1d1h30m"], [24 * H, "1d"], [24 * H + 25_000, "1d25s"], [48 * H + 180_000, "2d3m"], [3 * H, "3h"], [59_000, "59s"], [9_900, "9.9s"], [24 * H - 400, "1d"]];
	const probe = "const { formatDuration: f } = await import(" + JSON.stringify(join(repo, "format.ts")) + "); console.log(JSON.stringify(" + JSON.stringify(cases) + ".every(([ms, want]) => f(ms) === want)));";
	return Bun.spawnSync(["bun", "-e", probe]).stdout.toString().trim() === "true";
}

/** 凭据与设置链回用户目录；firecode 只开 claudeSub（订阅请求要带归因），不激活指挥官，Worker 提示词由命令行追加。 */
function setupAgent(): void {
	const agent = join(WORK, "variants", VARIANT, "agent");
	if (existsSync(agent)) return;
	mkdirSync(join(agent, "extensions/firecode"), { recursive: true });
	for (const file of ["auth.json", "settings.json", "models.json", "models-store.json", "SYSTEM.md", "bin"])
		if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
	const off = Object.fromEntries(["header", "statusbar", "tools", "presets", "rename", "stats", "openaiNative", "review", "master", "watcher"].map((k) => [k, false]));
	writeFileSync(join(agent, "extensions/firecode/config.jsonc"), JSON.stringify({ features: { ...off, claudeSub: true } }));
	writeFileSync(join(agent, "extensions/firecode/index.ts"), 'export { default } from "./source/index.ts";\n');
	symlinkSync(REPO, join(agent, "extensions/firecode/source"));
}

const piModel = (atom: string) => atom.replace(/\/([^/]+)$/, ":$1");
const runId = (task: string, atom: string, run: number) => task + "__" + atom.replace(/\//g, "_") + "__" + run;

async function runOne(task: string, atom: string, run: number): Promise<void> {
	const dir = join(OUT, runId(task, atom, run));
	if (existsSync(join(dir, "result.json"))) return;
	const spec = TASKS[task]!;
	const { repo, tmp } = prepareRun(dir, fixtureDir(spec.fixture));
	for (const [path, content] of Object.entries(spec.setup ?? {})) writeFileSync(join(repo, path), content, { mode: 0o755 });
	const workerPrompt = '<firecode_worker name="eval">\n' + readFileSync(join(REPO, "master/prompts/worker.zh.md"), "utf8").trim() + "\n</firecode_worker>";
	const child = startPi(["-p", "--mode", "json", "--model", piModel(atom), "--append-system-prompt", workerPrompt, "--session-dir", join(dir, "sessions"), spec.prompt], { variant: VARIANT, cwd: repo, tmp, stdin: "ignore" });
	child.stdout!.resume();
	child.stderr!.on("data", (chunk: Buffer) => appendFileSync(join(dir, "stderr.txt"), chunk));
	const started = Date.now();
	const status = await new Promise<string>((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), spec.timeoutMin * MINUTE);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? "ok" : "exit " + code);
		});
	});
	killTree(child);
	const entries = jsonlFiles(join(dir, "sessions")).flatMap(readJsonl);
	const usage = entries.filter((e) => e.message?.role === "assistant").map((e) => e.message.usage ?? {});
	const result = {
		task, atom, run, status,
		wall: (Date.now() - started) / 1000,
		cost: usage.reduce((sum, u) => sum + (u.cost?.total ?? 0), 0),
		output: usage.reduce((sum, u) => sum + (u.output ?? 0), 0),
		tools: entries.filter((e) => e.message?.role === "toolResult").length,
	};
	writeFileSync(join(dir, "final.md"), jsonlFiles(join(dir, "sessions")).map(finalText).join("\n"));
	writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
	console.log(runId(task, atom, run), status, result.wall.toFixed(0) + "s", "$" + result.cost.toFixed(3));
}

function quality(task: string, dir: string): string {
	const spec = TASKS[task]!;
	const final = readFileSync(join(dir, "final.md"), "utf8");
	if (spec.scope) {
		const truth: Array<{ id: string; file: string; line: number }> = JSON.parse(readFileSync(T9_TRUTH_FILE, "utf8")).filter((t: { file: string }) => spec.scope!(t.file));
		return citedTruth(truth, final).length + "/" + truth.length;
	}
	return spec.verdict ? (spec.verdict(final, join(dir, "repo")) ? "对" : "错") : "人读";
}

function report(): void {
	const rows = new Map<string, string[]>();
	for (const name of existsSync(OUT) ? readdirSync(OUT).sort() : []) {
		const file = join(OUT, name, "result.json");
		if (!existsSync(file)) continue;
		const r = JSON.parse(readFileSync(file, "utf8"));
		const key = r.task + " | " + r.atom;
		rows.set(key, [...(rows.get(key) ?? []), [quality(r.task, join(OUT, name)), r.wall.toFixed(0) + "s", "$" + r.cost.toFixed(3), r.status === "ok" ? "" : r.status].join(" ").trim()]);
	}
	console.log("任务 | 原子 | 每次：质量 墙钟 花费（审计质量 = 指到植入缺陷 ±5 行的个数，漏指行号的须人读）");
	for (const [key, runs] of rows) console.log(key + " | " + runs.join(" ; "));
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tasks: { type: "string", default: "audit,research,wait,impl" }, runs: { type: "string", default: "2" }, conc: { type: "string", default: "8" } } });
if (positionals[0] === "report") {
	report();
} else {
	const atoms = parseList(positionals[0]);
	if (!atoms?.length) throw new Error("用法见文件头注释");
	const groups = parseList(values.tasks)!;
	setupAgent();
	fixtureDir("t9");
	fixtureDir("base");
	const jobs: Array<() => Promise<void>> = [];
	for (let run = 1; run <= Number(values.runs); run++)
		for (const [task, spec] of Object.entries(TASKS))
			if (groups.includes(spec.group)) for (const atom of atoms) jobs.push(() => runOne(task, atom, run));
	await pool(jobs, Number(values.conc));
	report();
}
