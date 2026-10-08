/**
 * Prompt 组装：纯函数拼装审查 / 顾问 / 修复反馈文本，文案取自 messages.ts，模板由调用方读入。
 */
import { wrapEnvelope } from "../deliver.js";
import { msg } from "./messages.js";
import type { AdvisorResult, ReviewState, SummaryKind } from "./state.js";

interface ReviewPromptInput {
	scope: string;
	focus: string;
	evidence: string;
	history: ReviewState["history"];
	round: number;
}

export interface PromptLayers {
	system: string;
	user: string;
}

/** 审查政策走 system 层；需求与历史留在 user 层，不能反向改写审查契约。 */
export function buildReviewPrompt(template: string, input: ReviewPromptInput): PromptLayers {
	const evidence = input.evidence.replaceAll("</session_evidence>", "&lt;/session_evidence&gt;");
	const parts = [`${msg.prompt.target}\n${input.scope}`];
	if (input.focus) parts.push(`${msg.prompt.focus}\n${input.focus}`);
	const prior = priorRoundsSection(input.history, input.round);
	if (prior) parts.push(prior);
	parts.push(
		`${msg.prompt.sessionRecord}\n<session_evidence>\n${evidence}\n</session_evidence>`,
		msg.prompt.reviewReminder,
	);
	return promptLayers(template, parts.filter((part) => part !== "").join("\n\n"));
}

function promptLayers(system: string, user: string): PromptLayers {
	if (!system.trim()) throw new Error(msg.prompt.systemEmpty);
	return { system, user };
}

/** 往轮 FAIL 发现清单（两相收敛的闭环输入）：第 2 轮起注入。 */
function priorRoundsSection(history: ReviewState["history"], round: number): string | undefined {
	const prior = history.filter((entry) => entry.round < round && entry.result === "failed");
	if (round <= 1 || prior.length === 0) return undefined;
	const body = prior
		.map((entry) => {
			// 顾问裁决必须随轮注入：否则被顾问排除的发现会在后续轮被审查者原样重提，循环无法收敛。
			const advisor = entry.advisor
				? `\n\n### ${msg.prompt.advisorRuling}（${entry.advisor.verdict}）\n${entry.advisor.advice}`
				: "";
			return `${msg.prompt.priorRound(entry.round)}\n${entry.details}${advisor}`;
		})
		.join("\n\n");
	return `${msg.prompt.priorHeader}\n${body}`;
}

interface AdvisorPromptInput {
	focus: string;
	details: string;
	history: ReviewState["history"];
	round: number;
}

export function buildAdvisorPrompt(template: string, input: AdvisorPromptInput): PromptLayers {
	const parts: string[] = [];
	if (input.focus) parts.push(`${msg.prompt.advisorFocus}\n${input.focus}`);
	parts.push(`${msg.prompt.thisRoundFindings}\n${input.details}`);
	const prior = priorRoundsSection(input.history, input.round);
	if (prior) parts.push(`${msg.prompt.priorHistory}\n${prior}`);
	parts.push(msg.prompt.advisorReminder);
	return promptLayers(template, parts.join("\n\n"));
}

interface FixFeedbackInput {
	details: string;
	advisor: AdvisorResult | null;
}

/** 投递给执行模型的修复反馈：把审查发现当假设核实，修根因不压表象。 */
export function buildFixFeedback(input: FixFeedbackInput): string {
	// narrow 与 continue 必须产生可区分的行为：narrow 不再要求逐条修全部发现，
	// 而是把顾问给的范围当约束，只修真正阻塞当前需求的那部分。
	const narrowed = input.advisor?.verdict === "narrow";
	const parts = [narrowed ? msg.prompt.narrowInstruction : msg.prompt.fixInstruction, "", input.details];
	if (input.advisor?.advice)
		parts.push("", narrowed ? msg.prompt.advisorScope : msg.prompt.advisorAdvice, input.advisor.advice);
	return wrapEnvelope("firecode_review", parts.join("\n"));
}

/** 总结提示携带的终态材料上限：模型已经历过修复轮，材料只补它没见过的终态结论。 */
const SUMMARY_MATERIAL_LIMIT = 4_000;

interface SummaryPromptInput {
	kind: SummaryKind;
	rounds: number;
	/** 终态材料：通过=末轮审查结论；max_rounds=末轮发现；advisor_stop=顾问裁决。 */
	material: string;
}

/** 质量裁决终态后投给执行模型的总结回合提示：人话收尾，带反循环禁令。 */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
	const omitted = input.material.length - SUMMARY_MATERIAL_LIMIT;
	const material = omitted > 0
		? `${input.material.slice(0, SUMMARY_MATERIAL_LIMIT)}\n${msg.prompt.materialTruncated(omitted)}`
		: input.material;
	const body = msg.prompt.summaryInstruction[input.kind](input.rounds);
	const content = material.trim() ? `${body}\n\n${msg.prompt.materialLabel[input.kind]}\n${material}` : body;
	return wrapEnvelope("firecode_review", content);
}
