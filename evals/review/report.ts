#!/usr/bin/env bun
// 汇总：按（批次, 审查模型）出一张表，可按集合过滤。
//   bun report.ts <label[,label…]> [--set opt|hold|all] [--runs N] [--union 模型a,模型b]
//   --runs N 只取每个（用例, 审查模型）的前 N 次运行，让运行次数不同的批次用同一分母比较。
//   --union 把同一批次、同一用例、同一运行序号的两个审查模型合成一个双席位（发现取并集，墙钟取慢者，花费相加），离线估两席位的收益。
// 口径（阻塞发现 = FAIL 票里“发现”小节，建议区不计）：
//   命中率 = 被阻塞发现对上的真值数 / 缺陷用例的真值总数（每次运行分别计，再合计）；建议区 = 只出现在建议区的真值。
//   误报率 = 判为不成立的阻塞发现 / 全部阻塞发现；吹毛求疵率 = 类别不属于 bug、requirement、convention 的阻塞发现 / 全部阻塞发现；
//   需求质疑 = 类别 questionable 的阻塞发现（该交用户裁决，不该逼执行模型修）；陷阱 = 把已知陷阱当阻塞项的次数。
//   对照 FAIL = 无已知缺陷用例上判 FAIL 的比例（不等于误报）；缺陷判过 = 缺陷用例上判 PASS 的比例。
//   单轮墙钟 = 发出 /fire-review 到第 1 轮落下轮记录；花费与 token 只计经计量代理的请求。
//   修复模式另报：轮数、总墙钟、总花费、终态分布，后续轮需逐轮代码快照人工核实，本脚本不推定不必要修复轮。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseList } from "../delegation/lib.ts";
import { caseById } from "./cases.ts";
import type { Finding, RoundJudgement } from "./judge.ts";
import { WORK } from "./lib.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { set: { type: "string", default: "all" }, threshold: { type: "string" }, cases: { type: "string" }, runs: { type: "string" }, union: { type: "string" } } });
const maxRun = values.runs ? Number(values.runs) : Infinity;
const union = parseList(values.union);
/** --threshold 20,8：按分数重算哪些发现阻塞（扫描门槛用）；没有分数的旧契约发现照原样。 */
const threshold = values.threshold?.split(",").map(Number);
const onlyCases = parseList(values.cases);
const isBlocking = (finding: Finding) =>
	threshold && finding.frequency !== undefined && finding.impact !== undefined
		? finding.frequency * finding.impact >= threshold[0]! || (finding.frequency >= 1 && finding.impact >= threshold[1]!)
		: finding.blocking !== false;
const labels = parseList(positionals[0]);
if (!labels?.length) throw new Error("用法见文件头注释");

interface Run {
	label: string;
	case: string;
	reviewer: string;
	run: number;
	mode: string;
	status: string;
	wallSec: number;
	totalSec: number;
	cost: number;
	tokens: number;
	meterComplete?: boolean;
	/** 有一次请求超过 STALL_MS 且出字极慢：网关或上游卡住，墙钟不代表模型速度，统计墙钟时剔除并单列。 */
	stalled: boolean;
	rounds: Array<{ round: number; result: string }>;
	end?: string;
	judged?: RoundJudgement[];
}

