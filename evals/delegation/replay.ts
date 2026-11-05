#!/usr/bin/env bun
// 真实会话重放：从本机主会话（$PI_CODING_AGENT_DIR/sessions，默认 ~/.pi/agent/sessions）截取指挥官要做下一步决定的时点，
// 把那一刻之前的分支复制进隔离目录再打开，让变体的指挥官接着跑，只记第一个动作（第一条助手消息）。
//   bun replay.ts scan [--max-tokens 120000]                          候选时点 → $EVAL_DIR/replay/candidates.json
//   bun replay.ts pick [--count 20]                                   按项目 × 时点类型分层抽取 → points.json
//   bun replay.ts run <变体> [--runs 2] [--concurrency 3] [--budget 30] [--timeout 300] [--points id,…] [--force]
//   bun replay.ts report <变体>[,<变体>…]
// 时点两类：event = 子代理事件送达后的下一步（探针重发那条 firecode-master-event，自定义消息 + triggerTurn，与生产投递同一路径）；
// user = 用户新需求到达后的第一步（RPC prompt 发原话与图片）。
// 被重放的会话属于有生产权限的项目：探针拦下每个工具调用不执行，第一条助手消息一结束就杀进程；动作按参数静态分类，
// codemode 只看脚本里调了哪些 tools.*（循环里的一次调用只计一次）。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { killTree, onJsonLines, parseList, pool, readJsonl, startPi, USER_AGENT_DIR, variantAgent, WORK } from "./lib.ts";

const ROOT = join(WORK, "replay");
const SESSIONS = join(USER_AGENT_DIR, "sessions");
const PROBE = join(import.meta.dir, "replay-probe.ts");
const EVENT_TYPE = "firecode-master-event";
const PENDING_TYPE = "firecode-master-pending-event";
const ACK_TYPE = "firecode-master-event-ack";
const CHECKPOINT_TYPE = "firecode-review-checkpoint";
/** 审查停在这些相时重开会话会自动续审，审查会话不带探针、工具真会执行，所以这类时点不收。 */
const REVIEW_IDLE = new Set(["idle", "settled"]);
const HAND_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const PROJECTS: Array<[RegExp, string]> = [[/\/Project\/CuePad(\/|$)/u, "CuePad"], [/yuanzhuoai|\/yz-/u, "yuanzhuoai"], [/\/firecode/u, "firecode"]];

type Kind = "event" | "user";
interface Point {
	id: string;
	project: string;
	kind: Kind;
	file: string;
	/** 截取点：event 是那条 custom_message，user 是那条用户消息；前缀是它父条目的整条分支。 */
	entryId: string;
	cwd: string;
	provider: string;
	model: string;
	thinking?: string;
	tokens: number;
	time: string;
	summary: string;
	/** 原会话里的那条回应。动作只存原始调用、读时再分类：改了分类规则重打报表即可，不用重跑。 */
	original: Reply;
}
/** 第一条助手消息里分类要用的部分。 */
interface Reply {
	stopReason: string;
	errorMessage?: string;
	toolCalls: Array<{ name: string; arguments: any }>;
}
interface Call {
	tool: string;
	action?: string;
	role?: string;
	review?: boolean;
}
type ActionKind = "rest" | "start" | "send" | "hand" | "other" | "error";
interface Action {
	kind: ActionKind;
	label: string;
	calls: Call[];
}
interface Result {
	point: string;
	variant: string;
	run: number;
	reply?: Reply;
	reason: string;
	cost: number;
	sec: number;
	blocked: number;
}

// ───────────── 动作分类 ─────────────

/** 跳过从 i 起的字符串字面量（含模板里的 \${…}），返回其后位置。 */
function skipString(s: string, i: number): number {
	const quote = s[i];
	for (let j = i + 1; j < s.length; j++) {
		if (s[j] === "\\") j++;
		else if (s[j] === quote) return j + 1;
		else if (quote === "\x60" && s[j] === "$" && s[j + 1] === "{") j = skipBalanced(s, j + 1) - 1;
	}
	return s.length;
}

function skipComment(s: string, i: number): number | undefined {
	if (s[i] !== "/") return undefined;
	if (s[i + 1] === "/") return (s.indexOf("\n", i) + 1 || s.length);
	if (s[i + 1] === "*") return (s.indexOf("*/", i + 2) + 2 || s.length);
	return undefined;
}

