/** 审查者：进程内 memory 会话 + PASS/FAIL 输出契约解析。 */
import { DECISIONS_HEADING, fieldLine, msg, SUGGESTIONS_HEADING, termPattern, type Terms } from "./messages.js";
import type { PromptLayers } from "./prompt.js";
import type { ReviewerResult } from "./state.js";
import { runReviewSession, type ReviewModelConfig, type ReviewSessionResult } from "./session.js";
import type { InProcessSessionPool } from "../spawn.js";
import { verdictWord } from "./verdict.js";

interface RunReviewerOptions {
	index: number;
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
	pool: InProcessSessionPool;
	/** 同一场审查里该席位最近一次给出结论的模型（缺席的轮不算）：本轮从它在链里的位置审起。 */
	lastVoter?: string;
}

type ParseOutcome = Pick<ReviewerResult, "status" | "summary" | "details" | "retry">;

/**
 * 运行一个席位的审查并解析输出。模型调用失败由统一路由在会话内沿链续跑；输出格式无效是模型自身的毛病，
 * 路由看不到，就在这里用链里的下一个模型重开一场审查（同一轮），整条链都无效或会话故障才记 error（缺席），
 * 并列出每个模型各自的问题。同一场审查记住换上的模型：链轮转成从该席位最近一次给出结论的模型起跑（中间轮缺席也不丢），不再每轮先等首选失败
 * （路由的冷却只覆盖调用失败，格式无效的首选会被每轮重跑）；前段轮转到末尾而不截掉，投票模型此刻失效时，
 * 已恢复的首选仍能兜底。新一场审查没有上一轮，从链首开始。
 */
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const chain = options.config.models;
	const invalid: string[] = [];
	const start = Math.max(0, options.lastVoter ? await chainIndex(options.pool, chain, options.lastVoter) : 0);
	for (let models = [...chain.slice(start), ...chain.slice(0, start)]; ;) {
		const result = await runReviewSession(options.pool, {
			config: { ...options.config, models },
			prompt: options.prompt,
			cwd: options.cwd,
			signal: options.signal,
		});
		if (result.kind !== "output") {
			const failure = processFailure(result);
			return { index: options.index, ...models[0], ...failure, details: [...invalid, failure.details].filter(Boolean).join("\n") };
		}
		const parsed = parseReviewOutput(result.text);
		const rest = parsed.status === "error" ? await chainAfter(options.pool, models, result.atom.model) : [];
		if (rest.length === 0) {
			const fallback = !(await options.pool.isChainHead(chain, result.atom.model));
			const details = invalid.length ? [...invalid, msg.reviewer.attempt(result.atom.model, parsed.details)].join("\n") : parsed.details;
			return { index: options.index, ...result.atom, ...(fallback ? { fallback } : {}), ...parsed, ...(parsed.status === "error" ? { details } : {}) };
		}
		invalid.push(msg.reviewer.attempt(result.atom.model, parsed.details));
		models = rest;
	}
}

/** model 所属原子在链里的位置，不在链里为 -1；model 是路由解析出的具体模型，原子可能只写了模型名。 */
async function chainIndex(pool: InProcessSessionPool, chain: RunReviewerOptions["config"]["models"], model: string) {
	for (let index = 0; index < chain.length; index += 1)
		if (await pool.isChainHead(chain.slice(index), model)) return index;
	return -1;
}

/** 链里排在 model 所属原子之后的部分。 */
async function chainAfter(pool: InProcessSessionPool, chain: RunReviewerOptions["config"]["models"], model: string) {
	const index = await chainIndex(pool, chain, model);
	return index < 0 ? [] : chain.slice(index + 1);
}

/**
 * 阻塞门槛：频率×影响 ≥ score，或频率 ≥ 1 且影响 ≥ impact。审查者只给每条发现写发生条件与两个分数，
 * 是否阻塞、整票通过与否都只由这里按数字算出（审查者自己写的 PASS/FAIL 不算数）；提示词里的门槛数字也取自这里。
 */
export const BLOCKING = { score: 20, impact: 8 } as const;

export function blocks(frequency: number, impact: number): boolean {
	return frequency * impact >= BLOCKING.score || (frequency >= 1 && impact >= BLOCKING.impact);
}

/**
 * 解析审查者文本输出：摘要行 + 证据锚点行，之后是发现、需用户裁决与建议区。
 * 过门槛的发现是阻断意见：格式不全也按未通过计（违例说明作前注），丢掉会让另一票的 PASS 翻盘；
 * 门槛以下的发现收成建议区的一行。没有过门槛的发现时，缺摘要或证据锚点的票作废为缺席。
 */
