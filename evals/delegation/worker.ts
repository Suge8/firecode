#!/usr/bin/env bun
// 角色选型：同一批任务换 Worker 模型原子跑，比质量、耗时、花费。直接以 Worker 身份（追加 worker.zh.md）跑 pi -p，
// 不经指挥官，所以只测模型本身，不测派单决策（那是 decide.ts / run.ts 的事）。
//   bun worker.ts <原子[,原子…]> [--tasks audit,research,wait,impl] [--runs 2] [--conc 8]
//   bun worker.ts report
// 原子写法同配置："provider/model/thinking"。结果在 $EVAL_DIR/worker/，已跑完的跳过。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { requirePiPackages } from "../../scripts/pi-source.ts";
import { citedTruth, e2eScript, fixtureDir, T9_TRUTH_FILE } from "./fixtures.ts";
import { finalText, jsonlFiles, killTree, parseList, pool, prepareRun, readJsonl, REPO, startPi, USER_AGENT_DIR, variantAgent, WORK } from "./lib.ts";
import { auditPrompt, TMP_NOTE, taskById } from "./tasks.ts";

const OUT = join(WORK, "worker");
const PI_PACKAGES = requirePiPackages();
const VARIANT = "worker";
const MINUTE = 60_000;

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
	/** 自动判对错；都没有就只能人读（research 用 check.ts t3，impl-quota 读 diff）。 */
	verdict?: (final: string) => boolean;
	/** 隐藏验收：accept.ts 里同名的用例集。 */
	accept?: true;
}

const TASKS: Record<string, Task> = {
	"audit-master": { group: "audit", fixture: "t9", prompt: auditPrompt("master/ 目录和根目录的 format.ts"), timeoutMin: 40, scope: (f) => f.startsWith("master/") || f === "format.ts" },
	"audit-misc": { group: "audit", fixture: "t9", prompt: auditPrompt("session/、statusbar/、watcher/ 三个目录"), timeoutMin: 40, scope: (f) => /^(session|statusbar|watcher)\//.test(f) },
	research: { group: "research", fixture: "base", timeoutMin: 30, prompt: `${taskById("t3-research").prompt} ${TMP_NOTE}` },
	"wait-e2e": { group: "wait", fixture: "base", timeoutMin: 15, setup: { "scripts/e2e.sh": e2eScript(12) }, prompt: "把 scripts/e2e.sh 完整跑一遍（全套大约 2 分半），告诉我哪些场景挂了、各自的失败输出。", verdict: (f) => /review-fail/.test(f) && /compaction/.test(f) },
	"wait-deploy": { group: "wait", fixture: "base", timeoutMin: 15, setup: { "scripts/deploy.sh": DEPLOY }, prompt: "跑 scripts/deploy.sh 发起部署（它在后台跑、立即返回，日志写到仓库根的 deploy.log，大约 2 分钟后出现 DEPLOY OK 或 DEPLOY FAILED 终态行）。等到终态后告诉我结果；失败就给出失败原因原文。不要尝试修复。", verdict: (f) => /0042_add_index/.test(f) && /8812/.test(f) },
	"impl-duration": { group: "impl", fixture: "base", timeoutMin: 25, prompt: "format.ts 的 formatDuration 超过 24 小时现在显示成 25h30m，改成 1d1h30m（天以上照样省略为 0 的单位）；补测试并跑通对应测试文件。", accept: true },
	"impl-quota": { group: "impl", fixture: "base", timeoutMin: 25, prompt: taskById("t8-single").prompt },
	"impl-stats": { group: "impl", fixture: "base", timeoutMin: 40, accept: true, prompt: "给 /tokens（session/stats.ts）加日期范围和按天分组，并把两块逻辑导出成纯函数（时间都是毫秒时间戳，日期按本地时区）：\n1）`export function parseTokensArgs(args: string | undefined, now: number): TokensQuery`，`TokensQuery = { from?: number; to: number; groupBy: \"model\" | \"day\" }`。现有写法语义不变：空参数=最近 30 天，`7`、`7d`、`--days 7`、`-d 7`=最近 N 天（from = now − N 天，to = now），`0`=全部（不设 from）。新增 `--since YYYY-MM-DD`（from=当天 0 点）与 `--until YYYY-MM-DD`（含当天，to=次日 0 点；不写 until 时 to=now），两者可单独出现；新增 `--by day|model`（默认 model），可与上面任一写法组合。天数与 since/until 同时出现、日期不存在或格式不对、since 晚于 until、无法识别的参数，一律抛 Error（message 说清哪里不对）；命令里把它用 notify 报错，不再静默回退默认值。\n2）`export function collectUsage(dir: string, query: TokensQuery)`：扫描 dir 下（含子目录）全部 .jsonl，返回 `{ scanned, matched, overall, groups }`，groups 是 `Map<string, Totals>`（Totals 沿用现有字段）。groupBy=model 时键为 `provider/model`，day 时键为本地日期 `YYYY-MM-DD`。只计时间戳落在 [from, to) 的记录；没有时间戳的记录只在不设 from 时计入，按天分组时归到键 `unknown`。matched 是至少有一条记录被计入的文件数。\n3）/tokens 改用这两个函数；Markdown 按分组方式显示“按模型”或“按日期”一节，按日期时日期升序。\n补测试并跑通。" },
};

/**
 * fixture 里宿主包的 package.json 指向未构建的 dist，导入不了；这里铺一份 node_modules：@earendil-works/* 改成指向 src 的薄壳，
 * 其余链回 pi 源码的 node_modules。src 是符号链接，按真实路径解析，包内依赖照常找到。并发起跑前先建好（见末尾）。
 */
function hostModules(): string {
	const dest = join(WORK, "host-modules");
	if (existsSync(dest)) return dest;
	const root = join(dirname(PI_PACKAGES), "node_modules");
	mkdirSync(join(dest, "@earendil-works"), { recursive: true });
	for (const name of readdirSync(root)) if (name !== "@earendil-works") symlinkSync(join(root, name), join(dest, name));
	for (const name of readdirSync(join(root, "@earendil-works"))) {
		const src = join(realpathSync(join(root, "@earendil-works", name)), "src");
		if (!existsSync(join(src, "index.ts"))) continue;
		const shell = join(dest, "@earendil-works", name);
		mkdirSync(shell);
		symlinkSync(src, join(shell, "src"));
		writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "@earendil-works/" + name, type: "module", exports: "./src/index.ts" }));
	}
	return dest;
}