/** 从开括号 i 起跳到配对的闭括号之后。 */
function skipBalanced(s: string, i: number): number {
	let depth = 0;
	for (let j = i; j < s.length; ) {
		const c = s[j];
		if (c === '"' || c === "'" || c === "\x60") { j = skipString(s, j); continue; }
		const comment = skipComment(s, j);
		if (comment !== undefined) { j = comment; continue; }
		if ("{[(".includes(c)) depth++;
		else if ("}])".includes(c) && --depth === 0) return j + 1;
		j++;
	}
	return s.length;
}

/** 对象字面量（开括号在 open）顶层里值为字面量的键；其余键不收。 */
function literalProps(s: string, open: number): Record<string, string | boolean> {
	const props: Record<string, string | boolean> = {};
	const end = skipBalanced(s, open);
	const key = /([A-Za-z_$][\w$]*)\s*:\s*/uy;
	for (let j = open + 1, atKey = true; j < end - 1; ) {
		const c = s[j];
		if (atKey) {
			key.lastIndex = j;
			const m = key.exec(s);
			if (m) {
				const v = key.lastIndex;
				const q = s[v];
				if (q === '"' || q === "'" || q === "\x60") {
					const body = s.slice(v + 1, skipString(s, v) - 1);
					if (!body.includes("\${")) props[m[1]] = body;
				} else if (/^(true|false)\b/u.test(s.slice(v, v + 5))) props[m[1]] = s.startsWith("true", v);
				j = v;
				atKey = false;
				continue;
			}
		}
		if (c === '"' || c === "'" || c === "\x60") { j = skipString(s, j); atKey = false; continue; }
		const comment = skipComment(s, j);
		if (comment !== undefined) { j = comment; continue; }
		if ("{[(".includes(c)) { j = skipBalanced(s, j); atKey = false; continue; }
		if (c === ",") atKey = true;
		else if (!/\s/u.test(c)) atKey = false;
		j++;
	}
	return props;
}

/** codemode 脚本里的 tools.* 调用（字符串与注释里的不算）。 */
export function scriptCalls(code: string): Call[] {
	const calls: Call[] = [];
	const call = /tools\.(\w+)\s*\(\s*/uy;
	for (let i = 0; i < code.length; ) {
		const c = code[i];
		if (c === '"' || c === "'" || c === "\x60") { i = skipString(code, i); continue; }
		const comment = skipComment(code, i);
		if (comment !== undefined) { i = comment; continue; }
		call.lastIndex = i;
		const m = /[\w$.]/u.test(code[i - 1] ?? "") ? null : call.exec(code);
		if (!m) { i++; continue; }
		const open = call.lastIndex;
		calls.push({ tool: m[1], ...(code[open] === "{" ? callArgs(literalProps(code, open)) : {}) });
		i = open;
	}
	return calls;
}

function callArgs(args: Record<string, unknown>): Omit<Call, "tool"> {
	return {
		...(typeof args.action === "string" ? { action: args.action } : {}),
		...(typeof args.role === "string" ? { role: args.role } : {}),
		...(args.review === true ? { review: true } : {}),
	};
}

function toReply(message: any): Reply {
	const toolCalls = (message.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ name: c.name, arguments: c.arguments }));
	return { stopReason: message.stopReason, ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}), toolCalls };
}

/**
 * 一条消息里有多个调用时按决策分量取一类：start > send > review > 亲手读改 > 其他 > 歇着。
 * review 是指挥官的送审决定，与旁边顺手的读取同条时算 review；kill、ack、list、tail 是收拾与查看，旁边有读改就算亲手。
 */
export function classify(reply: Reply | undefined): Action {
	if (!reply) return { kind: "error", label: "无回复", calls: [] };
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return { kind: "error", label: "出错", calls: [] };
	const calls = reply.toolCalls.flatMap((c): Call[] => {
		if (c.name === "codemode") {
			const nested = scriptCalls(String(c.arguments?.code ?? ""));
			return nested.length ? nested : [{ tool: "codemode" }];
		}
		return [{ tool: c.name, ...callArgs(c.arguments ?? {}) }];
	});
	const starts = calls.filter((c) => c.tool === "subagents" && c.action === "start");
	if (starts.length) {
		const roles = [...new Set(starts.map((c) => c.role ?? "?"))].join("/");
		return { kind: "start", label: "start×" + starts.length + " " + roles + (starts.some((c) => c.review) ? " 审" : ""), calls };
	}
	if (calls.some((c) => c.tool === "subagents" && c.action === "send")) return { kind: "send", label: "send", calls };
	if (calls.some((c) => c.tool === "subagents" && c.action === "review")) return { kind: "other", label: "其他(review)", calls };
	if (calls.some((c) => HAND_TOOLS.has(c.tool))) {
		return { kind: "hand", label: calls.some((c) => c.tool === "edit" || c.tool === "write") ? "亲手改" : "亲手读", calls };
	}
	if (calls.length) {
		const names = [...new Set(calls.map((c) => c.tool + (c.action ? "." + c.action : "")))].join(",");
		return { kind: "other", label: "其他(" + names + ")", calls };
	}
	return { kind: "rest", label: "歇着", calls };
}

