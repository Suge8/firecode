#!/usr/bin/env bun
// 跑审查：每个（用例, 审查模型, 第几次）一份独立的仓库副本、合成会话与 Agent 目录，用 pi --mode rpc 发 /fire-review。
//   bun run.ts --models gpt-6.1-terra/low,claude-sonnet-5-5/low [--cases opt|hold|all|id,id] [--runs 1]
//              [--mode detect|loop] [--code HEAD] [--label 名] [--executor 原子] [--advisor 原子]
//              [--concurrency 3] [--budget 20] [--force]
// detect：只跑第 1 轮，落下轮记录即停（命中、误报、单轮耗时与花费）。
// loop：完整修复循环（maxRounds 5，顾问照常），执行模型按审查反馈真改代码，等审查落定（轮数、总耗时、总花费、终态代码）。
// 被测代码取 --code 指向的已提交内容；结果在 $EVAL_DIR/runs/<label>/<用例>__<模型>__<次>/。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseJsonc } from "../../jsonc.ts";
import { killTree, onJsonLines, parseList, pool, readJsonl, REPO, startPi, USER_AGENT_DIR } from "../delegation/lib.ts";
import { type Case, selectCases } from "./cases.ts";
import { copyRepo, fixtureKey, fixtureRepo, writeSession } from "./fixture.ts";
import { fixtureHost, git, physical, quotaBlock, quotaSnapshot, USER_MODELS, WORK } from "./lib.ts";
import { type Request, startMeter } from "./meter.ts";

const MINUTE = 60_000;
const DETECT_EXECUTOR = { provider: "review-eval-executor", model: "executor", thinking: "off" };
/** 认证文件链回用户目录；模型 API key 经环境变量传入，不落入生成的配置。 */
const LINKED = ["auth.json", "models-store.json"];

const { values } = parseArgs({
	options: {
		models: { type: "string" },
		cases: { type: "string", default: "opt" },
		runs: { type: "string", default: "1" },
		mode: { type: "string", default: "detect" },
		code: { type: "string", default: "HEAD" },
		label: { type: "string" },
		executor: { type: "string", default: "claude-sonnet-5-5/medium" },
		advisor: { type: "string", default: "claude-opus-5-5/high" },
		concurrency: { type: "string", default: "3" },
		budget: { type: "string" },
		force: { type: "boolean" },
	},
});
const models = parseList(values.models);
if (!models?.length) throw new Error("用法见文件头注释");
if (!["detect", "loop"].includes(values.mode!)) throw new Error("mode 只能是 detect 或 loop");
for (const key of ["runs", "concurrency"] as const)
	if (!Number.isInteger(Number(values[key])) || Number(values[key]) < 1) throw new Error(`${key} 必须是正整数`);
if (values.budget && !(Number(values.budget) > 0)) throw new Error("budget 必须大于 0");
const mode = values.mode!;
const initialBlock = await quotaBlock([...models, ...(mode === "loop" ? [values.executor!, values.advisor!] : [])].map((atom) => physical(atom).model));
if (initialBlock) throw new Error(`停止付费评测：${initialBlock}`);
const code = git(REPO, "rev-parse", values.code!).trim();
const label = values.label ?? `${code.slice(0, 7)}-${mode}`;
if (!/^[\w.-]+$/u.test(label) || label === "." || label === "..") throw new Error("label 只能含字母、数字、点、连字符与下划线");
const batchRoot = join(WORK, "runs", label);
mkdirSync(batchRoot, { recursive: true });
const lock = join(batchRoot, ".running");
mkdirSync(lock);
const active = new Set<ChildProcess>();
const cleanup = () => { for (const child of active) killTree(child); rmSync(lock, { recursive: true, force: true }); };
process.once("exit", cleanup);
process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));
const cases = selectCases(values.cases!);

const userModels = USER_MODELS;
const baseReview = (parseJsonc(readFileSync(join(USER_AGENT_DIR, "extensions/firecode/config.jsonc"), "utf8")) as Record<string, any>).review;
const modelSignature = Object.fromEntries(Object.entries(userModels.providers).map(([name, entry]) => [name, { api: entry.api, baseUrl: entry.baseUrl, models: entry.models }]));
const meter = startMeter(userModels.providers);

/** 被测代码：按提交归档一份，变体之间共用。 */
function codeDir(): string {
	const dir = join(WORK, "code", code);
	if (existsSync(join(dir, "index.ts"))) return dir;
	mkdirSync(dir, { recursive: true });
	const archived = Bun.spawnSync(["git", "-C", REPO, "archive", code]);
	if (archived.exitCode !== 0) throw new Error(archived.stderr.toString());
	const extracted = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archived.stdout });
	if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString());
	return dir;
}

