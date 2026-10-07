#!/usr/bin/env bun
// 建一个变体：被测的 firecode 副本 + 临时 Agent 目录。
//   bun variant.ts <名> [--code-ref 提交=HEAD] [--prompt-ref 提交 | --prompt-file 文件] [--cut 文本] [--workers-codemode]
// 提示词默认取代码副本自带的 master.zh.md；--prompt-ref/--prompt-file 整份替换，--cut 再从中删掉一段原文（须恰好出现一次）。
// 只读取已提交的内容：未提交的提示词改动用 --prompt-file。
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gitArchive, gitShow, USER_AGENT_DIR, WORK } from "./lib.ts";

const PROMPT = "master/prompts/master.zh.md";
/** 凭据、设置、模型表等符号链接回用户 Agent 目录（不复制凭据）；扩展与会话目录不链接。 */
const LINKED = ["auth.json", "settings.json", "models.json", "models-store.json", "SYSTEM.md", "keybindings.json", "bin"];
const WORKER_CODEMODE_FROM = "active.setup.pi.getActiveTools().includes(CODEMODE_TOOL) ? [...WORKER_TOOLS, CODEMODE_TOOL] : WORKER_TOOLS";

function replaceOnce(text: string, from: string, to: string, what: string): string {
	if (text.split(from).length !== 2) throw new Error(`${what}：要替换的原文不是恰好出现一次`);
	return text.replace(from, to);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"code-ref": { type: "string", default: "HEAD" },
		"prompt-ref": { type: "string" },
		"prompt-file": { type: "string" },
		cut: { type: "string" },
		"workers-codemode": { type: "boolean" },
	},
});
const name = positionals[0];
if (!name) throw new Error("用法见文件头注释");

const root = join(WORK, "variants", name);
const source = join(root, "firecode");
const agent = join(root, "agent");
rmSync(root, { recursive: true, force: true });
gitArchive(values["code-ref"]!, source);

const promptPath = join(source, PROMPT);
let prompt = values["prompt-file"] ? readFileSync(values["prompt-file"], "utf8") : values["prompt-ref"] ? gitShow(values["prompt-ref"], PROMPT) : readFileSync(promptPath, "utf8");
if (values.cut) prompt = replaceOnce(prompt, values.cut, "", "--cut");
if (!prompt.trim()) throw new Error("提示词为空");
writeFileSync(promptPath, prompt);

if (values["workers-codemode"]) {
	// 让 Worker 不依赖指挥官是否开着 codemode：配合 run.ts --exclude-tools codemode 测“只有 Worker 开”。
	const runPath = join(source, "master/run.ts");
	writeFileSync(runPath, replaceOnce(readFileSync(runPath, "utf8"), WORKER_CODEMODE_FROM, "[...WORKER_TOOLS, CODEMODE_TOOL]", "--workers-codemode"));
}

mkdirSync(join(agent, "extensions/firecode"), { recursive: true });
for (const file of LINKED) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
symlinkSync(join(USER_AGENT_DIR, "extensions/firecode/config.jsonc"), join(agent, "extensions/firecode/config.jsonc"));
writeFileSync(join(agent, "extensions/firecode/index.ts"), 'export { default } from "./source/index.ts";\n');
symlinkSync(source, join(agent, "extensions/firecode/source"));

console.log(`变体 ${name} 就绪：代码 ${values["code-ref"]}，提示词 sha256 ${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}（${promptPath}）`);