// ───────────── 候选时点 ─────────────

function projectOf(cwd: string): string | undefined {
	return PROJECTS.find(([pattern]) => pattern.test(cwd))?.[1];
}

const modelTable = (): any => JSON.parse(readFileSync(join(USER_AGENT_DIR, "models.json"), "utf8"));

/** 供应商在本机时的端口：沙箱据此只放行这一个端口。 */
function localPort(provider: string): number | undefined {
	const base = modelTable().providers?.[provider]?.baseUrl;
	if (!base) return undefined;
	const url = new URL(base);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return undefined;
	return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** 模型表里有的 provider/model：时点的原模型不在表里就重放不了。 */
function availableModels(): Set<string> {
	return new Set(Object.entries<any>(modelTable().providers ?? {}).flatMap(([provider, p]) => (p.models ?? []).map((m: any) => provider + "/" + m.id)));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : "";
}

/** 不进模型上下文的条目：沿原回复链往下找时跳过。 */
const passive = (e: any): boolean => (e.type === "message" ? e.message.role === "system" : e.type !== "custom_message");

class SessionFile {
	readonly entries: any[];
	readonly byId = new Map<string, any>();
	readonly children = new Map<string, any[]>();
	constructor(readonly path: string) {
		this.entries = readJsonl(path);
		for (const e of this.entries) {
			if (!e.id) continue;
			this.byId.set(e.id, e);
			const siblings = this.children.get(e.parentId) ?? [];
			siblings.push(e);
			this.children.set(e.parentId, siblings);
		}
	}
	get header(): any {
		return this.entries[0];
	}
	/** 从根到 id 的整条分支（含 id）。 */
	branch(id: string | null): any[] {
		const chain: any[] = [];
		for (let e = id ? this.byId.get(id) : undefined; e; e = e.parentId ? this.byId.get(e.parentId) : undefined) chain.push(e);
		return chain.reverse();
	}
	/** 原会话里对这个时点的直接回应：沿子条目跳过系统提示补丁等不进上下文的条目，第一条助手消息。 */
	response(id: string): any | undefined {
		for (let e = this.children.get(id)?.[0]; e; e = this.children.get(e.id)?.[0]) {
			if (e.type === "message" && e.message.role === "assistant") return e;
			if (!passive(e)) return undefined;
		}
		return undefined;
	}
}

const sessionCache = new Map<string, SessionFile>();
function session(path: string): SessionFile {
	let file = sessionCache.get(path);
	if (!file) sessionCache.set(path, (file = new SessionFile(path)));
	return file;
}

function masterActive(branch: any[]): boolean {
	let section: unknown;
	let tools = new Set<string>();
	for (const e of branch) {
		if (e.type !== "message" || e.message.role !== "system") continue;
		if (e.message.sections && "firecode_master" in e.message.sections) section = e.message.sections.firecode_master;
		for (const t of e.message.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of e.message.toolsAdded ?? []) tools.add(t.name);
	}
	return typeof section === "string" && section.length > 0 && tools.has("subagents");
}

function reviewIdle(branch: any[]): boolean {
	const checkpoint = branch.findLast((e) => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
	return !checkpoint || REVIEW_IDLE.has(checkpoint.data?.phase);
}

function scanFile(path: string, maxTokens: number, models: Set<string>): Point[] {
	const file = session(path);
	const cwd: string = file.header?.cwd ?? "";
	const project = projectOf(cwd);
	if (!project || !existsSync(cwd)) return [];
	const points: Point[] = [];
	for (const e of file.entries) {
		const kind: Kind | undefined = e.type === "custom_message" && e.customType === EVENT_TYPE ? "event"
			: e.type === "message" && e.message.role === "user" ? "user" : undefined;
		if (!kind) continue;
		const text = textOf(kind === "event" ? e.content : e.message.content);
		if (kind === "user" && (!text.trim() || text.trimStart().startsWith("/"))) continue;
		const reply = file.response(e.id);
		if (!reply || reply.message.stopReason === "error" || reply.message.stopReason === "aborted") continue;
		const upToReply = file.branch(reply.id);
		if (!masterActive(upToReply)) continue;
		const prefix = file.branch(e.parentId);
		if (!reviewIdle(prefix)) continue;
		// 中断的助手消息 usage 记 0，取最后一条有用量的。
		const tokens = prefix.findLast((x) => x.type === "message" && x.message.role === "assistant" && x.message.usage?.totalTokens > 0)?.message.usage.totalTokens ?? 0;
		if (tokens > maxTokens) continue;
		const { provider, model } = reply.message;
		if (!models.has(provider + "/" + model)) continue;
		const thinking = upToReply.findLast((x) => x.type === "thinking_level_change")?.thinkingLevel;
		points.push({
			id: project + "-" + kind + "-" + basename(path).slice(-14, -6) + "-" + e.id,
			project, kind, file: path, entryId: e.id, cwd, provider, model, ...(thinking ? { thinking } : {}), tokens,
			time: e.timestamp, summary: text.replace(/\s+/gu, " ").replace(/<\/?firecode_master_event>/gu, "").trim().slice(0, 60),
			original: toReply(reply.message),
		});
	}
	return points;
}

function scan(maxTokens: number): Point[] {
	const models = availableModels();
	const files = readdirSync(SESSIONS).flatMap((dir) => {
		const full = join(SESSIONS, dir);
		try {
			return readdirSync(full).filter((name) => name.endsWith(".jsonl")).map((name) => join(full, name));
		} catch {
			return [];
		}
	});
	return files.flatMap((path) => scanFile(path, maxTokens, models)).sort((a, b) => a.time.localeCompare(b.time));
}

/** 每个（项目, 类型）组按原始动作分桶轮流取，桶内按时间均匀取；组的名额平均分，不够的让给别组。 */
function pick(candidates: Point[], count: number): Point[] {
	const groups = new Map<string, Point[]>();
	for (const p of candidates) groups.set(p.project + "/" + p.kind, [...(groups.get(p.project + "/" + p.kind) ?? []), p]);
	const quota = new Map([...groups.keys()].map((k) => [k, 0]));
	for (let left = Math.min(count, candidates.length); left > 0; ) {
		for (const [k, ps] of [...groups].sort((a, b) => a[1].length - b[1].length)) {
			if (left > 0 && quota.get(k)! < ps.length) { quota.set(k, quota.get(k)! + 1); left--; }
		}
	}
	return [...groups].flatMap(([k, ps]) => {
		const buckets = new Map<string, Point[]>();
		for (const p of ps) buckets.set(classify(p.original).kind, [...(buckets.get(classify(p.original).kind) ?? []), p]);
		const take = new Map([...buckets.keys()].map((b) => [b, 0]));
		for (let left = quota.get(k)!; left > 0; ) {
			for (const [b, bs] of buckets) if (left > 0 && take.get(b)! < bs.length) { take.set(b, take.get(b)! + 1); left--; }
		}
		return [...buckets].flatMap(([b, bs]) => {
			const n = take.get(b)!;
			return Array.from({ length: n }, (_, i) => bs[Math.floor(((i + 0.5) * bs.length) / n)]!);
		});
	});
}

// ───────────── 重放 ─────────────

/** 前缀：截取点父条目的整条分支；没确认的事件补一条 ack，免得 Master 重开会话时自己重投。 */
function writePrefix(point: Point, dest: string): any {
	const file = session(point.file);
	const branch = file.branch(file.byId.get(point.entryId).parentId);
	const acked = new Set(branch.filter((e) => e.type === "custom" && e.customType === ACK_TYPE).flatMap((e) => e.data?.ids ?? []));
	const unacked = branch.filter((e) => e.type === "custom" && e.customType === PENDING_TYPE && !acked.has(e.data?.id)).map((e) => e.data.id);
	const lines = [file.header, ...branch];
	if (unacked.length) {
		lines.push({ type: "custom", customType: ACK_TYPE, data: { ids: unacked }, id: crypto.randomUUID().slice(0, 8), parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
	}
	writeFileSync(dest, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file.byId.get(point.entryId);
}

const runDir = (variant: string, point: string, run: number) => join(ROOT, "runs", variant, point, String(run));

function replayOnce(point: Point, variant: string, run: number, timeoutSec: number): Promise<Result> {
	const dir = runDir(variant, point.id, run);
	rmSync(dir, { recursive: true, force: true });
	const tmp = join(dir, "tmp");
	mkdirSync(join(dir, "sessions"), { recursive: true });
	mkdirSync(tmp, { recursive: true });
	const sessionPath = join(dir, "sessions", basename(point.file));
	const cut = writePrefix(point, sessionPath);
	const log = join(dir, "blocked.jsonl");
	const env: Record<string, string> = { EVAL_LOG: log };
	if (point.kind === "event") {
		env.EVAL_WAKE = join(dir, "wake.json");
		writeFileSync(env.EVAL_WAKE, JSON.stringify({ customType: cut.customType, content: cut.content, display: cut.display ?? true, ...(cut.details == null ? {} : { details: cut.details }) }));
	}
	const args = ["--mode", "rpc", "--session", sessionPath, "-e", PROBE, "--provider", point.provider, "--model", point.model, ...(point.thinking ? ["--thinking", point.thinking] : [])];
	// 第二道保险：沙箱只许写本次运行目录与变体目录，网络只通本机的模型端口（见 lib.ts 的 lockdown）。
	const child = startPi(args, { agentDir: variantAgent(variant), cwd: point.cwd, tmp, stdin: "pipe", env, allow: [dir, PROBE], lockdown: { modelPort: localPort(point.provider) } });
	const t0 = Date.now();
	let cost = 0;
	let reason = "";
	let reply: Reply | undefined;
	const stderr: string[] = [];
	child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
	const finish = (why: string) => {
		if (reason) return;
		reason = why;
		clearTimeout(timer);
		killTree(child);
	};
	const timer = setTimeout(() => finish("timeout"), timeoutSec * 1000);
	onJsonLines(child, (event) => {
		if (event.type === "response" && event.success === false) finish("rpc: " + event.error);
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		cost += event.message.usage?.cost?.total ?? 0;
		reply = toReply(event.message);
		finish(classify(reply).kind === "error" ? "error: " + (reply.errorMessage ?? reply.stopReason) : "first-message");
	});
	const message = point.kind === "event" ? { type: "prompt", message: "/eval-wake" } : userPrompt(cut.message.content);
	child.stdin!.write(JSON.stringify(message) + "\n");
	return new Promise((resolve) => {
		child.on("close", (code) => {
			finish("exit " + code);
			const blocked = existsSync(log) ? readJsonl(log).length : 0;
			const result: Result = { point: point.id, variant, run, ...(reply ? { reply } : {}), reason, cost, sec: (Date.now() - t0) / 1000, blocked };
			writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
			if (!reason.startsWith("first")) writeFileSync(join(dir, "stderr.txt"), stderr.join(""));
			resolve(result);
		});
	});
}

function userPrompt(content: unknown): object {
	const images = Array.isArray(content) ? content.filter((c: any) => c.type === "image").map((c: any) => ({ type: "image", data: c.data, mimeType: c.mimeType })) : [];
	return { type: "prompt", message: textOf(content), ...(images.length ? { images } : {}) };
}

// ───────────── 报表 ─────────────

function results(variant: string): Result[] {
	const base = join(ROOT, "runs", variant);
	if (!existsSync(base)) return [];
	return readdirSync(base).flatMap((point) => readdirSync(join(base, point)).map((run) => join(base, point, run, "result.json")).filter(existsSync))
		.map((p) => JSON.parse(readFileSync(p, "utf8")));
}

const act = (r: Result): Action => classify(r.reply);
const ok = (r: Result) => act(r).kind !== "error";

function report(variants: string[], points: Point[]): void {
	const byVariant = new Map(variants.map((v) => [v, results(v)]));
	const cell = (v: string, p: Point) => byVariant.get(v)!.filter((r) => r.point === p.id).sort((a, b) => a.run - b.run).map((r) => act(r).label).join(" / ") || "—";
	console.log("| # | 项目 | 类型 | 上下文 | 时点 | 原始 | " + variants.join(" | ") + " |");
	console.log("|---|---|---|---|---|---|" + "---|".repeat(variants.length));
	points.forEach((p, i) => {
		console.log("| " + (i + 1) + " | " + p.project + " | " + p.kind + " | " + Math.round(p.tokens / 1000) + "k | " + p.summary.replaceAll("|", "\\|").slice(0, 40) + " | " + classify(p.original).label + " | " + variants.map((v) => cell(v, p)).join(" | ") + " |");
	});
	console.log("");
	for (const v of variants) {
		const rs = byVariant.get(v)!.filter((r) => points.some((p) => p.id === r.point));
		const pairs = points.map((p) => rs.filter((r) => r.point === p.id && ok(r))).filter((xs) => xs.length >= 2);
		const same = pairs.filter((xs) => xs.every((r) => act(r).label === act(xs[0]!).label)).length;
		const sameKind = pairs.filter((xs) => xs.every((r) => act(r).kind === act(xs[0]!).kind)).length;
		const matchOriginal = rs.filter((r) => ok(r) && classify(points.find((p) => p.id === r.point)!.original).kind === act(r).kind).length;
		const kinds = new Map<string, number>();
		for (const r of rs) kinds.set(act(r).kind, (kinds.get(act(r).kind) ?? 0) + 1);
		const total = rs.reduce((s, r) => s + r.cost, 0);
		console.log("**" + v + "**：" + rs.length + " 次，动作分布 " + [...kinds].map(([k, n]) => k + " " + n).join("、") +
			"；同一时点多次结果一致 " + same + "/" + pairs.length + "（只比大类 " + sameKind + "/" + pairs.length + "）；与原会话同大类 " + matchOriginal + "/" + rs.filter(ok).length +
			"；花费合计 $" + total.toFixed(2) + "，每次平均 $" + (total / Math.max(1, rs.length)).toFixed(3) + "，每次平均 " + (rs.reduce((s, r) => s + r.sec, 0) / Math.max(1, rs.length)).toFixed(0) + "s");
	}
}

// ───────────── 入口 ─────────────

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"max-tokens": { type: "string", default: "120000" }, count: { type: "string", default: "20" },
		runs: { type: "string", default: "2" }, concurrency: { type: "string", default: "3" }, budget: { type: "string", default: "30" },
		timeout: { type: "string", default: "300" }, points: { type: "string" }, force: { type: "boolean" },
	},
});
mkdirSync(ROOT, { recursive: true });
const loadPoints = (): Point[] => JSON.parse(readFileSync(join(ROOT, "points.json"), "utf8"));
const [command, arg] = positionals;

if (command === "scan") {
	const candidates = scan(Number(values["max-tokens"]));
	writeFileSync(join(ROOT, "candidates.json"), JSON.stringify(candidates, null, 1));
	const tally = new Map<string, number>();
	for (const p of candidates) {
		const key = p.project + "/" + p.kind + "/" + classify(p.original).kind;
		tally.set(key, (tally.get(key) ?? 0) + 1);
	}
	console.log(candidates.length + " 个候选 → " + join(ROOT, "candidates.json"));
	for (const [k, n] of [...tally].sort()) console.log("  " + k + " " + n);
} else if (command === "pick") {
	const picked = pick(JSON.parse(readFileSync(join(ROOT, "candidates.json"), "utf8")), Number(values.count));
	writeFileSync(join(ROOT, "points.json"), JSON.stringify(picked, null, 1));
	for (const p of picked) console.log(p.id + "  " + Math.round(p.tokens / 1000) + "k  原始 " + classify(p.original).label + "  " + p.summary);
} else if (command === "run") {
	if (!arg || !existsSync(variantAgent(arg))) throw new Error("变体 " + arg + " 不存在，先 bun variant.ts " + arg);
	const wanted = parseList(values.points);
	const budget = Number(values.budget);
	let spent = 0;
	const jobs = loadPoints().filter((p) => !wanted || wanted.includes(p.id)).map((point) => async () => {
		// 同一时点的几次顺序跑：后几次命中前一次写下的提示缓存，噪声测量不受影响、花费低得多。
		for (let run = 1; run <= Number(values.runs); run++) {
			const done = join(runDir(arg, point.id, run), "result.json");
			if (!values.force && existsSync(done) && ok(JSON.parse(readFileSync(done, "utf8")))) continue;
			if (spent >= budget) return;
			const r = await replayOnce(point, arg, run, Number(values.timeout));
			spent += r.cost;
			console.error(point.id + "#" + run + " " + act(r).label + " " + r.reason + " $" + r.cost.toFixed(3) + " " + r.sec.toFixed(0) + "s 拦下 " + r.blocked + "（本批累计 $" + spent.toFixed(2) + "）");
		}
	});
	await pool(jobs, Number(values.concurrency));
	if (spent >= budget) console.error("已到预算 $" + budget + "，余下的没跑");
	report([arg], loadPoints());
} else if (command === "report") {
	report(parseList(arg) ?? [], loadPoints());
} else {
	throw new Error("用法见文件头注释");
}
