#!/usr/bin/env bun
// 跑到完成：pi --mode rpc 保持进程，发一条请求，等主会话与全部 Worker 都歇下（主会话出现 firecode-round）。
//   bun run.ts <变体[,变体…]> [--tasks t3-research,t7-audit,t9-big] [--runs 3] [--concurrency 2]
//                [--budget 30] [--force]
// 作业按“第几次 → 任务 → 变体”交错排队，变体之间尽量同批。serial 任务（t3/t7）走单独一条串行通道，
// 与其它任务并行，所以总并发 = --concurrency + 1。--budget 是本次调用的美元上限：超过即杀掉所有在跑的并停止排队，
// 已完成的结果保留，重跑会续上。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixtureDir } from "./fixtures.ts";
import { killTree, onJsonLines, parseList, pool, prepareRun, readJsonl, runCost, startPi, WORK } from "./lib.ts";
import { taskById, type Task } from "./tasks.ts";

const POLL_MS = 1000;
const BUDGET_CHECK_MS = 15_000;
const TAIL_MS = 2500;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		tasks: { type: "string", default: "t3-research,t7-audit,t9-big" }, runs: { type: "string", default: "3" }, concurrency: { type: "string", default: "2" },
		budget: { type: "string" }, force: { type: "boolean" },
	},
});
const variants = parseList(positionals[0]);
if (!variants?.length) throw new Error("用法见文件头注释");
for (const v of variants) if (!existsSync(join(WORK, "variants", v))) throw new Error(`变体 ${v} 不存在，先 bun variant.ts ${v}`);

let stopped = false;
let finishedCost = 0;
const live = new Map<string, string>();
let spentCache = { at: 0, value: 0 };
function spent(): number {
	if (Date.now() - spentCache.at > BUDGET_CHECK_MS) {
		const running = [...live.values()].reduce((sum, dir) => sum + runCost(dir), 0);
		spentCache = { at: Date.now(), value: finishedCost + running };
	}
	return spentCache.value;
}

const hasRound = (sessionFile: string) => existsSync(sessionFile) && readJsonl(sessionFile).some((e) => e.customType === "firecode-round");

async function runOne(task: Task, variant: string, run: number): Promise<void> {
	const id = `${variant}/${task.id}-${run}`;
	const dir = join(WORK, "runs", variant, `${task.id}-${run}`);
	const { repo, tmp } = prepareRun(dir, fixtureDir(task.fixture));
	const child = startPi(["--mode", "rpc", "--session-dir", join(dir, "sessions")], { variant, cwd: repo, tmp, stdin: "pipe" });
	child.stderr!.on("data", (chunk: Buffer) => appendFileSync(join(dir, "stderr.txt"), chunk));
	let sessionFile = "";
	const agentStarts: number[] = [];
	const agentEnds: number[] = [];
	let ready: () => void = () => {};
	const stateKnown = new Promise<void>((resolve) => (ready = resolve));
	onJsonLines(child, (event) => {
		if (event.type === "response" && event.command === "get_state") {
			sessionFile = event.data?.sessionFile ?? "";
			ready();
		}
		if (event.type === "agent_start") agentStarts.push(Date.now());
		if (event.type === "agent_end") agentEnds.push(Date.now());
	});
	child.stdin!.write(JSON.stringify({ id: "s", type: "get_state" }) + "\n");
	await stateKnown;
	const tSend = Date.now();
	child.stdin!.write(JSON.stringify({ id: "p", type: "prompt", message: task.prompt }) + "\n");
	live.set(id, dir);

	// 歇下没有事件可订阅（轮记录是写进会话文件的），只能轮询会话文件。
	let status = "timeout";
	const deadline = tSend + task.timeoutSec! * 1000;
	while (Date.now() < deadline) {
		await Bun.sleep(POLL_MS);
		if (stopped || (values.budget && spent() > Number(values.budget))) {
			stopped = true;
			status = "stopped";
			break;
		}
		if (agentEnds.length && hasRound(sessionFile)) {
			status = "settled";
			break;
		}
		if (child.exitCode !== null) {
			status = "exited";
			break;
		}
	}
	await Bun.sleep(TAIL_MS);
	killTree(child);
	live.delete(id);
	const cost = runCost(dir);
	finishedCost += cost;
	spentCache.at = 0;
	const sec = (t: number) => (t - tSend) / 1000;
	const result = { variant, task: task.id, run, status, sessionFile, tSend, wallSec: sec(agentEnds.at(-1) ?? Date.now()), agentStartsSec: agentStarts.map(sec), agentEndsSec: agentEnds.map(sec), cost };
	writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
	console.log(`${id} ${status} 墙钟 ${result.wallSec.toFixed(0)}s $${cost.toFixed(2)}（本次累计 $${(finishedCost).toFixed(2)}）`);
}

const settledBefore = (variant: string, task: Task, run: number) => {
	const file = join(WORK, "runs", variant, `${task.id}-${run}`, "result.json");
	return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).status === "settled";
};

const serial: Array<() => Promise<void>> = [];
const parallel: Array<() => Promise<void>> = [];
for (let run = 1; run <= Number(values.runs); run++) {
	for (const task of parseList(values.tasks)!.map(taskById)) {
		if (!task.timeoutSec) throw new Error(`${task.id} 没有 timeoutSec，不能跑到完成`);
		for (const variant of variants) {
			if (!values.force && settledBefore(variant, task, run)) continue;
			(task.serial ? serial : parallel).push(async () => {
				if (!stopped) await runOne(task, variant, run);
			});
		}
	}
}
await Promise.all([pool(serial, 1), pool(parallel, Number(values.concurrency))]);
if (stopped) console.log("已因预算上限停止；未完成的运行标为 stopped，重跑会续上。");