function writeAgent(agent: string, run: string, reviewer: string): Record<string, string> {
	mkdirSync(join(agent, "extensions/firecode"), { recursive: true });
	for (const file of LINKED) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
	const credentials: Record<string, string> = {};
	const providers = Object.fromEntries(Object.entries(userModels.providers).map(([name, entry], index) => {
		if (!entry.baseUrl) throw new Error(`无法计量内置供应商：${name}`);
		const key = `FIRECODE_EVAL_KEY_${index}`;
		if (entry.apiKey?.startsWith("!")) throw new Error(`评测不执行凭据命令：${name}`);
		if (Object.keys(entry.headers ?? {}).length || entry.models?.some((model: any) => Object.keys(model.headers ?? {}).length))
			throw new Error(`评测尚不转写自定义 headers：${name}`);
		if (entry.apiKey) credentials[key] = process.env[entry.apiKey] ?? entry.apiKey;
		return [name, { ...entry, apiKey: entry.apiKey ? key : undefined, baseUrl: `http://127.0.0.1:${meter.port}/${run}/${name}` }];
	}));
	// 主会话在首轮落盘后可能立即起总结；独立的本地拒绝端点保证 detect 不发任何执行模型请求。
	if (mode === "detect") providers[DETECT_EXECUTOR.provider] = {
		api: "openai-completions", apiKey: "local-eval", baseUrl: `http://127.0.0.1:${meter.port}/blocked`,
		models: [{ id: DETECT_EXECUTOR.model, name: "eval", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
	};
	writeFileSync(join(agent, "models.json"), JSON.stringify({ ...userModels, providers }, null, 1));
	const settings = { quietStartup: true, defaultProjectTrust: "always" };
	const executor = mode === "detect" ? DETECT_EXECUTOR : physical(values.executor!);
	Object.assign(settings, { defaultProvider: executor.provider, defaultModel: executor.model, defaultThinkingLevel: executor.thinking });
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings, null, 1));
	const target = physical(reviewer);
	const config = {
		language: "zh",
		features: Object.fromEntries(["header", "statusbar", "tools", "presets", "stats", "claudeSub", "claudeFiles", "openaiNative", "master", "watcher"].map((key) => [key, false]).concat([["review", true]])),
		review: { ...baseReview, reviewers: [[`${target.provider}/${target.model}/${target.thinking}`]], advisor: [values.advisor], maxRounds: mode === "loop" ? 5 : 1, timeoutMinutes: 30 },
	};
	writeFileSync(join(agent, "extensions/firecode/config.jsonc"), JSON.stringify(config, null, 1));
	writeFileSync(join(agent, "extensions/firecode/index.ts"), 'export { default } from "./source/index.ts";\n');
	symlinkSync(codeDir(), join(agent, "extensions/firecode/source"));
	return credentials;
}

/** 监听真实会话追加与进程退出；超时只作截止线。 */
function watchRun(child: ChildProcess, sessionFile: string, sent: number): Promise<{ status: string; firstRoundAt?: number }> {
	return new Promise((resolve) => {
		let firstRoundAt: number | undefined;
		const finish = (status: string) => {
			watcher.close(); clearTimeout(timer); child.off("exit", exited);
			resolve({ status, firstRoundAt });
		};
		const check = () => {
			const entries = readJsonl(sessionFile);
			if (entries.some((entry) => entry.customType === "firecode-review-refusal")) return finish("refused");
			const first = entries.find((entry) => entry.customType === "firecode-review-round");
			if (firstRoundAt === undefined && first) firstRoundAt = Date.parse(first.timestamp);
			const checkpoint = entries.findLast((entry) => entry.customType === "firecode-review-checkpoint")?.data;
			if (mode === "detect" ? firstRoundAt !== undefined : checkpoint?.phase === "settled") finish("done");
		};
		const exited = () => finish("exited");
		const watcher = watch(sessionFile, check);
		const timer = setTimeout(() => finish("timeout"), sent + (mode === "loop" ? 120 : 35) * MINUTE - Date.now());
		child.once("exit", exited);
		check();
	});
}

const slug = (atom: string) => atom.replace(/[/:]/gu, "_");
let stopped = "";
let spent = 0;

