#!/usr/bin/env bun
// 盲评导出：把 t3/t7/t9 的最终报告去标识、打乱编号写到 <工作目录>/blind/{X,Y,Z}n.md（X=t3、Y=t7、Z=t9）。
// 编号到变体与运行的映射写在 <工作目录>/blind-map.json——打完分之前不要打开它。
//   bun blind.ts [变体,变体…] [--force]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { finalText, parseList, WORK } from "./lib.ts";

const PREFIX: Record<string, string> = { "t3-research": "X", "t7-audit": "Y", "t9-big": "Z", "t9-hand": "Z" };
/** t3/t7 的报告常夹着“我派了 N 个调研员”之类泄露分组的叙述；表格行之外的这类行去掉。 */
const LEAK = /调研员|Worker|worker|子代理|并行派|派了|派出|三路|分给|亲手|我自己|自己查/;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { force: { type: "boolean" } } });
const out = join(WORK, "blind");
if (existsSync(out) && !values.force) throw new Error(`${out} 已存在；重新导出会打乱编号，确认要重来再加 --force`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const runsRoot = join(WORK, "runs");
const variants = parseList(positionals[0]) ?? readdirSync(runsRoot);
const dirs = variants.flatMap((v) => readdirSync(join(runsRoot, v)).map((d) => join(runsRoot, v, d))).filter((d) => existsSync(join(d, "result.json")));
const shuffled = dirs.map((d) => ({ d, r: Math.random() })).sort((a, b) => a.r - b.r).map((x) => x.d);

const counters: Record<string, number> = {};
const map: Record<string, string> = {};
for (const dir of shuffled) {
	const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
	const prefix = PREFIX[result.task];
	if (!prefix || result.status !== "settled") continue;
	let text = finalText(result.sessionFile);
	if (prefix !== "Z") text = text.split("\n").filter((line) => line.includes("|") || !LEAK.test(line)).join("\n");
	const id = prefix + (counters[prefix] = (counters[prefix] ?? 0) + 1);
	writeFileSync(join(out, id + ".md"), text);
	map[id] = `${result.variant}/${result.task}-${result.run}`;
}
writeFileSync(join(WORK, "blind-map.json"), JSON.stringify(map, null, 1));
console.log(`导出 ${Object.keys(map).length} 份到 ${out}`);
