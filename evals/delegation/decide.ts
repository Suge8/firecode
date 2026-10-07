#!/usr/bin/env bun
// 首步决策（probe）：主会话面对任务，是亲手、委派还是并行委派。到第一次 subagents start（被探针拦截，不真起 Worker）、
// --steps 个工具步内未委派（判亲手）、agent_end 或超时即止。
//   bun decide.ts <变体> [--tasks t1-oneline,t2-qa] [--runs 2] [--concurrency 4] [--steps 5] [--timeout 300] [--force]
//   bun decide.ts report <变体>      只汇总已有结果
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixtureDir } from "./fixtures.ts";
import { killTree, onJsonLines, parseList, pool, prepareRun, readJsonl, runCost, startPi, WORK } from "./lib.ts";
import { TASKS, taskById, type Task } from "./tasks.ts";

interface Start {
	worker?: string;
	role?: string;
	promptChars: number;
}
interface Decision {
	task: string;
	run: number;
	starts: Start[];
	reason: string;
	decisionSec: number;
	cost: number;
}

const probeStarts = (probePath: string) =>
	existsSync(probePath) ? readJsonl(probePath).filter((r) => r.tool === "subagents" && r.args?.action === "start") : [];

function runOne(task: Task, variant: string, run: number, o: { steps: number; timeoutSec: number }): Promise<Decision> {
	const dir = join(WORK, "probe", variant, `${task.id}-${run}`);
	const { repo, tmp } = prepareRun(dir, fixtureDir(task.fixture));
	const probePath = join(dir, "probe.jsonl");
	const child = startPi(["--mode", "json", "--session-dir", join(dir, "sessions"), "-e", join(import.meta.dir, "probe.ts"), task.prompt], {
		variant, cwd: repo, tmp, stdin: "ignore", env: { EVAL_LOG: probePath },
	});
	const t0 = Date.now();
	let tAgent = 0;
	let steps = 0;
	let reason = "";
	const finish = (why: string) => {
		if (reason) return;
		reason = why;
		clearTimeout(timer);
		killTree(child);
	};
	const timer = setTimeout(() => finish("timeout"), o.timeoutSec * 1000);
	onJsonLines(child, (event) => {
		if (event.type === "agent_start" && !tAgent) tAgent = Date.now();
		if (event.type === "message_end" && event.message?.stopReason === "error") finish("error: " + (event.message.errorMessage ?? "assistant error"));
		if (event.type === "tool_execution_end") {
			steps++;
			if (probeStarts(probePath).length) finish("subagents-start");
			else if (steps >= o.steps) finish("steps");
		}
		if (event.type === "agent_end") finish("agent_end");
	});
	return new Promise((resolve) => {
		child.on("close", (code) => {
			finish("exit " + code);
			const starts = probeStarts(probePath);
			const result: Decision = {
				task: task.id, run, reason,
				starts: starts.map((r) => ({ worker: r.args.worker, role: r.args.role, promptChars: String(r.args.prompt ?? "").length })),
				decisionSec: ((starts[0]?.t ?? Date.now()) - (tAgent || t0)) / 1000,
				cost: runCost(dir),
			};
			writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
			resolve(result);
		});
	});
}

function verdict(task: Task, r: Decision): boolean {
	const ideal = task.ideal!;
	if (r.reason.startsWith("error")) return false;
	if (ideal.mode === "hand") return !r.starts.length;
	if (r.starts.length < (ideal.mode === "parallel" ? 2 : 1)) return false;
	return !ideal.roles || r.starts.some((s) => ideal.roles!.includes(s.role ?? ""));
}

function cell(task: Task, r: Decision | undefined): string {
	if (!r) return "—";
	const roles = [...new Set(r.starts.map((s) => s.role))].join("/");
	const what = r.starts.length ? `委派×${r.starts.length} ${roles}` : r.reason === "agent_end" ? "亲手（做完）" : "亲手†";
	return `${verdict(task, r) ? "✓" : "✗"} ${what}<br>${r.decisionSec.toFixed(0)}s · $${r.cost.toFixed(2)}`;
}

function report(variant: string): void {
	const base = join(WORK, "probe", variant);
	const results: Decision[] = (existsSync(base) ? readdirSync(base) : [])
		.map((name) => join(base, name, "result.json"))
		.filter(existsSync)
		.map((p) => JSON.parse(readFileSync(p, "utf8")));
	const maxRuns = Math.max(0, ...results.map((r) => r.run));
	console.log(`| 任务 | 理想 | ${Array.from({ length: maxRuns }, (_, i) => `#${i + 1}`).join(" | ")} | 符合 |\n|---|---|${"---|".repeat(maxRuns + 1)}`);
	let ok = 0;
	let total = 0;
	for (const task of TASKS.filter((t) => t.ideal && results.some((r) => r.task === t.id))) {
		const rs = results.filter((r) => r.task === task.id).sort((a, b) => a.run - b.run);
		const good = rs.filter((r) => verdict(task, r)).length;
		ok += good;
		total += rs.length;
		const ideal = { hand: "亲手", delegate: "委派", parallel: "并行委派" }[task.ideal!.mode] + (task.ideal!.roles ? `（${task.ideal!.roles.join("/")}）` : "");
		const cells = Array.from({ length: maxRuns }, (_, i) => cell(task, rs.find((r) => r.run === i + 1)));
		console.log(`| ${task.id} ${task.kind} | ${ideal} | ${cells.join(" | ")} | ${good}/${rs.length} |`);
	}
	console.log(`\n符合 ${ok}/${total}。† = 在步数/超时截止点仍在亲手，数字是截断值，不是完成成本。`);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		tasks: { type: "string" }, runs: { type: "string", default: "2" }, concurrency: { type: "string", default: "4" },
		steps: { type: "string", default: "5" }, timeout: { type: "string", default: "300" }, force: { type: "boolean" },
	},
});
const reportOnly = positionals[0] === "report";
const variant = positionals[reportOnly ? 1 : 0];
if (!variant || !existsSync(join(WORK, "variants", variant))) throw new Error(`变体 ${variant} 不存在，先 bun variant.ts ${variant}`);
if (!reportOnly) {
	const wanted = (parseList(values.tasks) ?? TASKS.filter((t) => t.ideal).map((t) => t.id)).map(taskById);
	const jobs: Array<() => Promise<void>> = [];
	for (const task of wanted) {
		for (let run = 1; run <= Number(values.runs); run++) {
			const done = join(WORK, "probe", variant, `${task.id}-${run}`, "result.json");
			if (!values.force && existsSync(done) && !JSON.parse(readFileSync(done, "utf8")).reason.startsWith("error")) continue;
			jobs.push(async () => {
				const r = await runOne(task, variant, run, { steps: Number(values.steps), timeoutSec: Number(values.timeout) });
				console.error(`${task.id}#${run} ${r.starts.length ? "委派×" + r.starts.length : "亲手"} ${r.reason} $${r.cost.toFixed(2)}`);
			});
		}
	}
	await pool(jobs, Number(values.concurrency));
}
report(variant);
