/** 审查者：进程内 memory 会话 + PASS/FAIL 输出契约解析。 */
import type { ThinkingLevelValue } from "../config.js";
import { msg, termPattern } from "./messages.js";
import type { PromptLayers } from "./prompt.js";
import type { ReviewerResult, ReviewerStatus } from "./state.js";
import type { ReviewSessionRunner } from "./session.js";

export interface ReviewModelConfig {
	model: string;
	thinking: ThinkingLevelValue;
	tools: string[];
	timeoutMs: number;
}

export interface RunReviewerOptions {
	index: number;
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	signal?: AbortSignal;
	runSession: ReviewSessionRunner;
}

export type ParseOutcome = {
	status: Exclude<ReviewerStatus, "running">;
	summary: string;
	details: string;
};

/** 运行一个独立审查会话并解析输出。会话故障记为 error，不拖垮整轮。 */
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const result = await options.runSession({
		role: "reviewer",
		model: options.config.model,
		thinking: options.config.thinking,
		tools: options.config.tools,
		prompt: options.prompt,
		cwd: options.cwd,
		timeoutMs: options.config.timeoutMs,
		signal: options.signal,
	});
	const parsed =
		result.kind === "output"
			? parseReviewOutput(result.text)
			: processFailure(result);
	return {
		index: options.index,
		model: options.config.model,
		thinking: options.config.thinking,
		status: parsed.status,
		summary: parsed.summary,
		details: parsed.details,
	};
}

/** 解析审查者文本输出：首行严格 PASS/FAIL + 证据锚点闸门。 */
export function parseReviewOutput(text: string): ParseOutcome {
	const trimmed = text.trim();
	if (!trimmed) return invalidFormat(msg.reviewer.empty);
	const [firstLine = "", ...rest] = trimmed.split(/\r?\n/);
	const verdict = verdictOf(firstLine);
	if (verdict === "PASS") {
		const body = rest.join("\n").trim();
		const issue = passIssue(body);
		if (issue) return contractViolation(issue);
		const summary = firstSummary(body);
		// passIssue 只保证证据行前有行，那行可能是建议区标题；没有真摘要就是契约违规，
		// 不能让 undefined 流进多模型汇总把循环撞死。
		if (!summary) return contractViolation(msg.reviewer.passNoSummary);
		return { status: "passed", summary, details: body };
	}
	if (verdict === "FAIL") {
		const body = rest.join("\n").trim();
		const issue = failIssue(body);
		if (issue) return contractViolation(issue);
		return { status: "failed", summary: firstIssue(body), details: body };
	}
	return invalidFormat(firstLine.trim() || msg.reviewer.empty);
}

function processFailure(
	result: { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; message: string } | { kind: "empty" },
): ParseOutcome {
	const details =
		result.kind === "aborted" ? ""
		: result.kind === "timeout" ? msg.reviewer.timeout
		: result.kind === "error" ? msg.reviewer.sessionFailed(result.message)
		: msg.reviewer.emptyOutput;
	return { status: "error", summary: "", details };
}

/** 首行判定失败（既不是 PASS 也不是 FAIL）。 */
function invalidFormat(actual: string): ParseOutcome {
	return contractViolation(msg.reviewer.invalidFirstLine(tail(actual)));
}

/** 输出契约违例：该票作废记为基础设施错误，不拖垮整轮。 */
function contractViolation(issue: string): ParseOutcome {
	return { status: "error", summary: "", details: msg.reviewer.formatInvalid(issue) };
}

