#!/usr/bin/env bun
// 判分：把每轮的阻塞发现对到真值、归类、判成立与否，写 judge.json。
//   bun judge.ts <label> [--model gpt-6-luna/medium] [--verify claude-sonnet-5-5/medium | --verify none] [--force]
// 第一段（--model，无工具）：对照需求、改动 diff、真值与修复 diff，逐条给出命中哪条真值、类别、是否成立。
// 第二段（--verify，只读工具，在被审仓库副本里）：第一段没对上真值的发现逐条核实（包括第一裁判判假的）；结论按（用例, 发现正文）缓存在 $EVAL_DIR/verdicts/。
// 裁判的准确率先人工抽样核过再用（见 README）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { killTree, onJsonLines, pool, startPi, USER_AGENT_DIR } from "../delegation/lib.ts";
import { type Case, caseById } from "./cases.ts";
import { copyRepo, fixtureKey, fixtureRepo } from "./fixture.ts";
import { cliModel, fixtureHost, git, quotaBlock, SOURCES, WORK } from "./lib.ts";

export const CATEGORIES = ["bug", "requirement", "convention", "questionable", "verification", "nitpick"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Finding {
	n: number;
	title: string;
	severity: string;
	text: string;
	truth: string | null;
	trap: string | null;
	category: Category;
	valid: "yes" | "no" | "unsure" | "unsure";
	reason: string;
	verified?: boolean;
}

export interface RoundJudgement {
	round: number;
	findings: Finding[];
	/** 只写在建议区（不阻塞）里的真值。 */
	suggested: string[];
}

const DIFF_LIMIT = 60_000;
const FIX_LIMIT = 12_000;
const HEADING = /^#{1,6}\s*(?:发现|Finding)\s*\d*.*$/gimu;
const SUGGESTIONS = /^##\s+(?:建议（非阻塞）|Suggestions \(non-blocking\))\s*$/imu;

/** 审查者原文拆成阻塞发现与建议区；格式不合契约的 FAIL 整段算一条。 */
export function splitFindings(details: string): { blocking: Array<{ title: string; severity: string; text: string }>; suggestions: string } {
	const [head = "", suggestions = ""] = details.split(SUGGESTIONS);
	const starts = [...head.matchAll(HEADING)].map((match) => match.index!);
	const sections = starts.length ? starts.map((start, index) => head.slice(start, starts[index + 1] ?? head.length).trim()) : head.trim() ? [head.trim()] : [];
	return {
		blocking: sections.map((text) => ({
			title: text.split("\n")[0]!.replace(/^#{1,6}\s*(?:发现|Finding)\s*\d*\s*[:：]?\s*/u, "").trim(),
			severity: /(?:严重程度|Severity)\**\s*[:：]\s*\**\s*([^\s*]+)/u.exec(text)?.[1] ?? "",
			text,
		})),
		suggestions: suggestions.trim(),
	};
}

const clipText = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}\n…（截断，原文 ${text.length} 字）` : text);

function caseMaterial(item: Case): string {
	const source = SOURCES[item.source];
	const requests = item.turns.map((turn, index) => `### 第 ${index + 1} 条用户消息\n${turn.user}`).join("\n\n");
	const diff = clipText(git(fixtureRepo(item), "diff", "main", "work"), DIFF_LIMIT);
	const injections = item.turns.flatMap((turn) => turn.inject ?? []);
	const fixOf = (fix: string) => fix === "inject"
		? injections.map((change) => `植入在 ${change.file}：原文\n\`\`\`\n${change.find}\n\`\`\`\n被改成\n\`\`\`\n${change.replace}\n\`\`\``).join("\n")
		: `修复提交 ${fix} 的 diff：\n\`\`\`diff\n${clipText(git(source, "show", "--format=", fix), FIX_LIMIT)}\n\`\`\``;
	const truth = item.truth.length
		? item.truth.map((defect) => `- ${defect.id}（${defect.kind}）：${defect.summary}\n  ${fixOf(defect.fix)}`).join("\n")
		: "（无已知缺陷；这是待核实的对照提交，不能因此认定所有发现都是误报）";
	const traps = item.traps?.length ? item.traps.map((trap) => `- ${trap.id}：${trap.summary}；正确处理：${trap.right}`).join("\n") : "（无）";
	const root = fixtureRepo(item);
	const files = git(root, "ls-files", "*AGENTS.md").trim().split("\n").filter(Boolean);
	const conventions = clipText(files.map((file) => `### ${file}\n${readFileSync(join(root, file), "utf8")}`).join("\n"), 40_000);
	return `## 项目约定\n${conventions}\n\n## 需求\n${requests}\n\n## 被审改动（git diff main..work）\n\`\`\`diff\n${diff}\n\`\`\`\n\n## 已知缺陷（真值）\n${truth}\n\n## 已知陷阱（会诱发有害修复的说法）\n${traps}`;
}

