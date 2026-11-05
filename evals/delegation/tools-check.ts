#!/usr/bin/env bun
// 效度检查：每个工具形态各发一次最小请求，抓第一次请求里实际暴露给模型的 tools 列表与 codemode 描述，对照预期。
//   bun tools-check.ts <原子[,原子…]> [--forms only,on,off] [--prefix cmd-]
// --prefix：检查已建好的变体（variant.ts 建的 <前缀><形态>，如指挥官变体 cmd-only），只记录不判对错（指挥官还有 subagents 等扩展工具，人看）。
// 结果写到 $EVAL_DIR/validity/<形态>__<原子>.json（payload 原文）与 summary.json；不符预期就退出码 1。
// 在变体 Agent 目录的临时副本里装探针扩展（PROBE，在第一次请求前把 payload 写到 $TOOLS_PROBE_OUT），不改变体本身；模型回复一句话，花费可忽略。
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { piCommand, TOOL_FORMS, variantAgent, WORK } from "./lib.ts";
import { setupAgent, variantOf } from "./worker-agent.ts";

const OUT = join(WORK, "validity");
const [pi, piArgs] = piCommand();
const PROBE = `import { writeFileSync } from "node:fs";\nexport default (pi) => pi.on("before_provider_request", (event) => { writeFileSync(process.env.TOOLS_PROBE_OUT, JSON.stringify(event.payload)); });\n`;
const NATIVE = ["read", "bash", "edit", "write"];

/** 各形态预期：顶层声明的工具名、codemode 描述里 tools.<名> 能列出的工具、是否有 codemode。 */
const EXPECT: Record<string, { top: string[]; scripted: string[] }> = {
	only: { top: ["codemode"], scripted: NATIVE },
	on: { top: [...NATIVE, "codemode"], scripted: [] },
	off: { top: NATIVE, scripted: [] },
};

const names = (payload: any): string[] => (payload.tools ?? []).map((t: any) => String(t.name ?? t.function?.name).replace(/^mcp__magpie__/, "")).sort();
const description = (payload: any): string => {
	const t = (payload.tools ?? []).find((x: any) => /codemode$/.test(String(x.name ?? x.function?.name)));
	return String(t?.description ?? t?.function?.description ?? "");
};

const { values, positionals } = parseArgs({ allowPositionals: true, options: { forms: { type: "string", default: Object.keys(TOOL_FORMS).join(",") }, prefix: { type: "string" } } });
mkdirSync(OUT, { recursive: true });
const summary: Array<Record<string, unknown>> = [];
let bad = 0;
for (const atom of positionals[0]!.split(",")) {
	for (const form of values.forms!.split(",")) {
		if (!values.prefix) setupAgent(form);
		const copy = join(OUT, "agent-" + (values.prefix ?? "") + form);
		rmSync(copy, { recursive: true, force: true });
		cpSync(variantAgent(values.prefix ? values.prefix + form : variantOf(form)), copy, { recursive: true, verbatimSymlinks: true });
		mkdirSync(join(copy, "extensions"), { recursive: true });
		writeFileSync(join(copy, "extensions/tools-probe.ts"), PROBE);
		const file = join(OUT, (values.prefix ?? "") + form + "__" + atom.replace(/\//g, "_") + ".json");
		rmSync(file, { force: true });
		const cwd = join(OUT, "cwd");
		mkdirSync(cwd, { recursive: true });
		spawnSync(pi, [...piArgs, "-p", "--no-session", "--model", atom.replace(/\/([^/]+)$/, ":$1"), "只回复 ok"], { cwd, stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: copy, PI_OFFLINE: "1", PI_TELEMETRY: "0", TOOLS_PROBE_OUT: file } });
		const payload = JSON.parse(readFileSync(file, "utf8"));
		const top = names(payload);
		const desc = description(payload);
		const listed = NATIVE.filter((n) => desc.includes("### `" + n + "`"));
		const want = EXPECT[form]!;
		const topOk = JSON.stringify(top) === JSON.stringify([...want.top].sort());
		// codemode 描述里以“### `名`”列出脚本可调的工具。only 列出全部可调工具；on/off 不列原生工具（on 在各工具自己的描述里写了脚本调法）。
		const listedOk = JSON.stringify(listed) === JSON.stringify(NATIVE.filter((n) => want.scripted.includes(n)));
		const scripted = [...desc.matchAll(/^### `([\w-]+)`/gm)].map((m) => m[1]);
		if (values.prefix) summary.push({ form, atom, agent: values.prefix + form, top, scripted });
		else {
			if (!(topOk && listedOk)) bad++;
			summary.push({ form, atom, top, codemodeDescriptionListsNative: listed, expectTop: want.top, expectScripted: want.scripted, ok: topOk && listedOk });
		}
	}
}
writeFileSync(join(OUT, (values.prefix ?? "") + "summary.json"), JSON.stringify(summary, null, 1));
console.log(summary.map((s) => JSON.stringify(s)).join("\n"));
process.exit(bad ? 1 : 0);
