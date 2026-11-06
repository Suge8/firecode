#!/usr/bin/env bun
// 压缩摘要的细节保住率：压缩点之后 agent 实际用到、却只在压缩点之前出现过的细节，摘要里还剩多少。
//   bun detail.ts gt [--points id,…] [--model <模型>]       造标准答案 → $EVAL_DIR/detail/gt/<时点>.json（要调模型，每点约几美分）
//   bun detail.ts score <名>=<变体[,变体…]> <名>=<变体,…>    逐名打保住率；第一个是对照，每个名有几个变体就是几份摘要
// 摘要来自 `replay.ts compact <变体>` 存下的 $EVAL_DIR/replay/runs/<变体>/<时点>/compacted.jsonl；时点清单同 replay（REPLAY_POINTS）。
// 标准答案两类，都按“切点之后窗口最多 80 条助手消息”看，保留段与触发消息里出现过的不算：
//   字面量：路径、哈希、编号、环境变量、标识符。机械抽取（历史里有、保留段没有、窗口里第一次出现是助手自己写的），再请模型去噪。
//   用户侧：过程要求、范围禁令、决定与被否决的方案、未完成的请求、粘贴原文。请模型找出行为仍依赖的，引文由代码在用户消息原文里核对。
// 判分不调模型：字面量按字符串（原样=保住；路径只剩后两段、哈希前 7 位、编号去 #、标识符忽略大小写与连字符=改写后保住）；
// 用户侧看引文是否原样在摘要里，否则取摘要里最相关的 230 字窗口，细节二元组（idf 加权）覆盖比例 ≥ R_THRESHOLD 算改写后保住。
// 判分不知道摘要是谁写的。pi 机械追加的 <read-files>/<modified-files> 清单各配置一样，不算。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseList, readJsonl, WORK } from "./lib.ts";

const ROOT = join(WORK, "replay");
const GT_DIR = join(WORK, "detail", "gt");
const POINTS = process.env.REPLAY_POINTS ?? join(ROOT, "points.json");
const MAX_ASSISTANT = 80;
/** 用 Sonnet 在 8 条用户侧细节 × 13 份摘要上校准：二值一致 88/104；取 0.5 时只有 55/104。 */
const R_THRESHOLD = 0.2;
/** 判定线：比对照高 10 点以上，且大于两边各自份间极差。 */
const WIN_POINTS = 10;
const JUDGE_MODEL = "magpie/claude/claude-sonnet-5-5";

interface Point { id: string; file: string; entryId: string }
interface Literal { token: string; kind: string }
interface UserItem { cat: string; detail: string; quote: string }
interface Truth { literals: Literal[]; items: UserItem[] }
type Verdict = "K" | "R" | "L";
type Row = Record<string, any> & { _line: number };
interface Part { role: string | null; kind: string; text: string }

const loadPoints = (): Point[] => JSON.parse(readFileSync(POINTS, "utf8"));

// ───────────── 会话切片 ─────────────

function rowParts(r: Row): Part[] {
	const blocks = (content: any): Array<[string, string]> =>
		typeof content === "string" ? [["text", content]] : (content ?? []).flatMap((b: any): Array<[string, string]> => {
			if (b.type === "text") return [["text", b.text ?? ""]];
			if (b.type === "image") return [["image", "[image]"]];
			if (b.type !== "toolCall") return [];
			const { code, ...rest } = b.arguments ?? {};
			const args = typeof code === "string" ? (Object.keys(rest).length ? JSON.stringify(rest) + "\n" : "") + code : JSON.stringify(b.arguments);
			return [["call", `${b.name}(${args})`]];
		});
	const as = (role: string, kinds: Array<[string, string]>, force?: string): Part[] => kinds.map(([kind, text]) => ({ role, kind: force ?? kind, text }));
	if (r.type === "message") {
		const m = r.message;
		if (m.role === "toolResult") return as("result", blocks(m.content), "result");
		return m.role === "user" || m.role === "assistant" ? as(m.role, blocks(m.content)) : [];
	}
	return r.type === "custom_message" ? as("event", blocks(r.content)) : [];
}
const textOf = (rows: Row[]) => rows.flatMap(rowParts).map((p) => p.text).join("\n");