const JUDGE_POLICY = `你是代码审查评测的裁判。给你一次改动的需求、diff、已知缺陷（真值，来自后来的修复提交）、已知陷阱，以及审查者给出的阻塞发现与建议区。逐条判定每个阻塞发现，只输出一个 JSON 对象，不要其他文字：
{"findings":[{"n":1,"truth":"真值 id 或 null","trap":"陷阱 id 或 null","category":"…","valid":"yes|no|unsure","reason":"一句话"}],"suggested":["只出现在建议区里的真值 id"]}

判定规则：
- truth：发现指出的是该真值描述的同一个缺陷（同一处代码、同一种错误），哪怕措辞或给的修法不同，就填它的 id；只是碰到同一个文件、或泛泛提到相关主题不算。一条发现最多对一个真值。
- trap：发现把陷阱里的说法当成要修的阻塞项（要求执行模型按陷阱方向去改）才填；如果它指出了冲突并要求交用户裁决，不算陷阱，category 记 questionable。
- category 只选一个：
  bug：会让行为出错的真实缺陷（错误分支、边界、竞态、数据丢失、假成功、回归）；
  requirement：实现偏离了用户需求（漏做、做错、范围不符）；用户显式要求的测试或证据交付物确实缺失也属于此类；
  convention：违背项目文档写明的约定或设计规则，或引入第二事实源、兼容层、绕过宿主公开接口的 hack；
  questionable：指出需求本身不合理、自相矛盾或与项目约定冲突，需要用户拍板；
  verification：只说测试或验证不够（没覆盖、没实测、断言弱），既没有指出行为错误，也没有缺少用户显式要求的交付物；
  nitpick：风格、措辞、文档表述、可有可无的改进、需要多个罕见前提的假设场景、过度防御。
  对上真值的发现按真值的 kind 归类。
- valid：yes = 所述事实成立且按需求与项目约定确实是问题；no = 事实不成立，或按需求/项目约定这本来就不是问题；unsure = 只看给你的材料判不了。对上真值的一律 yes。干净提交上的发现不因“没有真值”就判 no，按事实判。`;

const VERIFY_POLICY = `你在核实一条代码审查发现是否成立。当前目录是被审查时的仓库：work 分支是改动后，main 是改动前（git diff main 即本次改动）。只读：可以 read、grep、find、ls，用 bash 跑测试或脚本复现，不要修改任何文件。先读根目录与相关目录的 AGENTS.md。只输出一个 JSON 对象，不要其他文字：
{"valid":"yes|no|unsure","category":"bug|requirement|convention|questionable|verification|nitpick","reason":"一句话，带文件或命令证据"}
valid：yes = 所述事实成立，且按用户需求与项目约定确实是需要修的问题；no = 事实不成立，或按需求/约定本来就不是问题（例如约定明确不做兼容迁移，发现却要求兼容）；证据不足记 unsure，不猜。category 的含义：bug 行为缺陷；requirement 偏离需求；convention 违背项目写明的约定；questionable 需求本身需要用户拍板；verification 只说验证不够；nitpick 风格措辞、可有可无、假设性极端场景。`;

interface PiResult {
	text: string;
	cost: number;
}

