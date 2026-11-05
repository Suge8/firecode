// 角色选型与形态评测共用的 Worker 变体 Agent 目录。
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requirePiPackages } from "../../scripts/pi-source.ts";
import { gitArchive, jsonlFiles, readJsonl, TOOL_FORMS, USER_AGENT_DIR, variantAgent, withToolForm, WORK } from "./lib.ts";

const VARIANT = "worker";
export const variantOf = (form: string | undefined) => (form ? VARIANT + "-" + form : VARIANT);

/** 凭据与设置链回用户目录；firecode 取已提交代码的副本（沙箱不放行本仓库），只开 claudeSub（订阅请求要带归因），不激活指挥官，Worker 提示词由命令行追加。形态的 settings 每次重写成用户 settings 的副本加覆盖。 */
export function setupAgent(form: string | undefined): void {
	const agent = variantAgent(variantOf(form));
	if (form) {
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify(withToolForm(JSON.parse(readFileSync(join(USER_AGENT_DIR, "settings.json"), "utf8")), TOOL_FORMS[form]!), null, 1));
	}
	if (existsSync(join(agent, "extensions/firecode"))) return;
	const source = join(dirname(agent), "firecode");
	gitArchive("HEAD", source);
	mkdirSync(join(agent, "extensions/firecode"), { recursive: true });
	for (const file of ["auth.json", ...(form ? [] : ["settings.json"]), "models.json", "models-store.json", "SYSTEM.md", "bin"])
		if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
	const off = Object.fromEntries(["header", "statusbar", "tools", "presets", "rename", "stats", "openaiNative", "review", "master", "watcher"].map((k) => [k, false]));
	writeFileSync(join(agent, "extensions/firecode/config.jsonc"), JSON.stringify({ features: { ...off, claudeSub: true } }));
	writeFileSync(join(agent, "extensions/firecode/index.ts"), 'export { default } from "./source/index.ts";\n');
	symlinkSync(source, join(agent, "extensions/firecode/source"));
}

/**
 * fixture 里宿主包的 package.json 指向未构建的 dist，导入不了；这里铺一份 node_modules：@earendil-works/* 改成指向 src 的薄壳，
 * 其余链回 pi 源码的 node_modules。src 是符号链接，按真实路径解析，包内依赖照常找到。并发起跑前先建好（见末尾）。
 */
export function hostModules(): string {
	const dest = join(WORK, "host-modules");
	if (existsSync(dest)) return dest;
	const root = join(dirname(requirePiPackages()), "node_modules");
	mkdirSync(join(dest, "@earendil-works"), { recursive: true });
	for (const name of readdirSync(root)) if (name !== "@earendil-works") symlinkSync(join(root, name), join(dest, name));
	for (const name of readdirSync(join(root, "@earendil-works"))) {
		const src = join(realpathSync(join(root, "@earendil-works", name)), "src");
		if (!existsSync(join(src, "index.ts"))) continue;
		const shell = join(dest, "@earendil-works", name);
		mkdirSync(shell);
		symlinkSync(src, join(shell, "src"));
		writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "@earendil-works/" + name, type: "module", exports: "./src/index.ts" }));
	}
	return dest;
}

/** 隐藏验收：跑 accept.ts 里该任务的用例，返回“通过/总数”，未通过的列名字。 */
export function accept(task: string, repo: string): string {
	const out = Bun.spawnSync(["bun", join(import.meta.dir, "accept.ts"), task, repo], { env: { ...process.env, TZ: "Asia/Shanghai" } }).stdout.toString().trim();
	const { total, failed } = JSON.parse(out.slice(out.lastIndexOf("\n") + 1)) as { total: number; failed: string[] };
	return total - failed.length + "/" + total + (failed.length ? "（缺 " + failed.join("、") + "）" : "");
}

export interface Effort {
	rounds: number;
	/** 顶层工具调用（codemode 脚本算一次）。 */
	calls: number;
	/** codemode 脚本里的嵌套调用。 */
	nested: number;
	output: number;
	total: number;
	/** 工具失败：顶层结果报错（脚本语法错、edit 找不到原文等）与嵌套调用报错。 */
	failTop: number;
	failNested: number;
}

/** 过程量从会话记录数：回合 = 模型回复条数，输出/总 = token（总含缓存读写）。 */
export function effort(sessionsDir: string): Effort {
	const messages = jsonlFiles(sessionsDir).flatMap(readJsonl).flatMap((e) => (e.message ? [e.message] : []));
	const replies = messages.filter((m) => m.role === "assistant");
	const results = messages.filter((m) => m.role === "toolResult");
	const sum = (xs: any[], pick: (x: any) => number) => xs.reduce((s, x) => s + pick(x), 0);
	const nestedCalls = results.flatMap((m) => m.nestedCalls?.calls ?? []);
	return {
		rounds: replies.length,
		calls: sum(replies, (m) => m.content.filter((c: { type: string }) => c.type === "toolCall").length),
		nested: nestedCalls.length,
		output: sum(replies, (m) => m.usage?.output ?? 0),
		total: sum(replies, (m) => m.usage?.totalTokens ?? 0),
		failTop: results.filter((m) => m.isError).length,
		failNested: nestedCalls.filter((c: { status: string }) => c.status === "error").length,
	};
}

