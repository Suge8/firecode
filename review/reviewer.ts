/** 审查者：进程内 memory 会话 + PASS/FAIL 输出契约解析。 */
import { fieldLine, msg, SUGGESTIONS_HEADING, termPattern, type Terms } from "./messages.js";
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
}

type ParseOutcome = Pick<ReviewerResult, "status" | "summary" | "details">;

/** 运行一个独立审查会话并解析输出。会话故障记为 error（缺席）。 */
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const result = await runReviewSession(options.pool, {
		config: options.config,
		prompt: options.prompt,
		cwd: options.cwd,
		signal: options.signal,
	});
	const parsed = result.kind === "output" ? parseReviewOutput(result.text) : processFailure(result);
	return { index: options.index, ...(result.kind === "output" ? result.atom : options.config.models[0]), ...parsed };
}

/**
 * 解析审查者文本输出：首行严格 PASS/FAIL。
 * 格式无效的 PASS 或首行不是判定词，该票作废为缺席；格式无效但以 FAIL 开头的票仍是未通过：
 * 它是审查者提出的阻断意见，丢掉会让另一票的 PASS 翻盘，原文随修复反馈与结果卡交给执行模型和用户。
 */
function parseReviewOutput(text: string): ParseOutcome {
	const trimmed = text.trim();
	const [firstLine = "", ...rest] = trimmed.split(/\r?\n/);
	const verdict = verdictWord(firstLine);
	const body = rest.join("\n").trim();
	if (verdict === "pass") {
		const issue = passIssue(body);
		if (issue) return contractViolation(issue);
		const summary = firstSummary(body);
		// passIssue 只保证证据行前有行，那行可能是建议区标题；没有真摘要就是契约违规，
		// 不能让 undefined 流进多模型汇总把循环撞死。
		if (!summary) return contractViolation(msg.reviewer.passNoSummary);
		return { status: "passed", summary, details: body };
	}
	if (verdict === "fail") {
		const issue = failIssue(body);
		return {
			status: "failed",
			summary: firstIssue(body),
			details: issue ? [msg.reviewer.failFormatNote(issue), body].filter(Boolean).join("\n\n") : body,
		};
	}
	return contractViolation(msg.reviewer.invalidFirstLine(tail(firstLine.trim())));
}

function processFailure(result: Exclude<ReviewSessionResult, { kind: "output" }>): ParseOutcome {
	const details =
		result.kind === "aborted" ? ""
		: result.kind === "timeout" ? msg.reviewer.timeout
		: result.kind === "error" ? msg.reviewer.sessionFailed(result.message)
		: msg.reviewer.emptyOutput;
	return { status: "error", summary: "", details };
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
const SUGGESTIONS_HEADING_SPLIT = new RegExp(SUGGESTIONS_HEADING.source, "imu");

const NON_EMPTY = String.raw`(\S.*)$`;
const FINDING_ISSUE = fieldLine((terms) => terms.field.issue, { value: "(.*)$" });

/**
 * 发现必填字段，事实源是 `prompts/review.{zh,en}.md` 的输出契约。
 * 只校验字段存在且非空，不校验取值；严重程度单独校验（只有高/中能阻塞）。
 */
const FINDING_FIELDS = (["issue", "evidence", "contract", "commands"] as const).map((key) => ({
	key,
	pick: (terms: Terms) => terms.field[key],
}));
type FindingField = (typeof FINDING_FIELDS)[number];
const SEVERITY_LINE = fieldLine((terms) => terms.field.severity, { value: NON_EMPTY });
/** 提示词规定阻塞发现只有高/中；低严重度必须进建议区，不得驱动修复循环。值取行内开头的词，容忍「高（理由）」「**高**」。 */
const BLOCKING_SEVERITY = new RegExp(`^(?:${termPattern((terms) => terms.high)}|${termPattern((terms) => terms.medium)})`, "iu");
const FIELD_START = new RegExp(
	String.raw`^[-*+]\s*(?:\*\*)?(?:${[(terms: Terms) => terms.field.severity, ...FINDING_FIELDS.map((field) => field.pick)].map(termPattern).join("|")})`,
	"iu",
);

/** PASS 证据锚点闸门：摘要行在前，首个证据行必须同时含文件段（带扩展名）与命令段。 */
function passIssue(body: string): string | undefined {
	const lines = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const evidenceIndex = lines.findIndex((line) => EVIDENCE_LINE.test(line));
	if (evidenceIndex === -1) return msg.reviewer.passNoEvidence;
	if (evidenceIndex === 0) return msg.reviewer.passNoSummary;
	const line = lines[evidenceIndex];
	if (!hasFileSegment(line)) return msg.reviewer.passNoFiles;
	if (!hasCommandSegment(line)) return msg.reviewer.passNoCommands;
	return undefined;
}

/**
 * FAIL 发现闸门：至少一条带「问题」的发现，且不能全落在「建议（非阻塞）」区。
 * 返回第一处违例；违例的 FAIL 仍按未通过计，原文照常交给执行模型，违例说明作为前注。
 */
function failIssue(body: string): string | undefined {
	if (!body) return msg.reviewer.failNoFinding;
	const blocking = (body.split(SUGGESTIONS_HEADING_SPLIT)[0] ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim());
	const starts = blocking
		.map((line, index) => (FINDING_HEADING.test(line) ? index : -1))
		.filter((index) => index >= 0);
	if (starts.length === 0) return msg.reviewer.failNoFinding;
	for (const [order, start] of starts.entries()) {
		const end = starts[order + 1] ?? blocking.length;
		const section = blocking.slice(start, end);
		const severity = section.map((line) => SEVERITY_LINE.exec(line)?.[1]).find((value) => value !== undefined);
		if (severity !== undefined && !BLOCKING_SEVERITY.test(severity.trim()))
			return msg.reviewer.severityNotBlocking(order + 1, severity.trim());
		const missing = [
			...(severity === undefined ? [msg.terms.field.severity] : []),
			...FINDING_FIELDS.filter((field) => !sectionHasField(section, field)).map((field) => msg.terms.field[field.key]),
		];
		if (missing.length > 0) return msg.reviewer.missingFields(order + 1, missing);
	}
	return undefined;
}

function sectionHasField(section: readonly string[], field: FindingField): boolean {
	const full = fieldLine(field.pick, { value: NON_EMPTY });
	const tag = fieldLine(field.pick);
	for (let i = 0; i < section.length; i += 1) {
		const line = section[i] ?? "";
		if (full.test(line)) return true;
		if (!tag.test(line)) continue;
		// 字段名独占一行时，值在其后的行里（直到下一个字段或标题）。
		for (let j = i + 1; j < section.length; j += 1) {
			const nextLine = (section[j] ?? "").trim();
			if (FIELD_START.test(nextLine) || /^#{1,6}\s+/u.test(nextLine)) break;
			if (nextLine) return true;
		}
	}
	return false;
}

function hasFileSegment(line: string) {
	const segment = FILE_SEGMENT.exec(line)?.[1];
	return Boolean(segment && FILE_ANCHOR.test(segment));
}

function hasCommandSegment(line: string) {
	return Boolean(COMMAND_SEGMENT.exec(line)?.[1]?.trim());
}

/** 汇总摘要：剥离证据锚点行与建议区后的首行。 */
function firstSummary(body: string) {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !EVIDENCE_LINE.test(line) && !SUGGESTIONS_HEADING.test(line))[0];
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