function tail(text: string) {
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// ---- 契约解析（纯函数）----

export function verdictOf(line: string): "PASS" | "FAIL" | undefined {
	const normalized = line
		.trim()
		.replace(/^\*{1,2}(.+?)\*{1,2}$/u, "$1")
		.replace(/^__([^_]+)__$/u, "$1")
		// 与 advisor 同模式：模型把判定词写成 `PASS` 时剔掉包裹的反引号，避免整票误判为格式错误。
		.replace(/^`+(.+?)`+$/u, "$1")
		.trim()
		.toUpperCase();
	return normalized === "PASS" || normalized === "FAIL" ? normalized : undefined;
}

// 字段名两种语言都认（见 messages.ts 的 terms）：会话历史可能跨语言，模型也可能不照提示词的语言写。
const EVIDENCE_LINE = new RegExp(`^(?:[-*]\\s*)?${termPattern((terms) => terms.field.evidence)}[:：]`, "u");
const FILE_SEGMENT = new RegExp(`${termPattern((terms) => terms.anchor.files)}\\s*=\\s*([^;；]*)`, "iu");
const COMMAND_SEGMENT = new RegExp(`${termPattern((terms) => terms.anchor.commands)}\\s*=\\s*([^;；]*)`, "iu");
const FILE_ANCHOR = /[\w@./-]*\w\.[a-zA-Z]\w{0,5}\b/u;
// 不能用 \b 收尾：中文不是\w，「发现 1」里「现」与空格之间不构成词边界。
const FINDING_HEADING = new RegExp(`^#{1,6}\\s*${termPattern((terms) => terms.finding)}`, "u");
const SUGGESTIONS_HEADING = new RegExp(`^##\\s+${termPattern((terms) => terms.suggestions)}\\s*$`, "iu");
const SUGGESTIONS_HEADING_SPLIT = new RegExp(SUGGESTIONS_HEADING.source, "imu");

/** 列表项「**字段名**：值」的行首；value 为空时只匹配到冒号。字段名容忍可选粗体包裹。 */
const bulletField = (label: string, value = "") =>
	new RegExp(`^[-*+]\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：]\\s*${value}`, "iu");

const FINDING_ISSUE = bulletField(termPattern((terms) => terms.field.issue), "(.*)$");

/**
 * 发现必填字段，事实源是 `prompts/review.{zh,en}.md` 的输出契约。
 * 只校验字段存在且非空，不校验取值（如严重程度写“高危”不应被判非法）。
 * extra 是旧版提示词用过的措辞：滚动开放清单里可能混有旧格式发现的复述。
 */
const FINDING_FIELDS = [
	{ key: "issue", label: termPattern((terms) => terms.field.issue) },
	{ key: "evidence", label: termPattern((terms) => terms.field.evidence) },
	{
		key: "contract",
		label: termPattern(
			(terms) => terms.field.contract,
			"违反的约定与期望",
			"违反的契约或期望行为",
			"违反的契约",
			"Violated agreement",
			"Contract or expected behavior violated",
			"Contract violated",
		),
	},
	{
		key: "commands",
		label: termPattern(
			(terms) => terms.field.commands,
			"需要运行的验证命令",
			"Verification commands",
			"Verification command to run",
			"Verification commands to run",
		),
	},
] as const;
type FindingField = (typeof FINDING_FIELDS)[number];
const SEVERITY_LABEL = termPattern((terms) => terms.field.severity);
/** 提示词规定阻塞发现只有高/中；低严重度必须进建议区，不得驱动修复循环。 */
const SEVERITY_LINE = bulletField(
	SEVERITY_LABEL,
	`(?:${termPattern((terms) => terms.high)}|${termPattern((terms) => terms.medium)})\\s*$`,
);
const FIELD_START = new RegExp(
	`^[-*+]\\s*(?:\\*\\*)?(?:${[SEVERITY_LABEL, ...FINDING_FIELDS.map((field) => field.label)].join("|")})`,
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
 * 空 FAIL 或一段散文都不能驱动执行模型改代码——格式非法的票一律作废为基础设施错误。
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
	// 每条发现都必须满足完整契约；同票混入非法发现整票作废。
	// 契约完整才能驱动自动修复：半成品票据无法核实，也无法验收。
	for (const [order, start] of starts.entries()) {
		const end = starts[order + 1] ?? blocking.length;
		const section = blocking.slice(start, end);
		const missing = [
			...(section.some((line) => SEVERITY_LINE.test(line)) ? [] : [msg.terms.field.severity]),
			...FINDING_FIELDS.filter((field) => !sectionHasField(section, field)).map((field) => msg.terms.field[field.key]),
		];
		if (missing.length > 0) return msg.reviewer.missingFields(order + 1, missing);
	}
	return undefined;
}

function sectionHasField(section: readonly string[], field: FindingField): boolean {
	const full = bulletField(field.label, "(\\S.*)$");
	const tag = bulletField(field.label);
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
		const line = lines[i] ?? "";
		const match = FINDING_ISSUE.exec(line);
		if (match) {
			if (match[1]?.trim()) return clean(match[1]);
			for (let j = i + 1; j < lines.length; j += 1) {
				const nextLine = lines[j] ?? "";
				if (/^[-*+]\s+/u.test(nextLine) || /^#{1,6}\s+/u.test(nextLine)) break;
				if (nextLine.trim()) return clean(nextLine);
			}
		}
	}
	return msg.reviewer.failFallbackSummary;
}

function clean(text: string) {
	return text.replace(/`([^`]+)`/gu, "$1").trim();
}