interface Slice { pre: Row[]; kept: Row[]; trigger: Row; post: Row[] }
/** 摘要前段 / 保留段 / 触发消息 / 切点之后窗口（沿触发消息的子孙走到最靠后的叶子，遇下一次压缩或助手满 80 条即止）。 */
function slice(point: Point, firstKeptEntryId: string): Slice {
	const rows: Row[] = readFileSync(point.file, "utf8").split("\n").flatMap((l, i) => {
		try { return [{ ...JSON.parse(l), _line: i + 1 }]; } catch { return []; }
	});
	const by = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
	const trigger = by.get(point.entryId)!;
	const chain: Row[] = [];
	for (let cur = trigger.parentId; cur; cur = by.get(cur)!.parentId) chain.unshift(by.get(cur)!);
	const cut = chain.findIndex((r) => r.id === firstKeptEntryId);
	const kids = new Map<string, Row[]>();
	for (const r of rows) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
	const desc = new Set<string>();
	for (const stack = [trigger.id]; stack.length; ) for (const c of kids.get(stack.pop()!) ?? []) { desc.add(c.id); stack.push(c.id); }
	const last = [...desc].map((id) => by.get(id)!).sort((a, b) => b._line - a._line)[0];
	const path: Row[] = [];
	for (let cur = last; cur && cur.id !== trigger.id; cur = by.get(cur.parentId)!) path.unshift(cur);
	const post: Row[] = [];
	let assistants = 0;
	for (const r of path) {
		if (r.type === "compaction") break;
		if (r.type === "message" && r.message.role === "assistant" && ++assistants > MAX_ASSISTANT) break;
		post.push(r);
	}
	return { pre: chain.slice(0, cut), kept: chain.slice(cut), trigger, post };
}

/** 一份摘要：compacted.jsonl 里最后一条压缩条目。 */
function compactionOf(variant: string, pid: string): any | undefined {
	const file = join(ROOT, "runs", variant, pid, "compacted.jsonl");
	return existsSync(file) ? readJsonl(file).findLast((e) => e.type === "compaction") : undefined;
}

// ───────────── 标准答案 ─────────────

