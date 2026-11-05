#!/usr/bin/env bun
// 角色选型：同一批任务换 Worker 模型原子跑，比质量、耗时、花费。直接以 Worker 身份（追加 worker.zh.md）跑 pi -p，
// 不经指挥官，所以只测模型本身，不测派单决策（那是 decide.ts / run.ts 的事）。
//   bun worker.ts <原子[,原子…]> [--tasks audit,research,wait,impl] [--runs 2] [--conc 8] [--forms only,on,off] [--budget 美元] [--seed 种子]
// --forms：同一批任务换工具形态跑（lib.ts 的 TOOL_FORMS：defaultTools 与 codemode.mode 的组合，只写各形态自己的 settings）；
// 不给则沿用你的 settings。--tasks 里也可直接写任务名（如 impl-duration）；--budget 是 $EVAL_DIR 下全部运行的累计上限，超了不再起新运行（已在跑的跑完）。
// 调度：同一轮同一任务各形态各跑一次（一组），组内顺序按 --seed 洗牌，不同组按 --conc 并发。
//   bun worker.ts report
// 原子写法同配置："provider/model/thinking"。结果在 $EVAL_DIR/worker/，已跑完的跳过。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { citedTruth, e2eScript, fixtureDir, T9_TRUTH_FILE } from "./fixtures.ts";
import { finalText, jsonlFiles, killTree, parseList, pool, prepareRun, REPO, runCost, seededShuffle, startPi, TOOL_FORMS, variantAgent, WORK } from "./lib.ts";
import { accept, effort, hostModules, setupAgent, variantOf } from "./worker-agent.ts";
import { auditPrompt, TMP_NOTE, taskById } from "./tasks.ts";

const OUT = join(WORK, "worker");
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

const piModel = (atom: string) => atom.replace(/\/([^/]+)$/, ":$1");
const runId = (task: string, atom: string, run: number, form?: string) => [task, form, atom.replace(/\//g, "_"), run].filter((part) => part !== undefined).join("__");

async function runOne(task: string, atom: string, run: number, form: string | undefined, order: number): Promise<void> {
	const dir = join(OUT, runId(task, atom, run, form));
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
	const child = startPi(["-p", "--mode", "json", "--model", piModel(atom), "--append-system-prompt", workerPrompt, "--session-dir", join(dir, "sessions"), spec.prompt], { agentDir: variantAgent(variantOf(form)), cwd: repo, tmp, stdin: "ignore" });
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
	writeFileSync(join(dir, "final.md"), jsonlFiles(join(dir, "sessions")).map(finalText).join("\n"));
	const q = quality(task, dir);
	const result = { task, atom, form, run, order, status, wall: (Date.now() - started) / 1000, cost: runCost(dir), quality: q, ...effort(join(dir, "sessions")) };
	writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
	console.log(runId(task, atom, run, form), status, result.wall.toFixed(0) + "s", "$" + result.cost.toFixed(3), q);
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

/** $EVAL_DIR 下全部评测运行（worker、runs、prelim）已落盘的花费。 */
function allRunCosts(): number[] {
	const found: number[] = [];
	const walk = (dir: string, depth: number) => {
		if (!existsSync(dir) || depth > 4) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "repo" || entry.name === "sessions" || entry.name === "tmp") continue;
			if (entry.isFile() && entry.name === "result.json") found.push(JSON.parse(readFileSync(join(dir, entry.name), "utf8")).cost ?? 0);
			else if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
		}
	};
	for (const sub of ["worker", "runs", "prelim"]) walk(join(WORK, sub), 0);
	return found;
}

function readResults(): Array<{ r: any; dir: string }> {
	return (existsSync(OUT) ? readdirSync(OUT).sort() : []).flatMap((name) => {
		const file = join(OUT, name, "result.json");
		return existsSync(file) ? [{ r: JSON.parse(readFileSync(file, "utf8")), dir: join(OUT, name) }] : [];
	});
}

function report(json: boolean): void {
	const rows = readResults().map(({ r }) => ({ ...r, form: r.form ?? "" }));
	if (json) return console.log(JSON.stringify(rows, null, 1));
	console.log("任务 | 形态 | 原子 | 每次：质量 墙钟 花费 回合 顶层调用+嵌套调用 输出/总token 失败(顶层+嵌套)（审计质量 = 指到植入缺陷 ±5 行的个数，漏指行号的须人读）");
	const cells = new Map<string, string[]>();
	for (const x of rows) {
		const key = [x.task, x.form, x.atom].join(" | ");
		const cell = [x.quality, x.wall.toFixed(0) + "s", "$" + x.cost.toFixed(3), x.rounds + "回合", x.calls + "+" + x.nested + "调用", (x.output / 1000).toFixed(1) + "k/" + (x.total / 1000).toFixed(0) + "k", "失败" + x.failTop + "+" + x.failNested, x.status === "ok" ? "" : x.status];
		cells.set(key, [...(cells.get(key) ?? []), cell.join(" ").trim()]);
	}
	for (const [key, runs] of cells) console.log(key + " | " + runs.join(" ; "));
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { tasks: { type: "string", default: "audit,research,wait,impl" }, runs: { type: "string", default: "2" }, conc: { type: "string", default: "8" }, forms: { type: "string" }, budget: { type: "string" }, seed: { type: "string", default: "firecode-forms" }, json: { type: "boolean" } } });
if (positionals[0] === "report") {
	report(values.json ?? false);
} else {
	const atoms = parseList(positionals[0]);
	if (!atoms?.length) throw new Error("用法见文件头注释");
	const wanted = parseList(values.tasks)!;
	const forms: Array<string | undefined> = parseList(values.forms) ?? [undefined];
	for (const form of forms) if (form && !TOOL_FORMS[form]) throw new Error("未知形态：" + form);
	for (const form of forms) setupAgent(form);
	fixtureDir("t9");
	fixtureDir("base");
	hostModules();
	// 预算按 $EVAL_DIR 下全部已落盘运行（worker、runs、prelim）的花费，加在飞运行按已落盘均价估算；超了不再起新运行。
	const budget = values.budget ? Number(values.budget) : Infinity;
	let inflight = 0;
	let stopped = false;
	const overBudget = (): boolean => {
		const costs = allRunCosts();
		const spent = costs.reduce((s, c) => s + c, 0);
		const over = spent + inflight * (costs.length ? spent / costs.length : 0) >= budget;
		if (over && !stopped) console.log("预算 $" + budget + " 已用 $" + spent.toFixed(2) + "（在飞 " + inflight + "），停止起新运行");
		return over;
	};
	// 一组 = 同一轮、同一任务、同一原子：各形态各跑一次，组内顺序按固定种子洗牌（消掉时间漂移与缓存先后）；不同组之间并发。
	const groups: Array<() => Promise<void>> = [];
	for (let run = 1; run <= Number(values.runs); run++)
		for (const [task, spec] of Object.entries(TASKS))
			if (wanted.includes(spec.group) || wanted.includes(task))
				for (const atom of atoms)
					groups.push(async () => {
						for (const [order, form] of seededShuffle(forms, [values.seed, task, atom, run].join("|")).entries()) {
							if (stopped || (stopped = overBudget())) return;
							inflight++;
							try {
								await runOne(task, atom, run, form, order);
							} finally {
								inflight--;
							}
						}
					});
	await pool(groups, Number(values.conc));
	report(false);
}