const STALL_MS = 90_000;
const STALL_RATE = 20;
const runs: Run[] = [];
for (const label of labels) {
	const root = join(WORK, "runs", label);
	for (const name of existsSync(root) ? readdirSync(root) : []) {
		const file = join(root, name, "result.json");
		if (!existsSync(file)) continue;
		const result = JSON.parse(readFileSync(file, "utf8"));
		if (values.set !== "all" && result.set !== values.set) continue;
		if (onlyCases && !onlyCases.includes(result.case)) continue;
		if (result.run > maxRun) continue;
		const judge = join(root, name, "judge.json");
		const tokens = Object.values(result.usage as Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>)
			.reduce((sum, row) => sum + row.input + row.output + row.cacheRead + row.cacheWrite, 0);
		const requests = existsSync(join(root, name, "usage.jsonl")) ? readFileSync(join(root, name, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		const stalled = requests.some((request: { start: number; end: number; usage?: { output: number } }) =>
			request.end - request.start > STALL_MS && (request.usage?.output ?? 0) / ((request.end - request.start) / 1000) < STALL_RATE);
		runs.push({ ...result, label, tokens, stalled, judged: existsSync(judge) ? JSON.parse(readFileSync(judge, "utf8")).rounds : undefined });
	}
}

const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(0)}%` : "-");
const median = (values: number[]) => {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
};
const p90 = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1)]! : 0);
const NITPICK = new Set(["verification", "nitpick", "questionable"]);

if (union) {
	const [a, b] = union;
	for (const run of runs.filter((entry) => entry.reviewer === a)) {
		const other = runs.find((entry) => entry.reviewer === b && entry.label === run.label && entry.case === run.case && entry.run === run.run);
		if (!other) continue;
		const mine = run.judged?.find((round) => round.round === 1);
		const theirs = other.judged?.find((round) => round.round === 1);
		const judged = mine && theirs ? [{
			round: 1, findings: [...mine.findings, ...theirs.findings], suggested: [...mine.suggested, ...theirs.suggested],
			decided: [...(mine.decided ?? []), ...(theirs.decided ?? [])],
		}] : undefined;
		runs.push({
			...run, reviewer: `${a}+${b}`, status: run.status === "done" && other.status === "done" ? "done" : "partial", wallSec: Math.max(run.wallSec, other.wallSec),
			cost: run.cost + other.cost, tokens: run.tokens + other.tokens, stalled: run.stalled || other.stalled, meterComplete: run.meterComplete && other.meterComplete, judged,
			rounds: [{ round: 1, result: run.rounds[0]?.result === "failed" || other.rounds[0]?.result === "failed" ? "failed" : "passed" }],
		});
	}
}

const groups = new Map<string, Run[]>();
for (const run of runs) groups.set(`${run.label} | ${run.reviewer}`, [...(groups.get(`${run.label} | ${run.reviewer}`) ?? []), run]);

console.log(`集合：${values.set}`);
console.log("批次 | 审查模型 | 运行 | 命中率（建议区） | bug/需求/约定 | 阻塞发现 | 误报率 | 吹毛求疵率 | 需求质疑 | 陷阱 | 裁决交用户 | 对照 FAIL | 缺陷判过 | 单轮墙钟 中位/P90 | 每次花费 | 每次 token | 未判/未定发现 | 计量不完整");
console.log("--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---");
for (const [key, group] of groups) {
	const done = group.filter((run) => run.status === "done");
	let truths = 0;
	let hit = 0;
	let suggested = 0;
	const byKind: Record<string, [number, number]> = { bug: [0, 0], requirement: [0, 0], convention: [0, 0] };
	let blocking = 0;
	let invalid = 0;
	let nit = 0;
	let questionable = 0;
	let traps = 0;
	let trapRuns = 0;
	let decided = 0;
	let unjudged = 0;
	let unsure = 0;
	let cleanRuns = 0;
	let cleanFail = 0;
	let defectRuns = 0;
	let defectPass = 0;
	for (const run of done) {
		const item = caseById(run.case);
		const first = run.judged?.find((round) => round.round === 1);
		if (!run.judged) unjudged += 1;
		const judgedFirst = run.judged?.find((round) => round.round === 1);
		const verdict = judgedFirst ? (judgedFirst.findings.some(isBlocking) ? "failed" : "passed") : run.rounds[0]?.result;
		if (item.truth.length) {
			defectRuns += 1;
			if (verdict === "passed") defectPass += 1;
		} else {
			cleanRuns += 1;
			if (verdict === "failed") cleanFail += 1;
		}
		if (!first) continue;
		const block = first.findings.filter(isBlocking);
		const matched = new Set(block.filter((finding) => finding.valid === "yes").map((finding) => finding.truth).filter(Boolean));
		const below = new Set(first.findings.filter((finding) => !isBlocking(finding) && finding.valid === "yes").map((finding) => finding.truth).filter(Boolean));
		if (item.traps?.length) {
			trapRuns += 1;
			if (item.traps.some((trap) => first.decided?.includes(trap.id))) decided += 1;
		}
		for (const defect of item.truth) {
			truths += 1;
			byKind[defect.kind]![1] += 1;
			if (matched.has(defect.id)) {
				hit += 1;
				byKind[defect.kind]![0] += 1;
			} else if (below.has(defect.id) || first.suggested.includes(defect.id)) suggested += 1;
		}
		for (const finding of block) {
			blocking += 1;
			if (finding.valid === "unsure") unsure += 1;
			if (finding.valid === "no") invalid += 1;
			if (NITPICK.has(finding.category)) nit += 1;
			if (finding.category === "questionable") questionable += 1;
			if (finding.trap) traps += 1;
		}
	}
	const wall = done.filter((run) => !run.stalled).map((run) => run.wallSec);
	const kinds = ["bug", "requirement", "convention"].map((kind) => pct(byKind[kind]![0], byKind[kind]![1])).join("/");
	console.log([
		key, `${done.length}/${group.length}`, `${hit}/${truths} ${pct(hit, truths)}（${suggested}）`, kinds, blocking, `${invalid}/${blocking} ${pct(invalid, blocking)}`, `${nit}/${blocking} ${pct(nit, blocking)}`, questionable, traps,
		`${decided}/${trapRuns}`, pct(cleanFail, cleanRuns), pct(defectPass, defectRuns), `${median(wall).toFixed(0)}s/${p90(wall).toFixed(0)}s（剔除停顿 ${done.length - wall.length}）`,
		`$${(done.reduce((sum, run) => sum + run.cost, 0) / (done.length || 1)).toFixed(3)}`,
		`${Math.round(done.reduce((sum, run) => sum + run.tokens, 0) / (done.length || 1) / 1000)}k`, `${unjudged}/${unsure}`, done.filter((run) => run.meterComplete !== true).length,
	].join(" | "));
}

const loops = runs.filter((run) => run.mode === "loop" && run.status === "done");
if (loops.length) {
	console.log("\n修复模式：批次 | 审查模型 | 用例 | 终态 | 轮数 | 总墙钟 | 总花费");
	for (const run of loops) {
		console.log([run.label, run.reviewer, run.case, run.end ?? "-", run.rounds.length, `${(run.totalSec / 60).toFixed(1)}min`, `$${run.cost.toFixed(2)}`].join(" | "));
	}
}