/** 一次性的 pi 调用：不加载扩展、技能与上下文文件，用户的 Agent 目录只读（不落会话）。 */
async function ask(model: string, system: string, prompt: string, o: { cwd: string; tools?: string; timeoutMin: number; env?: Record<string, string> }): Promise<PiResult> {
	const block = await quotaBlock();
	if (block) throw new Error(`停止裁判调用：${block}`);
	const agent = join(WORK, "judge-agent");
	if (!existsSync(agent)) {
		mkdirSync(agent, { recursive: true });
		for (const file of ["auth.json", "models.json", "models-store.json"]) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agent, file));
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, defaultProjectTrust: "always" }));
	}
	const tmp = join(WORK, "judge-tmp");
	mkdirSync(tmp, { recursive: true });
	const args = ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", cliModel(model), "--system-prompt", system, ...(o.tools ? ["--tools", o.tools] : ["--no-tools"]), prompt];
	const child = startPi(args, { agentDir: agent, cwd: o.cwd, tmp, stdin: "ignore", env: o.env });
	let text = "";
	let cost = 0;
	onJsonLines(child, (event) => {
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		cost += event.message.usage?.cost?.total ?? 0;
		const body = (event.message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
		if (body.trim()) text = body;
	});
	const errors: Buffer[] = [];
	child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { killTree(child); reject(new Error("裁判超时")); }, o.timeoutMin * 60_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(`裁判退出 ${code}：${Buffer.concat(errors).toString().slice(-1000)}`));
			else resolve();
		});
	});
	return { text, cost };
}

function parseJson<T>(text: string): T {
	const match = /\{[\s\S]*\}/u.exec(text);
	if (!match) throw new Error(`裁判没有给出 JSON：${text.slice(0, 200)}`);
	return JSON.parse(match[0]) as T;
}

async function verify(item: Case, finding: Finding, model: string): Promise<{ valid: "yes" | "no" | "unsure"; category: Category; reason: string; cost: number }> {
	const key = createHash("sha256").update(JSON.stringify([fixtureKey(item), finding.text.trim(), model, VERIFY_POLICY])).digest("hex").slice(0, 16);
	const cached = join(WORK, "verdicts", item.id, `${key}.json`);
	if (existsSync(cached)) return { ...JSON.parse(readFileSync(cached, "utf8")), cost: 0 };
	const repo = copyRepo(item, join(WORK, "verify", `${item.id}-${key}`));
	const requests = item.turns.map((turn) => turn.user).join("\n\n---\n\n");
	const { text, cost } = await ask(model, VERIFY_POLICY, `用户需求：\n${requests}\n\n待核实的审查发现：\n${finding.text}`, { cwd: repo, tools: "read,grep,find,ls,bash", timeoutMin: 20, env: item.source === "firecode" ? fixtureHost(repo).env : undefined });
	rmSync(repo, { recursive: true, force: true });
	const verdict = parseJson<{ valid: "yes" | "no" | "unsure"; category: Category; reason: string }>(text);
	if (!["yes", "no", "unsure"].includes(verdict.valid) || !CATEGORIES.includes(verdict.category)) throw new Error("核实裁判输出不合契约");
	mkdirSync(join(WORK, "verdicts", item.id), { recursive: true });
	writeFileSync(cached, JSON.stringify({ ...verdict, model }, null, 1));
	return { ...verdict, cost };
}