const EXT = "ts|tsx|js|jsx|mjs|py|md|json|jsonl|swift|sh|yml|yaml|toml|css|html|sql|go|rs|txt|log|plist|patch|mdx|astro|kt|c|h|m";
const EXT_SET = new Set(EXT.split("|"));
const PATTERNS: Array<[string, RegExp]> = [
	["path", /(?<![\w/.\-@])(?:~|\.{0,2})?\/?[\w@.\-]+(?:\/[\w@.\-]+)+\/?/g],
	["path", new RegExp(String.raw`(?<![\w/.\-@])[\w\-]+(?:\.[\w\-]+)*\.(?:${EXT})\b`, "g")],
	["hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
	["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g],
	["number", /(?:#|PR ?|issue ?)\d{2,6}\b|\bv?\d+\.\d+\.\d+(?:[-.][\w.]+)?\b|\b\d{5,}\b/g],
	["env", /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/g],
	["ident", /\b(?:[a-z]+[A-Z][A-Za-z0-9]{4,}|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){1,}|[a-z][a-z0-9]*(?:[_-][a-z0-9]+){2,})\b/g],
];
const STOP = new Set(`package.json README.md AGENTS.md CLAUDE.md tsconfig.json node_modules .gitignore bun.lock index.ts index.js SKILL.md CHANGELOG.md LICENSE Makefile /dev/null /tmp /usr/bin /usr/local/bin origin/main HEAD~1 localhost 127.0.0.1 utf-8 utf8 application/json camelCase snake_case kebab-case`.split(/\s+/));

interface Candidate extends Literal { useLine: number; preLine?: number }
/** 机械候选：动作里用（调用参数）优先、用得多优先、历史里出现次数多（长期事实而非偶然一提）优先。 */
function literalCandidates(s: Slice): Candidate[] {
	const pre = textOf(s.pre);
	const protectedText = textOf([...s.kept, s.trigger]);
	const seq = s.post.flatMap((r) => rowParts(r).map((p) => ({ ...p, line: r._line })));
	const uses = new Map<string, { n: number; call: number; kind: string }>();
	for (const p of seq.filter((x) => x.role === "assistant"))
		for (const [kind, pat] of PATTERNS)
			for (const m of p.text.matchAll(pat)) {
				const t = m[0].replace(/[.,;:)'"`]+$/u, "");
				if (t.length < 5 || STOP.has(t)) continue;
				if (kind === "path" && !t.includes("/") && !EXT_SET.has(t.split(".").pop()!)) continue;
				if (kind === "path" && !t.includes(".") && /^[\w.]+\/[\w.]+$/u.test(t)) continue;
				const u = uses.get(t) ?? { n: 0, call: 0, kind };
				u.n++;
				if (p.kind === "call") u.call++;
				uses.set(t, u);
			}
	const found = [...uses]
		.filter(([t]) => pre.includes(t) && !protectedText.includes(t) && seq.find((p) => p.text.includes(t))?.role === "assistant")
		.map(([token, u]) => ({ token, kind: u.kind, useLine: seq.find((p) => p.text.includes(token))!.line, n: u.n, call: u.call, preCount: pre.split(token).length - 1, preLine: s.pre.find((r) => textOf([r]).includes(token))?._line }));
	const tokens = found.map((f) => f.token);
	return found.filter((f) => !tokens.some((o) => o !== f.token && o.includes(f.token)))
		.sort((a, b) => Number(b.call > 0) - Number(a.call > 0) || Math.min(b.n, 5) - Math.min(a.n, 5) || Math.min(b.preCount, 5) - Math.min(a.preCount, 5) || (a.token < b.token ? -1 : 1));
}

function ask(system: string, user: string, model: string): string {
	const run = spawnSync("pi", ["-p", "--no-session", "--no-tools", "-ne", "-ns", "-nc", "--no-mcp", "--offline", "--model", model, "--thinking", "off", "--system-prompt", system], { input: user, encoding: "utf8", maxBuffer: 1 << 26 });
	if (run.status !== 0) throw new Error("pi -p 失败：" + (run.stderr || run.stdout).slice(0, 300));
	return run.stdout;
}
function parseJson(s: string): any {
	const t = s.trim().replace(/^```\w*\n/u, "").replace(/\n```$/u, "");
	return JSON.parse(t.slice(Math.min(...["[", "{"].map((c) => (t.includes(c) ? t.indexOf(c) : Infinity)))));
}
const around = (s: string, t: string, w = 70) => { const i = s.indexOf(t); return s.slice(Math.max(0, i - w), i + t.length + w).replace(/\n/gu, " "); };

const FILTER_SYS = `下面是某 agent 会话在一次压缩点之后用到的字面量候选（路径、哈希、编号、标识符等），每条给出它被用到时的上下文(USE)和它在压缩点之前出现的上下文(PRE)。
勾选标准：它是这个项目或这次任务特有的具体事实，后续工作需要精确记住（具体文件路径、分支名、PR/工单号、提交哈希、专有标识符、环境变量、具体目录）。
不勾：通用工具/标准名（如 package.json、常见命令参数）、被截断的路径碎片或多余前后缀、把几个词用斜杠连起来的非路径（如 read/edit/write）、只是示例或在文字里随口一提、不构成需要记住的事实的。
只输出 JSON：{"keep":[编号,...]}，按重要性从高到低，至多 20 个。`;

const PASTE = "用户粘贴的原文";
const USER_CATS = ["过程要求", "范围禁令", "决定与被否决的方案", "未完成事项与未答复的请求", PASTE];
const USER_SYS = `你在为“上下文压缩摘要”的评测制作标准答案。输入分两部分：
PRE：压缩点之前用户发过的消息（带 [L行号]）。压缩后，这些消息会被摘要取代。
POST：压缩点之后 agent 的行为精简记录（带 [L行号]；A=助手文字，C=工具调用开头）。
找出 PRE 里用户消息中、POST 里 agent 的行为仍然依赖的内容（遵守、延续、引用或在其基础上继续），分五类：
过程要求（用户要求怎么做事：流程、顺序、验证方式、风格）；范围禁令（用户限定不许做/不许碰/不要扩大的范围）；决定与被否决的方案（用户拍板的取舍，或明确否决的做法）；未完成事项与未答复的请求（用户提了、尚未完成或回答的）；用户粘贴的原文（用户贴进来的日志、报错、数据、长引文，后面还要对照）。
每条输出：category（上面五类之一）、detail（一句话自含描述）、quote（从那条用户消息里原样摘出的一段，8~60 个字符，能唯一标识这条）、pre_line（该用户消息的 L 行号）、evidence_line（POST 里体现依赖的 L 行号）。
至多 6 条，按“丢了会让后续出错或返工”排序；POST 里看不出依赖的不要凑数；没有就返回 []。只输出 JSON 数组。`;

function userItems(s: Slice, model: string): UserItem[] {
	const users = s.pre.filter((r) => rowParts(r)[0]?.role === "user").map((r) => [r._line, textOf([r])] as const);
	if (!users.length || s.post.length < 3) return [];
	const cap = Math.max(300, Math.min(1500, Math.floor(8000 / users.length)));
	const post = s.post.flatMap((r) => rowParts(r).flatMap((p) =>
		p.role === "assistant" && p.kind === "text" ? [`[L${r._line}] A: ${p.text.slice(0, 220)}`]
		: p.role === "assistant" && p.kind === "call" ? [`[L${r._line}] C: ${p.text.slice(0, 110)}`]
		: p.role === "user" ? [`[L${r._line}] USER: ${p.text.slice(0, 220)}`] : []));
	const stride = Math.max(1, Math.ceil(post.join("\n").length / 9000));
	const prompt = `PRE:\n${users.map(([l, t]) => `[L${l}] ${t.slice(0, cap)}${t.length > cap ? "…" : ""}`).join("\n")}\n\nPOST:\n${post.filter((_, i) => i % stride === 0).join("\n")}`;
	const protectedText = textOf([...s.kept, s.trigger]);
	const lines = new Set(s.post.map((r) => r._line));
	const byLine = new Map(users);
	const ok = (parseJson(ask(USER_SYS, prompt, model)) as any[]).filter((it) =>
		USER_CATS.includes(it.category) && byLine.get(it.pre_line)?.includes(it.quote) && !protectedText.includes(it.quote) && lines.has(it.evidence_line));
	// 每点至多 2 条（类别尽量不同）；粘贴原文样本稀少，全收。
	const picked: typeof ok = [];
	for (const cat of USER_CATS.filter((c) => c !== PASTE)) {
		const hit = ok.find((o) => o.category === cat);
		if (hit && picked.length < 2) picked.push(hit);
	}
	return [...picked, ...ok.filter((o) => o.category === PASTE)].map((o) => ({ cat: o.category, detail: o.detail, quote: o.quote }));
}

function buildTruth(point: Point, firstKept: string, model: string): Truth {
	const s = slice(point, firstKept);
	const cands = literalCandidates(s).slice(0, 45);
	const post = new Map(s.post.map((r) => [r._line, r]));
	const pre = new Map(s.pre.map((r) => [r._line, r]));
	const lineText = (rows: Map<number, Row>, line?: number) => (line !== undefined && rows.has(line) ? textOf([rows.get(line)!]) : "");
	let literals: Literal[] = [];
	if (cands.length) {
		const blocks = cands.map((c, n) => `#${n} ${c.token}\n  USE: ${around(lineText(post, c.useLine), c.token)}\n  PRE: ${around(lineText(pre, c.preLine), c.token)}`);
		const keep: unknown[] = parseJson(ask(FILTER_SYS, blocks.join("\n"), model)).keep;
		literals = keep.flatMap((i) => (typeof i === "number" && cands[i] ? [{ token: cands[i]!.token, kind: cands[i]!.kind }] : []));
	}
	return { literals, items: userItems(s, model) };
}

// ───────────── 判分 ─────────────

const bodyOf = (summary: string) => { const m = /\n*<(read-files|modified-files)>/u.exec(summary); return m ? summary.slice(0, m.index) : summary; };
const GENERIC_BASE = new Set(["README.md", "report.md", "SKILL.md", "AGENTS.md", "config.jsonc", "settings.json", "models.json", "index.ts"]);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function literalVerdict(l: Literal, s: string): Verdict {
	const t = l.token;
	const home = "/Users/sugeh/";
	if ([t, t.startsWith("~/") ? home + t.slice(2) : t, t.startsWith(home) ? "~/" + t.slice(home.length) : t].some((f) => s.includes(f))) return "K";
	if (l.kind === "path") {
		const segs = t.replace(/^\/|\/$/gu, "").split("/").filter(Boolean);
		const base = segs.at(-1) ?? t;
		if (segs.length >= 2 && s.includes(segs.slice(-2).join("/"))) return "R";
		return !GENERIC_BASE.has(base) && base.length >= 8 && s.includes(base) ? "R" : "L";
	}
	if (l.kind === "hash") return t.length > 7 && s.includes(t.slice(0, 7)) ? "R" : "L";
	if (l.kind === "number") return new RegExp(String.raw`(?<![\w.])${escapeRe(t.replace(/^#|^PR |^issue /u, ""))}(?![\w])`).test(s) ? "R" : "L";
	const squash = (x: string) => x.toLowerCase().replace(/[_\-\s]/gu, "");
	return squash(s).includes(squash(t)) ? "R" : "L";
}

const grams = (s: string) => { const t = s.toLowerCase().replace(/\s+/gu, ""); return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2))); };
/** 摘要里与细节最相关的 230 字窗口（字二元组 idf）覆盖了细节二元组的多少。 */
function windowCover(item: UserItem, body: string): number {
	const chunks = body.split(/\n{2,}/u).flatMap((p) => p.length <= 230 ? [p] : Array.from({ length: Math.max(1, Math.ceil((p.length - 100) / 160)) }, (_, i) => p.slice(i * 160, i * 160 + 230)));
	const gs = chunks.map(grams);
	const df = new Map<string, number>();
	for (const g of gs) for (const x of g) df.set(x, (df.get(x) ?? 0) + 1);
	const idf = (x: string) => (df.has(x) ? Math.log(1 + (chunks.length || 1) / df.get(x)!) : 1);
	const q = [...grams(item.detail + " " + item.quote)];
	let best = -1, bestScore = 0;
	gs.forEach((g, i) => {
		const score = q.filter((x) => g.has(x)).reduce((sum, x) => sum + idf(x), 0) / Math.sqrt(g.size + 20);
		if (score > bestScore) { bestScore = score; best = i; }
	});
	if (best < 0) return 0;
	return q.filter((x) => gs[best]!.has(x)).reduce((sum, x) => sum + idf(x), 0) / q.reduce((sum, x) => sum + idf(x), 0);
}
const itemVerdict = (item: UserItem, body: string): Verdict =>
	item.quote && body.replace(/\s/gu, "").includes(item.quote.replace(/\s/gu, "")) ? "K" : windowCover(item, body) >= R_THRESHOLD ? "R" : "L";

type Count = [kept: number, total: number];
const retained = (vs: Verdict[]): Count => [vs.filter((v) => v !== "L").length, vs.length];
const add = (a: Count, b: Count): Count => [a[0] + b[0], a[1] + b[1]];
const pct = ([k, n]: Count) => (n ? (100 * k) / n : NaN);

/** 一份摘要（一个变体）在全部时点上的保住数；点平均要逐点算，一并带出。 */
function scoreCopy(variant: string, points: Point[]): { lit: Count; user: Count; perPoint: number[] } {
	let lit: Count = [0, 0], user: Count = [0, 0];
	const perPoint: number[] = [];
	for (const p of points) {
		const e = compactionOf(variant, p.id);
		const gt = join(GT_DIR, p.id + ".json");
		if (!e) throw new Error(`${variant}/${p.id} 没有压缩结果，先 replay.ts compact`);
		if (!existsSync(gt)) throw new Error(`${p.id} 没有标准答案，先 detail.ts gt`);
		const truth: Truth = JSON.parse(readFileSync(gt, "utf8"));
		const body = bodyOf(e.summary);
		const l = retained(truth.literals.map((x) => literalVerdict(x, body)));
		const u = retained(truth.items.map((x) => itemVerdict(x, body)));
		lit = add(lit, l);
		user = add(user, u);
		if (l[1] + u[1]) perPoint.push(pct(add(l, u)));
	}
	return { lit, user, perPoint };
}

const range = (xs: number[]) => `${Math.min(...xs).toFixed(0)}%~${Math.max(...xs).toFixed(0)}%`;
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function scoreCommand(groups: string[]): void {
	const points = loadPoints();
	const scored = groups.map((g) => {
		const [name, list] = g.split("=");
		const copies = (parseList(list) ?? []).map((v) => scoreCopy(v, points));
		if (!name || !copies.length) throw new Error("用法：<名>=<变体[,变体…]>");
		return { name, n: copies.length, pooled: copies.map((c) => pct(add(c.lit, c.user))), lit: copies.map((c) => pct(c.lit)), user: copies.map((c) => pct(c.user)), pointMean: copies.map((c) => mean(c.perPoint)) };
	});
	console.log("| 配置 | 份数 | 全部细节（条目池） | 点平均 | 字面量 | 用户侧 |\n|---|---|---|---|---|---|");
	for (const g of scored) console.log(`| ${g.name} | ${g.n} | ${mean(g.pooled).toFixed(0)}%（${range(g.pooled)}） | ${mean(g.pointMean).toFixed(0)}% | ${mean(g.lit).toFixed(0)}%（${range(g.lit)}） | ${mean(g.user).toFixed(0)}% |`);
	const [base, ...rest] = scored;
	if (!rest.length) return;
	console.log("\n| 对比（条目池，点） | 差 | 对照份间极差 | 该组份间极差 | 判定 |\n|---|---|---|---|---|");
	for (const g of rest) {
		const diff = mean(g.pooled) - mean(base!.pooled);
		const noise = Math.max(spread(base!.pooled), spread(g.pooled));
		const verdict = diff >= WIN_POINTS && diff > noise ? "有效" : -diff >= WIN_POINTS && -diff > noise ? "更差" : "无效";
		console.log(`| ${g.name} vs ${base!.name} | ${diff >= 0 ? "+" : ""}${diff.toFixed(1)} | ${spread(base!.pooled).toFixed(1)} | ${spread(g.pooled).toFixed(1)} | ${verdict} |`);
	}
}

// ───────────── 入口 ─────────────

const { values, positionals } = parseArgs({ allowPositionals: true, options: { points: { type: "string" }, model: { type: "string", default: JUDGE_MODEL } } });
const [command, ...args] = positionals;
if (command === "gt") {
	mkdirSync(GT_DIR, { recursive: true });
	const wanted = parseList(values.points);
	const variants = existsSync(join(ROOT, "runs")) ? readdirSync(join(ROOT, "runs")) : [];
	for (const p of loadPoints().filter((x) => !wanted || wanted.includes(x.id))) {
		const file = join(GT_DIR, p.id + ".json");
		if (existsSync(file)) continue;
		// 切点（保留段起点）取任一份已压缩摘要的记录：同一时点同一保留规则，不随摘要模型变。
		const entry = variants.map((v) => compactionOf(v, p.id)).find(Boolean);
		if (!entry) throw new Error(`${p.id} 还没有任何压缩结果，先 replay.ts compact`);
		const truth = buildTruth(p, entry.firstKeptEntryId, values.model!);
		writeFileSync(file, JSON.stringify(truth, null, 1));
		console.error(`${p.id} 字面量 ${truth.literals.length} 用户侧 ${truth.items.length}`);
	}
} else if (command === "score") {
	scoreCommand(args);
} else {
	throw new Error("用法见文件头注释");
}
