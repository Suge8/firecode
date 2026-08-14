/**
 * Prompt 组装：纯函数拼装审查 / 顾问 / 修复反馈文本。
 * 模板文件读取是唯一 IO（readPrompt），拼装本身零副作用可单测。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "../config.js";
import type { AdvisorResult, ReviewState } from "./state.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export type PromptKind = "review" | "advisor";

export function readPrompt(kind: PromptKind, language: Language): string {
	const path = join(PROMPTS_DIR, `${kind}.${language}.md`);
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

export interface ReviewPromptInput {
	language: Language;
	scope: string;
	focus: string;
	evidence: string;
	history: ReviewState["history"];
	round: number;
}

export function buildReviewPrompt(template: string, input: ReviewPromptInput): string {
	const sep = input.language === "en" ? ":" : "：";
	const parts = [
		template,
		`${input.language === "en" ? "Review target" : "审查对象"}${sep}\n${input.scope}`,
	];
	if (input.focus)
		parts.push(`${input.language === "en" ? "Focus" : "关注点"}${sep}\n${input.focus}`);
	const prior = priorRoundsSection(input.history, input.round, input.language);
	if (prior) parts.push(prior);
	parts.push(`${input.language === "en" ? "Session evidence" : "会话证据"}${sep}\n${input.evidence}`);
	return parts.filter((part) => part !== "").join("\n\n");
}

/** 往轮 FAIL 发现清单（两相收敛的闭环输入）：第 2 轮起注入。 */
export function priorRoundsSection(
	history: ReviewState["history"],
	round: number,
	language: Language,
): string | undefined {
	const prior = history.filter((entry) => entry.round < round && entry.result === "failed");
	if (round <= 1 || prior.length === 0) return undefined;
	const header =
		language === "en"
			? `Prior round findings (newest first)${language === "en" ? "" : "："}`
			: "往轮发现清单（由新到旧）：";
	const body = prior
		.map((entry) => {
			const label =
				language === "en" ? `## Round ${entry.round} · failed` : `## 第 ${entry.round} 轮 · 未通过`;
			// 顾问裁决必须随轮注入：否则被顾问排除的发现会在后续轮被审查者原样重提，循环无法收敛。
			const advisor = entry.advisor
				? `\n\n### ${language === "en" ? "Advisor ruling" : "顾问裁决"}（${entry.advisor.verdict}）\n${entry.advisor.advice}`
				: "";
			return `${label}\n${entry.details}${advisor}`;
		})
		.join("\n\n");
	return `${header}\n${body}`;
}

export interface AdvisorPromptInput {
	language: Language;
	focus: string;
	details: string;
	history: ReviewState["history"];
	round: number;
}

export function buildAdvisorPrompt(template: string, input: AdvisorPromptInput): string {
	const sep = input.language === "en" ? ":" : "：";
	const parts = [template];
	if (input.focus)
		parts.push(`${input.language === "en" ? "Review focus" : "审查关注点"}${sep}\n${input.focus}`);
	parts.push(
		`${input.language === "en" ? "This round FAIL findings" : "本轮 FAIL 发现"}${sep}\n${input.details}`,
	);
	const prior = priorRoundsSection(input.history, input.round, input.language);
	if (prior) parts.push(`${input.language === "en" ? "Prior FAIL history" : "往轮 FAIL 历史"}${sep}\n${prior}`);
	return parts.join("\n\n");
}

export interface FixFeedbackInput {
	language: Language;
	details: string;
	advisor: AdvisorResult | null;
}

/** 投递给执行模型的修复反馈：把审查发现当假设核实，修根因不压表象。 */
export function buildFixFeedback(input: FixFeedbackInput): string {
	// narrow 与 continue 必须产生可区分的行为：narrow 不再要求逐条修全部发现，
	// 而是把顾问给的范围当约束，只修真正阻塞当前需求的那部分。
	const narrowed = input.advisor?.verdict === "narrow";
	const parts = [narrowInstruction(input.language, narrowed), "", input.details];
	if (input.advisor?.advice) {
		const label =
			input.language === "en"
				? narrowed
					? "Advisor scope (authoritative)"
					: "Advisor note"
				: narrowed
					? "顾问收窄后的范围（以此为准）"
					: "顾问建议";
		parts.push("", `${label}${input.language === "en" ? ":" : "："}`, input.advisor.advice);
	}
	return parts.join("\n");
}

function narrowInstruction(language: Language, narrowed: boolean) {
	if (!narrowed) return language === "en" ? FIX_INSTRUCTION_EN : FIX_INSTRUCTION_ZH;
	return language === "en" ? NARROW_INSTRUCTION_EN : NARROW_INSTRUCTION_ZH;
}

const FIX_INSTRUCTION_ZH =
	"本轮审查未通过，请修复以下发现。将审查反馈视为待核实假设，而非事实：先基于当前文件、测试/检查输出和会话约束核实。反馈属实时，逐条修复全部属实发现，修根因而非表象，同一根因的其他出现点一并修复，修完端到端验证问题已彻底解决再结束；避免无关重构、抽象、依赖或风格改动。反馈不成立时，不应用该反馈，并说明依据（文件、命令输出或约束）。";

const NARROW_INSTRUCTION_ZH =
	"本轮审查未通过，但顾问判定发现清单范围过宽。下方是完整发现，仅供参考：只修顾问收窄后的范围内、真正阻塞当前需求的那部分，其余发现不要处理。先根据当前文件与命令输出核实再修，修根因不压表象；避免无关重构、抽象、依赖或风格改动。若认为收窄范围内的发现也不成立，说明依据并停下。";

const NARROW_INSTRUCTION_EN =
	"This round's review failed, but the advisor judged the finding list too broad. The full findings below are context only: fix only the part inside the advisor's narrowed scope that actually blocks the current requirement, and leave the rest alone. Verify against current files and command output before fixing, fix root causes not symptoms, and avoid unrelated refactors, abstractions, dependency or style changes. If even the narrowed findings do not hold, explain why and stop.";

const FIX_INSTRUCTION_EN =
	"This round's review failed. Fix the findings below. Treat the review feedback as hypotheses to verify, not facts: verify against current files, test/check output and session constraints. When feedback is valid, fix every valid finding, fixing root causes not symptoms and other occurrences of the same root cause, and verify end-to-end that issues are truly resolved before finishing; avoid unrelated refactors, abstractions, dependency or style changes. When feedback is not valid, do not apply it and explain why (files, command output, or constraints).";
