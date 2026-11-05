#!/usr/bin/env bun
// 工具形态评测的区组报告：逐 区组 × 任务 × 形态 的表，以及按轮配对（以 only 为基线）的差值中位数与范围。
//   bun forms-report.ts
// 区组 = 模型原子（指挥官题的区组按其变体 cmd-* 所用的 settings 模型）。差异不足 15%、或配对差值的范围跨过 0，一律记“无差异”。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORK } from "./lib.ts";

const FORMS = ["only", "on", "off"];
const NOISE = 0.15;
const METRICS: Array<[string, (r: any) => number]> = [
	["墙钟s", (r) => r.wall ?? r.wallSec],
	["总token", (r) => r.total],
	["输出token", (r) => r.output],
	["回合", (r) => r.rounds],
	["花费$", (r) => r.cost],
	["工具失败", (r) => r.failTop + r.failNested],
];
// 对比：[名称, 实验形态, 基线形态]
const CONTRASTS: Array<[string, string, string]> = [
	["on−only（原生工具露在顶层）", "on", "only"],
	["off−on（有无 codemode）", "off", "on"],
	["off−only", "off", "only"],
];

interface Row { block: string; task: string; form: string; run: number; r: any }
const rows: Row[] = [];
const worker = join(WORK, "worker");
for (const name of existsSync(worker) ? readdirSync(worker) : []) {
	const file = join(worker, name, "result.json");
	if (!existsSync(file)) continue;
	const r = JSON.parse(readFileSync(file, "utf8"));
	if (r.form) rows.push({ block: r.atom.split("/").slice(-2, -1)[0]!, task: r.task, form: r.form, run: r.run, r });
}
const runs = join(WORK, "runs");
for (const variant of existsSync(runs) ? readdirSync(runs).filter((v) => v.startsWith("cmd-")) : []) {
	for (const dir of readdirSync(join(runs, variant))) {
		const file = join(runs, variant, dir, "result.json");
		if (!existsSync(file)) continue;
		const r = JSON.parse(readFileSync(file, "utf8"));
		if (r.status === "settled") rows.push({ block: "opus5.5-commander", task: r.task, form: variant.slice(4), run: r.run, r });
	}
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
const pass = (q: string) => { const m = /^(\d+)\/(\d+)/.exec(q ?? ""); return m ? [Number(m[1]), Number(m[2])] as const : [0, 1] as const; };
const out: string[] = [];
const say = (s = "") => out.push(s);

for (const block of [...new Set(rows.map((x) => x.block))]) {
	for (const task of [...new Set(rows.filter((x) => x.block === block).map((x) => x.task))]) {
		const cell = rows.filter((x) => x.block === block && x.task === task);
		say(`\n### ${block} · ${task}\n`);
		say("| 形态 | n | 验收满分次数 | 质量(分子和/分母和) | " + METRICS.map(([n]) => n + " 中位［范围］").join(" | ") + " |");
		say("|---|---|---|---|" + METRICS.map(() => "---").join("|") + "|");
		for (const form of FORMS) {
			const g = cell.filter((x) => x.form === form);
			if (!g.length) continue;
			const qs = g.map((x) => pass(x.r.quality));
			const full = qs.filter(([a, b]) => a === b).length;
			say(`| ${form} | ${g.length} | ${full}/${g.length} | ${qs.reduce((s, [a]) => s + a, 0)}/${qs.reduce((s, [, b]) => s + b, 0)} | ` + METRICS.map(([, f]) => { const v = g.map((x) => f(x.r)); return `${fmt(median(v))}［${fmt(Math.min(...v))}–${fmt(Math.max(...v))}］`; }).join(" | ") + " |");
		}
		say();
		say("配对差值（按轮；过程量为相对变化，工具失败为绝对差），结论列：有差/无差异");
		say("| 对比 | 对数 | " + METRICS.map(([n]) => n).join(" | ") + " |");
		say("|---|---|" + METRICS.map(() => "---").join("|") + "|");
		for (const [name, a, b] of CONTRASTS) {
			const pairs = [...new Set(cell.map((x) => x.run))].flatMap((run) => { const x = cell.find((c) => c.run === run && c.form === a), y = cell.find((c) => c.run === run && c.form === b); return x && y ? [[x.r, y.r]] : []; });
			if (!pairs.length) continue;
			say(`| ${name} | ${pairs.length} | ` + METRICS.map(([m, f]) => {
				const abs = m === "工具失败";
				const deltas = pairs.map(([x, y]) => (abs ? f(x) - f(y) : f(y) === 0 ? 0 : (f(x) - f(y)) / f(y)));
				const med = median(deltas);
				const real = abs ? false : Math.abs(med) >= NOISE && (Math.min(...deltas) > 0 || Math.max(...deltas) < 0);
				const show = abs ? med.toFixed(1) : (med * 100).toFixed(0) + "%";
				const range = abs ? `${Math.min(...deltas)}…${Math.max(...deltas)}` : `${(Math.min(...deltas) * 100).toFixed(0)}…${(Math.max(...deltas) * 100).toFixed(0)}%`;
				return `${show}［${range}］${abs ? "" : real ? " **有差**" : " 无差异"}`;
			}).join(" | ") + " |");
		}
	}
}
console.log(out.join("\n"));