function parseReviewOutput(text: string): ParseOutcome {
	const lines = text.trim().split(/\r?\n/u);
	// 模型常顺手写判定词；结论只由打分推出，这行丢掉。
	if (["pass", "fail"].includes(verdictWord(lines[0] ?? ""))) lines.shift();
	const report = splitReport(lines);
	const scored = report.findings.map(scoreFinding);
	const blocking = scored.filter((finding) => finding.blocking);
	const suggestions = [...scored.filter((finding) => !finding.blocking).map(demoted), ...report.suggestions];
	const head = report.head.join("\n").trim();
	const details = [
		head,
		...blocking.map((finding) => finding.text),
		...(report.decisions.length ? [`## ${msg.terms.decisions}\n${report.decisions.join("\n")}`] : []),
		...(suggestions.length ? [`## ${msg.terms.suggestions}\n${suggestions.map((item) => (/^[-*+]\s/u.test(item) ? item : `- ${item}`)).join("\n")}`] : []),
	].filter(Boolean).join("\n\n");
	const anchorIssue = headIssue(report.head);
	if (blocking.length > 0) {
		const issue = anchorIssue ?? blocking.map((finding, index) => finding.missing.length ? msg.reviewer.missingFields(index + 1, finding.missing) : undefined).find(Boolean);
		return { status: "failed", summary: firstIssue(blocking.map((finding) => finding.text).join("\n")), details: issue ? `${msg.reviewer.failFormatNote(issue)}\n\n${details}` : details };
	}
	if (anchorIssue) return contractViolation(anchorIssue);
	return { status: "passed", summary: firstSummary(head)!, details };
}

function processFailure(result: Exclude<ReviewSessionResult, { kind: "output" }>): ParseOutcome {
	const details =
		result.kind === "aborted" ? ""
		: result.kind === "timeout" ? msg.reviewer.timeout
		: result.kind === "error" ? msg.reviewer.sessionFailed(result.message)
		: msg.reviewer.emptyOutput;
	return { status: "error", summary: "", details, ...(result.kind === "error" && result.retry ? { retry: result.retry } : {}) };
}

/** 输出契约违例：该票作废记为缺席。 */
function contractViolation(issue: string): ParseOutcome {
	return { status: "error", summary: "", details: msg.reviewer.formatInvalid(issue) };
}

