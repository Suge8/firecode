#!/usr/bin/env bun
// 建一个变体：被测的 firecode 副本 + 临时 Agent 目录。
//   bun variant.ts <名> [--code-ref 提交=HEAD] [--prompt-ref 提交 | --prompt-file 文件] [--cut 文本] [--model 原子]
// 提示词默认取代码副本自带的 master.zh.md；--prompt-ref/--prompt-file 整份替换，--cut 再从中删掉一段原文（须恰好出现一次）。
// --model "provider/model/thinking"：主会话与角色表、审查、观察员的全部模型都换成它（角色去掉 fallback，审查只留一个审查者），
// 用来便宜地验证脚本能跑通；不给则沿用你的 settings 与 config.jsonc。
// 只读取已提交的内容：未提交的提示词改动用 --prompt-file。
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseJsonc } from "../../jsonc.ts";
import { gitArchive, gitShow, USER_AGENT_DIR, WORK } from "./lib.ts";

const PROMPT = "master/prompts/master.zh.md";
/** 凭据、模型表等符号链接回用户 Agent 目录（不复制凭据）；扩展与会话目录不链接。 */
const LINKED = ["auth.json", "models.json", "models-store.json", "SYSTEM.md", "keybindings.json", "bin"];
const CONFIG = "extensions/firecode/config.jsonc";

function parseAtom(atom: string): { provider: string; model: string; thinking: string } {
	const first = atom.indexOf("/");
	const last = atom.lastIndexOf("/");
	if (first < 1 || last === first) throw new Error(`--model 须是 provider/model/thinking：${atom}`);
	return { provider: atom.slice(0, first), model: atom.slice(first + 1, last), thinking: atom.slice(last + 1) };
}

/** 用户的 settings 与 config.jsonc 各存一份，把其中的模型全部换成 atom。 */
function writeModelOverride(atom: string): void {
	const { provider, model, thinking } = parseAtom(atom);
	const settings = JSON.parse(readFileSync(join(USER_AGENT_DIR, "settings.json"), "utf8"));
	// enabledModels 是模型范围：默认模型不在范围内时宿主会改用范围里的第一个，所以一并去掉。
	Object.assign(settings, { defaultProvider: provider, defaultModel: model, defaultThinkingLevel: thinking, enabledModels: undefined });
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings, null, 1));
	const config: any = parseJsonc(readFileSync(join(USER_AGENT_DIR, CONFIG), "utf8"));
	for (const role of Object.values<any>(config.master?.roles ?? {})) Object.assign(role, { model: atom, fallback: undefined });
	if (config.review) Object.assign(config.review, { advisor: atom, reviewers: [atom] });
	if (config.watcher) config.watcher.model = atom;
	writeFileSync(join(agent, CONFIG), JSON.stringify(config, null, 1));
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"code-ref": { type: "string", default: "HEAD" },
		"prompt-ref": { type: "string" },
		"prompt-file": { type: "string" },
		cut: { type: "string" },
		model: { type: "string" },
	},
});
const name = positionals[0];
if (!name) throw new Error("用法见文件头注释");
if (values.model) parseAtom(values.model);

const root = join(WORK, "variants", name);
const source = join(root, "firecode");
const agent = join(root, "agent");
rmSync(root, { recursive: true, force: true });
gitArchive(values["code-ref"]!, source);

const promptPath = join(source, PROMPT);
let prompt = values["prompt-file"] ? readFileSync(values["prompt-file"], "utf8") : values["prompt-ref"] ? gitShow(values["prompt-ref"], PROMPT) : readFileSync(promptPath, "utf8");
if (values.cut) {
	if (prompt.split(values.cut).length !== 2) throw new Error("--cut：要删除的原文不是恰好出现一次");
	prompt = prompt.replace(values.cut, "");
}
if (!prompt.trim()) throw new Error("提示词为空");
writeFileSync(promptPath, prompt);

mkdirSync(join(agent, "extensions/firecode"), { recursive: true });
for (const file of LINKED) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
if (values.model) writeModelOverride(values.model);
else {
	symlinkSync(join(USER_AGENT_DIR, "settings.json"), join(agent, "settings.json"));
	symlinkSync(join(USER_AGENT_DIR, CONFIG), join(agent, CONFIG));
}
writeFileSync(join(agent, "extensions/firecode/index.ts"), 'export { default } from "./source/index.ts";\n');
symlinkSync(source, join(agent, "extensions/firecode/source"));

console.log(`变体 ${name} 就绪：代码 ${values["code-ref"]}，提示词 sha256 ${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}${values.model ? `，模型 ${values.model}` : ""}（${promptPath}）`);
