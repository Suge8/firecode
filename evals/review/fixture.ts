// 用例落地：被审仓库（只含 base 之后的改动历史，看不到后来的修复）与“做完这次改动”的会话记录。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Case, CASES, headOf } from "./cases.ts";
import { git, SOURCES, WORK } from "./lib.ts";

const FIXTURES = join(WORK, "fixtures");
/** 只取决定仓库内容的部分：改需求文字、验证命令或真值不重建仓库（重建会丢掉 setup 装进去的依赖与构建产物）。 */
export const fixtureKey = (item: Case): string => createHash("sha256")
	.update(JSON.stringify({ source: item.source, base: item.base, turns: item.turns.map(({ to, inject }) => ({ to, inject })) }))
	.update(fixtureRepo.toString()).update(exportTree.toString()).digest("hex");

export interface CheckResult { command: string; exit: number | null; tail: string }
export const ENVCHECK = join(WORK, "envcheck.json");

/**
 * 仓库副本：base 的文件树作为唯一的初始提交（拿不到之后的历史，也就拿不到修复），
 * 每一轮的改动按原提交逐个重放到 work 分支上，审查者 git log / git diff main 看到的就是会话做的事。
 */
export function fixtureRepo(item: Case): string {
	const dir = join(FIXTURES, item.id);
	const ready = `${dir}.ready`;
	if (existsSync(ready) && readFileSync(ready, "utf8") === fixtureKey(item)) return dir;
	const source = SOURCES[item.source];
	const staging = `${dir}.tmp-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	exportTree(source, item.base, staging);
	git(staging, "init", "-q", "-b", "main");
	git(staging, "add", "-A");
	git(staging, "commit", "-q", "-m", "base", "--date", git(source, "show", "-s", "--format=%aI", item.base).trim());
	git(staging, "checkout", "-q", "-b", "work");
	let from = item.base;
	const turns: string[] = [];
	for (const turn of item.turns) {
		for (const commit of git(source, "rev-list", "--reverse", "--first-parent", `${from}..${turn.to}`).split("\n").filter(Boolean)) {
			const patch = git(source, "diff", "--binary", `${commit}^1`, commit);
			if (patch) execFileSync("git", ["-C", staging, "apply", "--index", "--whitespace=nowarn"], { input: patch });
			const message = git(source, "show", "-s", "--format=%B", commit);
			git(staging, "commit", "-q", "--allow-empty", "-m", message, "--date", git(source, "show", "-s", "--format=%aI", commit).trim());
		}
		if (turn.inject?.length) {
			for (const { file, find, replace } of turn.inject) {
				const path = join(staging, file);
				const text = readFileSync(path, "utf8");
				if (text.split(find).length !== 2) throw new Error(`${item.id}：植入的原文在 ${file} 里不是恰好出现一次`);
				writeFileSync(path, text.replace(find, () => replace));
				git(staging, "add", file);
			}
			git(staging, "commit", "-q", "--amend", "--no-edit");
		}
		turns.push(git(staging, "rev-parse", "HEAD").trim());
		from = turn.to;
	}
	writeFileSync(`${dir}.turns.json`, JSON.stringify(turns));
	writeFileSync(join(staging, ".git", "info", "exclude"), "node_modules\n.pi-mono\n");
	rmSync(dir, { recursive: true, force: true });
	renameSync(staging, dir);
	writeFileSync(ready, fixtureKey(item));
	return dir;
}

/** 导出某个提交的完整文件树。不用 git archive：它按 .gitattributes 的 export-ignore 丢掉 AGENTS.md 与测试。 */
function exportTree(source: string, ref: string, dest: string): void {
	const env = { ...process.env, GIT_INDEX_FILE: `${dest}.index` };
	execFileSync("git", ["-C", source, "read-tree", ref], { env });
	execFileSync("git", ["-C", source, "checkout-index", "-a", "-f", `--prefix=${dest}/`], { env });
	rmSync(`${dest}.index`, { force: true });
}

/** 改动涉及的文件：A 新增、M 修改、D 删除、R 改名（按目标路径）。 */
function changedFiles(repo: string, from: string, to: string): Array<{ status: string; path: string }> {
	return git(repo, "diff", "--name-status", "-M", from, to)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, ...paths] = line.split("\t");
			return { status: status![0]!, path: paths.at(-1)! };
		});
}

/** 读过的约定文件：根 AGENTS.md 加改动目录链上的 AGENTS.md（存在才读）。 */
function conventionFiles(repo: string, paths: string[]): string[] {
	const dirs = new Set([""]);
	for (const path of paths) for (let dir = dirname(path); dir !== "." && dir !== ""; dir = dirname(dir)) dirs.add(dir);
	return [...dirs].map((dir) => join(dir, "AGENTS.md")).filter((file) => existsSync(join(repo, file)));
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 合成会话：公开提交重建需求与编辑轨迹；验证命令的结果取 setup.ts check 在同一棵树上实跑的退出码与输出尾部，
 * 交付声明只陈述提交与这些实跑结果，不编造“已补测试”之类无法追溯的说法。
 * 消息链与工具调用 id 完整，修复模式下执行模型可以接着这份会话继续干活。
 */
export function writeSession(item: Case, repo: string, file: string, executor: { provider: string; model: string }): void {
	const turns = JSON.parse(readFileSync(`${fixtureRepo(item)}.turns.json`, "utf8")) as string[];
	if (!existsSync(ENVCHECK)) throw new Error("先运行 bun evals/review/setup.ts check");
	const checked = JSON.parse(readFileSync(ENVCHECK, "utf8")) as Record<string, CheckResult[]>;
	const checksAt = (to: string): CheckResult[] => {
		const owner = CASES.find((other) => other.source === item.source && headOf(other) === to && checked[other.id]);
		if (!owner) throw new Error(`${item.id}：${to} 没有实跑的验证结果，先运行 setup.ts check`);
		return checked[owner.id]!;
	};
	const lines: object[] = [];
	let clock = Date.parse(git(SOURCES[item.source], "show", "-s", "--format=%aI", headOf(item)).trim()) - 3_600_000;
	let parent: string | null = null;
	let calls = 0;
	const push = (entry: Record<string, unknown>) => {
		const id = randomUUID().slice(0, 8);
		clock += 7_000;
		lines.push({ ...entry, id, parentId: parent, timestamp: new Date(clock).toISOString() });
		parent = id;
	};
	const user = (text: string) => push({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: clock } });
	const assistant = (text: string, tools: Array<{ name: string; arguments: Record<string, unknown>; result: string; isError?: boolean }>) => {
		const content: object[] = text ? [{ type: "text", text }] : [];
		const ids = tools.map((tool) => {
			const id = `call_${++calls}`;
			content.push({ type: "toolCall", id, name: tool.name, arguments: tool.arguments });
			return id;
		});
		push({ type: "message", message: { role: "assistant", content, api: "openai-completions", provider: executor.provider, model: executor.model, usage: ZERO_USAGE, stopReason: tools.length ? "toolUse" : "stop", timestamp: clock } });
		tools.forEach((tool, index) => push({ type: "message", message: { role: "toolResult", toolCallId: ids[index], toolName: tool.name, content: [{ type: "text", text: tool.result }], isError: tool.isError ?? false, timestamp: clock } }));
	};

	lines.push({ type: "session", version: 3, id: randomUUID(), timestamp: new Date(clock).toISOString(), cwd: repo });
	push({ type: "model_change", provider: executor.provider, modelId: executor.model });
	let from = "main";
	item.turns.forEach((turn, index) => {
		const to = turns[index]!;
		const files = changedFiles(repo, from, to);
		user(turn.user);
		const conventions = index === 0 ? conventionFiles(repo, files.map((entry) => entry.path)) : [];
		const reads = [...conventions, ...files.filter((entry) => entry.status !== "A").map((entry) => entry.path).filter((path) => !conventions.includes(path))];
		assistant("先读项目约定和要改的代码。", reads.map((path) => ({ name: "read", arguments: { path }, result: "（已读取）" })));
		assistant("开始改。", files.map((entry) =>
			entry.status === "D" ? { name: "bash", arguments: { command: `git rm -q ${entry.path}` }, result: "" }
			: entry.status === "A" ? { name: "write", arguments: { path: entry.path, content: "…" }, result: `Successfully wrote ${entry.path}` }
			: { name: "edit", arguments: { path: entry.path, edits: [] }, result: `Successfully replaced text in ${entry.path}.` }));
		const results = checksAt(turn.to);
		assistant("跑验证。", results.map((result) => ({ name: "bash", arguments: { command: result.command }, result: result.tail, isError: result.exit !== 0 })));
		const subjects = git(repo, "log", "--reverse", "--format=%s", `${from}..${to}`).trim().split("\n").filter(Boolean);
		assistant("", [{ name: "bash", arguments: { command: `git add ${files.map((entry) => entry.path).join(" ")} && git commit -m ${JSON.stringify(subjects.join("；"))}` }, result: `[work] ${subjects.at(-1) ?? ""}` }]);
		assistant(`已完成并提交：${subjects.join("；")}。验证：${results.map((result) => `${result.command}（exit ${result.exit}）`).join("；")}。`, []);
		from = to;
	});
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** 每次运行一份独立的仓库副本。 */
export function copyRepo(item: Case, dest: string): string {
	rmSync(dest, { recursive: true, force: true });
	cpSync(fixtureRepo(item), dest, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
	return dest;
}