async function runOne(item: Case, reviewer: string, n: number): Promise<void> {
	const id = `${item.id}__${slug(reviewer)}__${n}`;
	const dir = join(WORK, "runs", label, id);
	const recipe = createHash("sha256").update(JSON.stringify({ item: fixtureKey(item), turns: item.turns.map(({ user, checks }) => ({ user, checks })), code, mode, reviewer, executor: values.executor, advisor: values.advisor, baseReview, modelSignature, concurrency: values.concurrency, pi: process.env.PI_PACKAGES_DIR ?? "PATH" }))
		.update(readFileSync(import.meta.path)).update(readFileSync(join(import.meta.dir, "meter.ts"))).digest("hex");
	if (!values.force && existsSync(join(dir, "result.json"))) {
		const previous = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		if (previous.recipe !== recipe) throw new Error(`${id} 的评测输入已变化；另取 label，或 --force 保留旧结果后重跑`);
		if (previous.status === "done") return;
	}
	const block = await quotaBlock([reviewer, ...(mode === "loop" ? [values.executor!, values.advisor!] : [])].map((atom) => physical(atom).model));
	if (block) {
		stopped ||= block;
		for (const running of active) killTree(running);
	}
	if (stopped) return;
	if (existsSync(dir)) {
		const archive = join(WORK, "attempts", label);
		mkdirSync(archive, { recursive: true });
		renameSync(dir, join(archive, `${id}-${Date.now()}`));
	}
	if (item.source === "pi" && !existsSync(join(fixtureRepo(item), "node_modules")))
		throw new Error("先运行 bun evals/review/setup.ts pi，为每份历史仓库安装其锁定依赖");
	const repo = copyRepo(item, join(dir, "repo"));
	const tmp = join(dir, "tmp");
	const agent = join(dir, "agent");
	mkdirSync(tmp, { recursive: true });
	const credentials = writeAgent(agent, id, reviewer);
	const sessionFile = join(dir, "sessions", "session.jsonl");
	writeSession(item, repo, sessionFile, mode === "detect" ? DETECT_EXECUTOR : physical(values.executor!));
	const usageFile = join(dir, "usage.jsonl");
	writeFileSync(usageFile, "");
	meter.attach(id, usageFile);

	const host = item.source === "firecode" ? fixtureHost(repo) : undefined;
	const child = startPi(["--mode", "rpc", "--no-skills", "--no-prompt-templates", "--session", sessionFile], {
		agentDir: agent, cwd: repo, tmp, stdin: "pipe", env: { ...credentials, ...host?.env },
	});
	active.add(child);
	child.once("exit", () => active.delete(child));
	const stderr: Buffer[] = [];
	child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("pi 启动超时")), MINUTE);
		child.once("error", reject);
		child.once("exit", () => { clearTimeout(timeout); reject(new Error("pi 在 get_state 前退出")); });
		onJsonLines(child, (event) => {
			if (event.type === "response" && event.command === "get_state") { clearTimeout(timeout); resolve(); }
		});
		child.stdin!.write(JSON.stringify({ id: "s", type: "get_state" }) + "\n");
	});
	const sent = Date.now();
	const observed = watchRun(child, sessionFile, sent);
	child.stdin!.write(JSON.stringify({ id: "r", type: "prompt", message: "/fire-review" }) + "\n");
	const { status, firstRoundAt } = await observed;
	const finished = Date.now();
	if (active.has(child)) killTree(child);
	await meter.detach(id);
	const entries = readJsonl(sessionFile);
	const requests: Request[] = readJsonl(usageFile);
	const byModel: Record<string, { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; seconds: number }> = {};
	for (const request of requests) {
		const row = (byModel[`${request.provider}/${request.model}`] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, seconds: 0 });
		row.requests += 1;
		row.seconds += (request.end - request.start) / 1000;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) row[key] += request.usage?.[key] ?? 0;
		row.cost += request.cost ?? 0;
	}
	const cost = Object.values(byModel).reduce((sum, row) => sum + row.cost, 0);
	spent += cost;
	const result = {
		case: item.id, set: item.set, reviewer, run: n, code, mode, status, recipe, host: host?.version, evidence: "reconstructed",
		wallSec: ((firstRoundAt ?? Date.now()) - sent) / 1000,
		totalSec: (finished - sent) / 1000,
		rounds: entries.filter((entry) => entry.customType === "firecode-review-round").map((entry) => entry.data.round),
		end: entries.findLast((entry) => entry.customType === "firecode-review-checkpoint")?.data?.end,
		usage: byModel,
		cost,
		meterComplete: requests.length > 0 && requests.every((request) => request.status >= 200 && request.status < 300 && request.usage && request.cost !== undefined),
	};
	writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
	writeFileSync(join(dir, "stderr.txt"), Buffer.concat(stderr));
	const verdict = result.rounds[0]?.result ?? "-";
	console.log(`${id} ${status} ${verdict} ${result.wallSec.toFixed(0)}s $${cost.toFixed(3)}（累计 $${spent.toFixed(2)}）`);
	if (status !== "done") process.exitCode = 1;
	if (!result.meterComplete) stopped ||= "计量不完整，停止派新运行";
	if (values.budget && spent > Number(values.budget)) stopped ||= `花费超过 $${values.budget}`;
}

for (const item of cases) fixtureRepo(item);
const before = await quotaSnapshot();
const jobs: Array<() => Promise<void>> = [];
for (let n = 1; n <= Number(values.runs); n++) for (const item of cases) for (const reviewer of models) jobs.push(() => runOne(item, reviewer, n));
try { await pool(jobs, Number(values.concurrency)); } finally { meter.stop(); cleanup(); }
const after = await quotaSnapshot();
mkdirSync(join(WORK, "runs", label), { recursive: true });
writeFileSync(join(WORK, "runs", label, `batch-${Date.now()}.json`), JSON.stringify({ code, mode, models, cases: cases.map((item) => item.id), spent, before, after, stopped }, null, 1));
console.log(`共 $${spent.toFixed(2)}；额度 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
if (stopped) { console.log(`已停止派新运行：${stopped}`); process.exitCode = 2; }