export async function judgeRun(dir: string, o: { model: string; verifier?: string }): Promise<{ rounds: RoundJudgement[]; cost: number }> {
	const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
	const item = caseById(result.case);
	const material = caseMaterial(item);
	let cost = 0;
	const rounds: RoundJudgement[] = [];
	for (const round of result.rounds as Array<{ round: number; result: string; reviewers: Array<{ status: string; details: string }> }>) {
		// 后续轮的代码已被执行模型改过；没有逐轮仓库快照时不拿首轮真值硬判修复结果。
		if (round.round !== 1) continue;
		const parts = round.reviewers.filter((reviewer) => reviewer.status === "failed").map((reviewer) => splitFindings(reviewer.details));
		const passSuggestions = round.reviewers.filter((reviewer) => reviewer.status === "passed").map((reviewer) => splitFindings(reviewer.details).suggestions);
		const blocking = parts.flatMap((part) => part.blocking);
		const suggestions = [...parts.map((part) => part.suggestions), ...passSuggestions].filter(Boolean).join("\n\n");
		if (!blocking.length && !suggestions) {
			rounds.push({ round: round.round, findings: [], suggested: [] });
			continue;
		}
		const listing = blocking.map((finding, index) => `### 阻塞发现 ${index + 1}\n${finding.text}`).join("\n\n") || "（无）";
		const prompt = `${material}\n\n## 审查者第 ${round.round} 轮的阻塞发现\n${listing}\n\n## 审查者的建议区（非阻塞）\n${suggestions || "（无）"}`;
		const answer = await ask(o.model, JUDGE_POLICY, prompt, { cwd: WORK, timeoutMin: 10 });
		cost += answer.cost;
		const parsed = parseJson<{ findings: Array<Omit<Finding, "title" | "severity" | "text">>; suggested?: string[] }>(answer.text);
		if (parsed.findings.length !== blocking.length) throw new Error("裁判发现数量不符");
		const findings: Finding[] = blocking.map((finding, index) => {
			const entries = parsed.findings.filter((entry) => entry.n === index + 1);
			if (entries.length !== 1) throw new Error(`裁判漏判或重复：${index + 1}`);
			const verdict = entries[0]!;
			if (!CATEGORIES.includes(verdict.category) || !["yes", "no", "unsure"].includes(verdict.valid)) throw new Error("裁判类别不合契约");
			if (verdict.truth && !item.truth.some((truth) => truth.id === verdict.truth)) throw new Error(`未知真值：${verdict.truth}`);
			if (verdict.trap && !item.traps?.some((trap) => trap.id === verdict.trap)) throw new Error(`未知陷阱：${verdict.trap}`);
			if (verdict.truth && verdict.valid !== "yes") throw new Error("命中真值与判假冲突");
			return { ...finding, ...verdict };
		});
		if (o.verifier)
			for (const finding of findings) {
				if (finding.truth) continue;
				const verdict = await verify(item, finding, o.verifier);
				cost += verdict.cost;
				Object.assign(finding, { valid: verdict.valid, category: verdict.category, reason: verdict.reason, verified: true });
			}
		rounds.push({ round: round.round, findings, suggested: (parsed.suggested ?? []).filter((id) => item.truth.some((defect) => defect.id === id)) });
	}
	return { rounds, cost };
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { model: { type: "string", default: "gpt-6-luna/medium" }, verify: { type: "string", default: "claude-sonnet-5-5/medium" }, force: { type: "boolean" }, concurrency: { type: "string", default: "4" } },
	});
	const label = positionals[0];
	if (!label) throw new Error("用法见文件头注释");
	const root = join(WORK, "runs", label);
	const dirs = readdirSync(root).map((name) => join(root, name)).filter((dir) => existsSync(join(dir, "result.json")));
	let total = 0;
	let failed = 0;
	await pool(dirs.map((dir) => async () => {
		if (!values.force && existsSync(join(dir, "judge.json"))) return;
		if (JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).status !== "done") return;
		try {
			const judged = await judgeRun(dir, { model: values.model!, ...(values.verify === "none" ? {} : { verifier: values.verify! }) });
			total += judged.cost;
			writeFileSync(join(dir, "judge.json"), JSON.stringify({ model: values.model, verifier: values.verify, ...judged }, null, 1));
			console.log(`${dir.split("/").at(-1)} 判完 $${judged.cost.toFixed(3)}`);
		} catch (error) {
			failed += 1;
			writeFileSync(join(dir, "judge-error.txt"), String(error));
			console.error(`${dir.split("/").at(-1)} 判分失败：${error}`);
		}
	}), Number(values.concurrency));
	console.log(`裁判共 $${total.toFixed(2)}；失败 ${failed}`);
	if (failed) process.exitCode = 1;
}