/** 隐藏验收：跑 accept.ts 里该任务的用例，返回“通过/总数”，未通过的列名字。 */
function accept(task: string, repo: string): string {
	const out = Bun.spawnSync(["bun", join(import.meta.dir, "accept.ts"), task, repo], { env: { ...process.env, TZ: "Asia/Shanghai" } }).stdout.toString().trim();
	const { total, failed } = JSON.parse(out.slice(out.lastIndexOf("\n") + 1)) as { total: number; failed: string[] };
	return total - failed.length + "/" + total + (failed.length ? "（缺 " + failed.join("、") + "）" : "");
}

/** 凭据与设置链回用户目录；firecode 只开 claudeSub（订阅请求要带归因），不激活指挥官，Worker 提示词由命令行追加。 */
function setupAgent(): void {
	const agent = variantAgent(VARIANT);
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
	// fixture 不含测试（git archive 按 export-ignore 去掉了 tests/）：给 impl 铺好宿主包，Worker 自己写的测试才能直接导入被测模块。
	if (spec.group === "impl") {
		symlinkSync(hostModules(), join(repo, "node_modules"));
		appendFileSync(join(repo, ".git/info/exclude"), "node_modules\n");
	}
	const child = startPi(["-p", "--mode", "json", "--model", piModel(atom), "--append-system-prompt", workerPrompt, "--session-dir", join(dir, "sessions"), spec.prompt], { agentDir: variantAgent(VARIANT), cwd: repo, tmp, stdin: "ignore" });
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
	if (spec.accept) return accept(task, join(dir, "repo"));
	return spec.verdict ? (spec.verdict(final) ? "对" : "错") : "人读";
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
	hostModules();
	const jobs: Array<() => Promise<void>> = [];
	for (let run = 1; run <= Number(values.runs); run++)
		for (const [task, spec] of Object.entries(TASKS))
			if (groups.includes(spec.group)) for (const atom of atoms) jobs.push(() => runOne(task, atom, run));
	await pool(jobs, Number(values.conc));
	report();
}