function tail(text: string) {
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// ---- 契约解析（纯函数）----

const EVIDENCE_LINE = fieldLine((terms) => terms.field.evidence, { bullet: false });
const FILE_SEGMENT = new RegExp(String.raw`${termPattern((terms) => terms.anchor.files)}\s*=\s*([^;；]*)`, "iu");
const COMMAND_SEGMENT = new RegExp(String.raw`${termPattern((terms) => terms.anchor.commands)}\s*=\s*([^;；]*)`, "iu");
const FILE_ANCHOR = /[\w@./-]*\w\.[a-zA-Z]\w{0,5}\b/u;
// 不能用 \b 收尾：中文不是\w，「发现 1」里「现」与空格之间不构成词边界。
const FINDING_HEADING = new RegExp(String.raw`^#{1,6}\s*${termPattern((terms) => terms.finding)}`, "u");
const FINDING_TITLE = new RegExp(String.raw`^#{1,6}\s*${termPattern((terms) => terms.finding)}\s*[\d.]*\s*[:：]?\s*`, "u");

const NON_EMPTY = String.raw`(\S.*)$`;
const FINDING_ISSUE = fieldLine((terms) => terms.field.issue, { value: "(.*)$" });

/** 发现必填字段，事实源是 `prompts/review.{zh,en}.md` 的输出契约；打分三项缺了不报格式错，按频率 0 处理。 */
const FINDING_FIELDS = (["issue", "evidence", "contract", "commands"] as const).map((key) => ({
	key,
	pick: (terms: Terms) => terms.field[key],
}));
const SCORE_FIELDS = (["condition", "frequency", "impact"] as const).map((key) => ({ key, pick: (terms: Terms) => terms.field[key] }));
type Field = { pick: (terms: Terms) => string };
const FIELD_START = new RegExp(
	String.raw`^[-*+]\s*(?:\*\*)?(?:${[...SCORE_FIELDS, ...FINDING_FIELDS].map((field) => termPattern(field.pick)).join("|")})`,
	"iu",
);

interface Report { head: string[]; findings: string[][]; decisions: string[]; suggestions: string[] }

/** 按二级标题切开：发现小节、需用户裁决与建议区（顺序不限），其余标题算所在小节的正文。 */
function splitReport(lines: string[]): Report {
	const report: Report = { head: [], findings: [], decisions: [], suggestions: [] };
	let current = report.head;
	for (const raw of lines) {
		const line = raw.trim();
		if (FINDING_HEADING.test(line)) report.findings.push((current = [line]));
		else if (DECISIONS_HEADING.test(line)) current = report.decisions;
		else if (SUGGESTIONS_HEADING.test(line)) current = report.suggestions;
		else if (current === report.decisions || current === report.suggestions) { if (line) current.push(line); }
		else current.push(raw.trimEnd());
	}
	return report;
}

interface Scored { text: string; title: string; condition: string; frequency: number; impact: number; blocking: boolean; missing: string[] }

/** 说不清发生条件、分数缺失或越界的发现按频率 0 算（不阻塞），留在建议区让人看到。 */
function scoreFinding(section: string[]): Scored {
	const condition = fieldValue(section, SCORE_FIELDS[0]!) ?? "";
	const score = (field: Field, min: number) => {
		const value = Number(/^\d+(?:\.\d+)?/u.exec(fieldValue(section, field) ?? "")?.[0] ?? NaN);
		return value >= min && value <= 10 ? value : undefined;
	};
	const impact = score(SCORE_FIELDS[2]!, 1) ?? 0;
	const frequency = condition ? score(SCORE_FIELDS[1]!, 0) ?? 0 : 0;
	return {
		text: section.join("\n").trim(),
		title: (section[0] ?? "").replace(FINDING_TITLE, "").trim(),
		condition,
		frequency,
		impact,
		blocking: blocks(frequency, impact),
		missing: FINDING_FIELDS.filter((field) => fieldValue(section, field) === undefined).map((field) => msg.terms.field[field.key]),
	};
}

function demoted(finding: Scored): string {
	return msg.reviewer.demoted(finding.title || firstIssue(finding.text), clean(finding.condition), finding.frequency, finding.impact);
}

/** 字段值：同行冒号之后，或字段名独占一行时其后到下一个字段或标题之前的第一行。 */
function fieldValue(section: readonly string[], field: Field): string | undefined {
	const full = fieldLine(field.pick, { value: NON_EMPTY });
	const tag = fieldLine(field.pick);
	for (let i = 0; i < section.length; i += 1) {
		const line = (section[i] ?? "").trim();
		const match = full.exec(line);
		if (match?.[1]) return match[1].replace(/^\*\*|\*\*$/gu, "").trim();
		if (!tag.test(line)) continue;
		for (let j = i + 1; j < section.length; j += 1) {
			const next = (section[j] ?? "").trim();
			if (FIELD_START.test(next) || /^#{1,6}\s+/u.test(next)) break;
			if (next) return next;
		}
	}
	return undefined;
}

/** 证据锚点闸门：摘要行在前，首个证据行必须同时含文件段（带扩展名）与命令段。 */
function headIssue(head: string[]): string | undefined {
	const lines = head.map((line) => line.trim()).filter(Boolean);
	const evidenceIndex = lines.findIndex((line) => EVIDENCE_LINE.test(line));
	if (evidenceIndex === -1) return msg.reviewer.noEvidence;
	if (evidenceIndex === 0) return msg.reviewer.noSummary;
	const line = lines[evidenceIndex]!;
	if (!hasFileSegment(line)) return msg.reviewer.noFiles;
	if (!hasCommandSegment(line)) return msg.reviewer.noCommands;
	return undefined;
}

function hasFileSegment(line: string) {
	const segment = FILE_SEGMENT.exec(line)?.[1];
	return Boolean(segment && FILE_ANCHOR.test(segment));
}

function hasCommandSegment(line: string) {
	return Boolean(COMMAND_SEGMENT.exec(line)?.[1]?.trim());
}

/** 汇总摘要：证据锚点行之前的首行（headIssue 已保证存在）。 */
function firstSummary(head: string) {
	return head.split(/\r?\n/u).map((line) => line.trim()).find((line) => line && !EVIDENCE_LINE.test(line));
}

/** 发现一句话问题（FAIL 卡片回顾用）：取第一条「- 问题:」行（支持同行及换行）。 */
function firstIssue(body: string) {
	const lines = body.split(/\r?\n/).map((line) => line.trim());
	for (let i = 0; i < lines.length; i += 1) {
		const match = FINDING_ISSUE.exec(lines[i] ?? "");
		if (!match) continue;
		if (match[1]?.trim()) return clean(match[1]);
		for (let j = i + 1; j < lines.length; j += 1) {
			const nextLine = lines[j] ?? "";
			if (/^[-*+]\s+/u.test(nextLine) || /^#{1,6}\s+/u.test(nextLine)) break;
			if (nextLine.trim()) return clean(nextLine);
		}
	}
	return msg.reviewer.failFallbackSummary;
}

function clean(text: string) {
	return text.replace(/`([^`]+)`/gu, "$1").trim();
}
