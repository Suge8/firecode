#!/usr/bin/env bun
// 报告核对（对象是 blind.ts 导出的报告）。输出只是候选命中，须人读报告后确认：
//   bun check.ts t3 X*.md    表格里的“最新版本 / 最近发布日期”对 npm registry（需联网）
//   bun check.ts t7 Y*.md    对照 16 条已核实缺陷，列出疑似覆盖的编号
//   bun check.ts t9 Z*.md    对照 14 处植入缺陷，列出指到“同文件且行号相差 ≤5”的编号
//   bun check.ts iso         扫描全部运行里写死的 /tmp 路径，找出被多个运行共用的（隔离是软的，见 README）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { citedTruth, T9_TRUTH_FILE } from "./fixtures.ts";
import { jsonlFiles, readJsonl, WORK } from "./lib.ts";
import { T7_TRUTH } from "./tasks.ts";

const [mode, ...files] = process.argv.slice(2);

async function checkT3(): Promise<void> {
	const registry = new Map<string, Promise<{ version: string; date: string; deprecated: boolean } | undefined>>();
	const lookup = (name: string) => {
		if (!registry.has(name)) {
			registry.set(name, fetch("https://registry.npmjs.org/" + name.replace("/", "%2F")).then(async (res) => {
				if (!res.ok) return undefined;
				const doc: any = await res.json();
				const version = doc["dist-tags"].latest;
				return { version, date: doc.time[version].slice(0, 10), deprecated: Boolean(doc.versions[version].deprecated) };
			}).catch(() => undefined));
		}
		return registry.get(name)!;
	};
	for (const file of files) {
		console.log("==", basename(file));
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const cells = line.split("|").slice(1, -1).map((c) => c.trim());
			const name = cells[0]?.replace(/`/g, "").replace(/[（(].*/, "").trim().split(" ")[0];
			if (!name || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue;
			const version = cells.slice(1).find((c) => /^v?\d+\.\d+\.\d+/.test(c))?.replace(/^v/, "").split(" ")[0];
			const date = cells.slice(1).map((c) => c.match(/\d{4}-\d{2}(-\d{2})?/)?.[0]).find(Boolean);
			if (!version && !date) continue;
			const real = await lookup(name);
			if (!real) console.log(`  ??  ${name}（registry 查不到，可能不是 npm 包）`);
			else console.log(`  ${(!version || version === real.version) && (!date || real.date.startsWith(date)) ? "OK " : "XX "} ${name} 报告 ${version ?? "-"} ${date ?? "-"} | registry ${real.version} ${real.date}${real.deprecated ? " DEPRECATED" : ""}`);
		}
	}
}

function checkT7(): void {
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const hit = T7_TRUTH.filter((t) => t.pattern.test(text)).map((t) => t.id);
		console.log(`${basename(file)}: ${hit.length}/${T7_TRUTH.length}  疑似 ${hit.join(" ")}`);
	}
}

function checkT9(): void {
	if (!existsSync(T9_TRUTH_FILE)) throw new Error("还没生成过 t9 fixture（先跑一次 t9 任务）");
	const truth: Array<{ id: string; file: string; line: number }> = JSON.parse(readFileSync(T9_TRUTH_FILE, "utf8"));
	for (const file of files) {
		const hit = citedTruth(truth, readFileSync(file, "utf8"));
		const missed = truth.filter((t) => !hit.includes(t));
		console.log(`${basename(file)}: ${hit.length}/${truth.length}  命中 ${hit.map((t) => t.id).join(" ")}  | 未指到行号（需人读确认） ${missed.map((t) => t.id).join(" ")}`);
	}
}

function checkIso(): void {
	const users = new Map<string, Set<string>>();
	const runsRoot = join(WORK, "runs");
	for (const variant of existsSync(runsRoot) ? readdirSync(runsRoot) : []) {
		for (const run of readdirSync(join(runsRoot, variant))) {
			for (const log of jsonlFiles(join(runsRoot, variant, run, "sessions"))) {
				for (const e of readJsonl(log)) {
					for (const c of e.message?.content ?? []) {
						if (c.type !== "toolCall") continue;
						for (const m of JSON.stringify(c.arguments).matchAll(/(?:\/private)?\/tmp\/[\w.-]+/g)) {
							const path = m[0].replace("/private", "");
							if (path.startsWith(WORK.replace("/private", ""))) continue;
							if (!users.has(path)) users.set(path, new Set());
							users.get(path)!.add(`${variant}/${run}`);
						}
					}
				}
			}
		}
	}
	const shared = [...users].filter(([, runs]) => runs.size > 1);
	console.log(`写死的 /tmp 路径 ${users.size} 个，被多个运行用到的 ${shared.length} 个`);
	for (const [path, runs] of shared) console.log(`  ${path}  ← ${[...runs].join(", ")}`);
}

if (mode === "t3") await checkT3();
else if (mode === "t7") checkT7();
else if (mode === "t9") checkT9();
else if (mode === "iso") checkIso();
else throw new Error("用法见文件头注释");
