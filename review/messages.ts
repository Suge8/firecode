/** review/ 的文案：结果卡、审查/顾问/修复/总结提示的拼装、审查输出契约的校验报错、命令与通知。 */
import { defineMessages } from "../i18n.js";

/**
 * 审查输出契约与结果卡里的字段名。生产端（卡片、汇总、提示拼装）取 msg.terms 的当前语言；
 * 解析端（审查者输出、会话里的历史卡片）经 termPattern 两种语言都认：会话历史可能跨语言，
 * 模型也可能不照提示词的语言写字段名，只认当前语言会让整票作废或卡片预览失效。
 */
const zhTerms = {
	passed: "审查通过",
	failed: "审查未通过",
	finding: "发现",
	suggestions: "建议（非阻塞）",
	decisions: "需用户裁决",
	field: { condition: "发生条件", frequency: "频率", impact: "影响", issue: "问题", evidence: "证据", contract: "违反的约定与期望行为", commands: "验证命令" },
	anchor: { files: "文件", commands: "命令" },
	model: "模型",
	models: "模型",
	blocker: "卡点",
	reason: "原因",
	elapsed: "用时",
	total: "总",
};
const enTerms: typeof zhTerms = {
	passed: "Review passed",
	failed: "Review failed",
	finding: "Finding",
	suggestions: "Suggestions (non-blocking)",
	decisions: "Needs user decision",
	field: {
		condition: "Condition",
		frequency: "Frequency",
		impact: "Impact",
		issue: "Issue",
		evidence: "Evidence",
		contract: "Violated agreement & expected behavior",
		commands: "Verification command",
	},
	anchor: { files: "files", commands: "commands" },
	model: "Model",
	models: "Models",
	blocker: "Blocker",
	reason: "Reason",
	elapsed: "Elapsed",
	total: "total",
};
export type Terms = typeof zhTerms;
const ALL_TERMS: readonly Terms[] = [zhTerms, enTerms];

const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** 某个字段名在所有语言里的写法合成的正则片段。 */
export function termPattern(pick: (terms: Terms) => string): string {
	return `(?:${ALL_TERMS.map(pick).map(escapeRegExp).join("|")})`;
}

const BOLD = String.raw`(?:\*\*|__)?`;

/**
 * 字段行「- **字段名**：值」的匹配：字段名两种语言都认，容忍粗体包裹（含冒号写进粗体内）和冒号后的粗体开头；
 * value 是接在冒号之后的正则片段，缺省时只匹配到冒号。审查者解析与状态机回顾已收口问题共用，容忍度一致。
 */
export function fieldLine(pick: (terms: Terms) => string, { value = "", bullet = true }: { value?: string; bullet?: boolean } = {}): RegExp {
	const lead = bullet ? String.raw`[-*+]\s*` : String.raw`(?:[-*+]\s*)?`;
	return new RegExp(String.raw`^${lead}${BOLD}${termPattern(pick)}${BOLD}\s*[:：]\s*${BOLD}\s*${value}`, "iu");
}

/** 审查输出里“## 建议（非阻塞）”与“## 需用户裁决”标题行（整行，两种语言都认）：审查者解析与状态机拆这两区共用。 */
export const SUGGESTIONS_HEADING = new RegExp(`^##\\s+${termPattern((terms) => terms.suggestions)}\\s*$`, "iu");
export const DECISIONS_HEADING = new RegExp(`^##\\s+${termPattern((terms) => terms.decisions)}\\s*$`, "iu");

/** 审查结果行里不算结论的整行词：判定词本身（旧卡片与顺手写判定词的审查者）与各语言的通过/未通过标题。 */
export const REDUNDANT_VERDICT_LINES: ReadonlySet<string> = new Set([
	"PASS",
	"FAIL",
	...ALL_TERMS.flatMap((terms) => [terms.passed, terms.failed]),
]);

/** 审查因审查者自身失效没有结论时的定性与出路：读者（用户、Master）据此换模型或亲审，而不是去修代码或干等。 */
const zhReviewerBroken =
	"审查器失效，不是代码问题：有审查者没给出结论（输出格式无效、登录或额度失效、超时），本轮不算通过。建议换一个可用的模型重审（调整该席位的模型链或补备用模型），或由指挥官亲自审查这次改动。";
const enReviewerBroken =
	"Reviewer failure, not a code problem: a reviewer gave no verdict (invalid output format, expired login or quota, or timeout), so this round does not pass. Suggested: re-review with a working model (adjust that seat's model chain or add a fallback), or have the Master review the change itself.";

export const msg = defineMessages({
	zh: {
		terms: zhTerms,
		command: {
			description: "对抗性审查：审这个会话到目前为止做完的事",
			invalidArgs: "fire-review 参数无效",
			alreadyRunning: "已有审查在进行中。",
			nothingToCancel: "没有进行中的审查。",
			off: "fire-review 已关闭（features.review）。",
			scope: "当前会话当前任务的交付质量。首条用户消息是原始需求锚点；后续用户消息可能覆盖、缩小或修正，以后者为准。",
		},
		notify: {
			cannotSealOld: (reason: string) => `fire-review 无法收口旧 checkpoint：${reason}`,
			checkpointDamaged: (session: string) => `会话「${session}」的审查进度读不出来（存档已损坏），这场审查已作废，不会继续。需要审查请重新运行 /fire-review。`,
			stepFailed: (reason: string) => `fire-review 步骤失败：${reason}`,
			checkpointWriteFailed: (reason: string) => `fire-review checkpoint 写入失败，已停止审查：${reason}`,
			cannotSeal: "fire-review 无法写入终态，重启后可能恢复这场审查，到时按 esc 取消。",
			cancelled: "审查已取消\n已按你的操作停止",
			summarySkipped: "已停止等待总结\n审查结论保留，不记为取消",
		},
		failure: {
			reviewerSession: (reason: string) => `${zhReviewerBroken}\n\n审查会话异常：${reason}`,
			cannotReadSession: (reason: string) => `无法读取 session 文件：${reason}`,
			badJsonLine: (line: number) => `session 第 ${line} 行不是有效 JSON`,
		},
		outcome: {
			error: "审查因故障中止",
			timedOut: "审查超过总体时限被终止",
		},
		ui: {
			reviewing: "审查中",
			editorHint: (keys: string) => `  审查进行中 · ${keys} 取消`,
		},
		card: {
			started: "审查开始",
			startedModels: (models: string[]) => `${zhTerms.models}：${models.join("、")}`,
			passed: zhTerms.passed,
			failed: zhTerms.failed,
			round: (round: number, title: string) => `第 ${round} 轮${title}`,
			stoppedByAdvisor: "审查已由顾问终止",
			incomplete: "审查未完成",
			timeoutBlocker: `${zhTerms.blocker}：审查超时`,
			timeoutReason: `${zhTerms.reason}：超过总体时限`,
			errorBlocker: `${zhTerms.blocker}：审查未完成`,
			errorReason: (message: string) => `${zhTerms.reason}：${message}`,
			advisorGuidance: (decision: string) => `顾问指引 · ${decision}`,
			advisorSkipped: "顾问不可用，已跳过",
			advisorSkippedBody: "未取得顾问裁决，按「继续修复」把本轮发现交给执行模型。",
			modelLine: (model: string) => `**${zhTerms.model} · ${model}**`,
			elapsed: (elapsed: string, total?: string) =>
				total === undefined
					? `${zhTerms.elapsed}：${elapsed}`
					: `${zhTerms.elapsed}：${elapsed} / ${zhTerms.total} ${total}`,
			decision: { continue: "继续修复", narrow: "收窄范围", stop: "停止修复" },
		},
		summary: {
			passedFallback: "审查通过。",
			modelBullet: (model: string, body: string) => `• ${model}：${body}`,
			fallbackName: (model: string) => `${model}（备用）`,
			fallbackReviewer: (name: string) => `审查模型：${name}，席位首选不可用`,
			reviewerBroken: zhReviewerBroken,
			modelSection: (index: number, model: string) => `${zhTerms.model} ${index} · ${model}`,
			closedHeading: "**本次收口的问题**：",
			closedItem: (issue: string, round: number) => `• ${issue}（第 ${round} 轮）`,
			closedMore: (count: number) => `…另有 ${count} 项，详见审查报告`,
		},
		prompt: {
			target: "审查对象：",
			focus: "关注点：",
			sessionRecord: "会话记录：",
			reviewReminder: "现在按 system prompt 的审查规则完成审查，并严格遵守其输出契约。",
			priorHeader: "往轮发现清单（由新到旧）：",
			priorRound: (round: number) => `## 第 ${round} 轮 · 未通过`,
			advisorRuling: "顾问裁决",
			advisorFocus: "审查关注点：",
			requirementRecord: "原始需求与最近的会话记录（节选；完整记录在会话文件里）：",
			thisRoundFindings: "本轮 FAIL 发现：",
			priorHistory: "往轮 FAIL 历史：",
			advisorReminder: "现在按 system prompt 的规则完成仲裁，并严格遵守其输出契约。",
			fixInstruction:
				"本轮审查未通过，请修复以下发现。将审查反馈视为待核实假设，而非事实：先基于当前文件、测试/检查输出和会话约束核实。反馈属实时，逐条修复全部属实发现，修根因而非表象，同一根因的其他出现点一并修复，修完端到端验证问题已彻底解决后直接结束（本回合结束后会自动进入下一轮复审）；避免无关重构、抽象、依赖或风格改动。反馈不成立时，不应用该反馈，并说明依据（文件、命令输出或约束）。「建议（非阻塞）」与「需用户裁决」里的条目不要改：建议留到总结里列出，裁决项交给用户。",
			narrowInstruction:
				"本轮审查未通过，但顾问判定发现清单范围过宽。下方是完整发现，仅供参考：只修顾问收窄后的范围内、真正阻塞当前需求的那部分，其余发现不要处理。先根据当前文件与命令输出核实再修，修根因不压表象，修复验证后直接结束（本回合结束后会自动进入下一轮复审）；避免无关重构、抽象、依赖或风格改动。若认为收窄范围内的发现也不成立，说明依据并停下。「建议（非阻塞）」与「需用户裁决」里的条目不要改。",
			advisorScope: "顾问收窄后的范围（以此为准）：",
			advisorAdvice: "顾问建议：",
			materialTruncated: (omitted: number) => `[材料截断：省略 ${omitted} 字]`,
			materialLabel: { passed: "末轮审查结论：", max_rounds: "末轮未通过的发现：", advisor_stop: "顾问裁决：" },
			summaryInstruction: {
				passed: (rounds: number) =>
					`对抗审查已通过（共 ${rounds} 轮）。用人话给用户收尾，不分编号小节，裁决项之外不超过 6 行：先用一两句说修了什么、凭什么通过；再列出你认为值得处理的建议（至多 3 条，每条一行附理由；能用 lint 规则、类型约束或脚本检查挡住再犯的模式算在内，写明做成哪种检查），其余不提；最后把「需用户裁决」事项原样逐条列出，交用户决定。没有的部分省略。只做总结：不要修改代码、不要运行工具，直接以最终回复结束本回合。`,
				max_rounds: (rounds: number) =>
					`对抗审查在 ${rounds} 轮内未能通过，已按上限终止。用人话如实给用户收尾，不分编号小节，裁决项之外不超过 6 行：先用两三句说卡在哪些发现上、你判断的根因、代码的真实状态与建议的下一步；再列出你认为值得处理的建议（至多 3 条，每条一行附理由；能用 lint 规则、类型约束或脚本检查挡住再犯的模式算在内，写明做成哪种检查），其余不提；最后把「需用户裁决」事项原样逐条列出，交用户决定。没有的部分省略。只做总结：不要再继续修改代码或运行工具，直接以最终回复结束本回合。`,
				advisor_stop: (rounds: number) =>
					`对抗审查被顾问裁定终止（第 ${rounds} 轮）。结合下方顾问裁决，用人话给用户收尾，不分编号小节，裁决项之外不超过 6 行：先用两三句说修了什么、顾问为什么叫停、当前状态与建议的下一步；再列出你认为值得处理的建议（至多 3 条，每条一行附理由；能用 lint 规则、类型约束或脚本检查挡住再犯的模式算在内，写明做成哪种检查），其余不提；最后把「需用户裁决」事项原样逐条列出，交用户决定。没有的部分省略。只做总结：不要再修改代码或运行工具，直接以最终回复结束本回合。`,
			},

		},
		reviewer: {
			formatInvalid: (issue: string) => `审查输出格式无效：${issue}`,
			attempt: (model: string, details: string) => `${model}：${details}`,
			failFormatNote: (issue: string) => `（审查输出未满足格式契约：${issue}。以下为原文，过门槛的发现仍按未通过处理）`,
			demoted: (title: string, condition: string, frequency: number, impact: number) =>
				`${title}（${condition ? `${zhTerms.field.condition}：${condition}` : "发生条件未说明"}；${zhTerms.field.frequency} ${frequency} · ${zhTerms.field.impact} ${impact}）`,
			timeout: "审查会话超时，未在时限内返回有效输出。",
			sessionFailed: (reason: string) => `审查会话失败。${reason}`,
			emptyOutput: "审查输出为空：无审查结论。",
			noSummary: "缺少摘要行（证据行前必须有一行极简摘要）",
			noEvidence: `缺少证据锚点行（${zhTerms.field.evidence}：${zhTerms.anchor.files}=…；${zhTerms.anchor.commands}=…）`,
			noFiles: `证据行缺少文件段（${zhTerms.anchor.files}=至少一个带扩展名的路径）`,
			noCommands: `证据行缺少命令段（${zhTerms.anchor.commands}=实际运行的命令）`,
			missingFields: (index: number, names: string[]) => `第 ${index} 条阻塞发现缺少必填字段：${names.join("、")}`,
			failFallbackSummary: "审查未通过，存在发现。",
		},
		advisor: {
			unavailable: (detail: string) => `顾问会话不可用: ${detail}`,
			unparseable: (sample: string) => `顾问输出无法解析（首行：${sample}），按继续处理当前发现。`,
			noAdvice: "（无建议）",
		},
		evidence: {
			user: "用户",
			assistant: "助手",
			custom: (customType: string) => `消息（${customType}）`,
			compaction: "历史摘要（已压缩）",
			branchSummary: "分支摘要",
			gap: (omitted: number) => `[证据预算省略了 ${omitted} 条中间消息]`,
			failedCall: "（失败）",
			sessionFile: "会话文件",
			lineTruncated: (chars: number, where: string) => `…[截断，原文 ${chars} 字，完整原文在 ${where}]`,
			messageTruncated: (chars: number, shown: number, where: string) =>
				`[证据截断：本条消息原文 ${chars} 字，此处只给出前 ${shown} 字；完整原文在 ${where}，需要核对时用 read 查看]`,
		},
	},
	en: {
		terms: enTerms,
		command: {
			description: "Adversarial review: audit what this session has delivered so far",
			invalidArgs: "Invalid fire-review arguments.",
			alreadyRunning: "A review is already running.",
			nothingToCancel: "No review is running.",
			off: "fire-review is turned off (features.review).",
			scope: "Delivery quality of the current task in this conversation. The first user message is the original-request anchor; later user messages may override, narrow, or correct it.",
		},
		notify: {
			cannotSealOld: (reason: string) => `fire-review could not seal the old checkpoint: ${reason}`,
			checkpointDamaged: (session: string) => `The review progress of session "${session}" cannot be read (the saved data is damaged). That review is void and will not continue. Run /fire-review again to review.`,
			stepFailed: (reason: string) => `fire-review step failed: ${reason}`,
			checkpointWriteFailed: (reason: string) => `fire-review checkpoint write failed; review stopped: ${reason}`,
			cannotSeal: "fire-review could not seal the checkpoint; a restart may resume this review — cancel it with esc.",
			cancelled: "Review cancelled\nStopped by user",
			summarySkipped: "Stopped waiting for the summary\nThe review verdict stands and is not recorded as cancelled",
		},
		failure: {
			reviewerSession: (reason: string) => `${enReviewerBroken}\n\nreviewer session error: ${reason}`,
			cannotReadSession: (reason: string) => `Cannot read the session file: ${reason}`,
			badJsonLine: (line: number) => `session line ${line} is not valid JSON`,
		},
		outcome: {
			error: "Review aborted by a failure",
			timedOut: "Review stopped at the overall time limit",
		},
		ui: {
			reviewing: "Reviewing",
			editorHint: (keys: string) => `  Review in progress · ${keys} to cancel`,
		},
		card: {
			started: "Review started",
			startedModels: (models: string[]) => `${enTerms.models}: ${models.join(", ")}`,
			passed: enTerms.passed,
			failed: enTerms.failed,
			round: (round: number, title: string) => `Round ${round} ${title}`,
			stoppedByAdvisor: "Review stopped by advisor",
			incomplete: "Review incomplete",
			timeoutBlocker: `${enTerms.blocker}: review timed out`,
			timeoutReason: `${enTerms.reason}: overall time limit exceeded`,
			errorBlocker: `${enTerms.blocker}: review did not complete`,
			errorReason: (message: string) => `${enTerms.reason}: ${message}`,
			advisorGuidance: (decision: string) => `Advisor guidance · ${decision}`,
			advisorSkipped: "Advisor unavailable, skipped",
			advisorSkippedBody: "No advisor ruling was obtained; this round's findings go to the executor as \"continue fixing\".",
			modelLine: (model: string) => `**${enTerms.model} · ${model}**`,
			elapsed: (elapsed: string, total?: string) =>
				total === undefined
					? `${enTerms.elapsed}: ${elapsed}`
					: `${enTerms.elapsed}: ${elapsed} / ${enTerms.total} ${total}`,
			decision: { continue: "Continue fixing", narrow: "Narrow scope", stop: "Stop fixing" },
		},
		summary: {
			passedFallback: "Review passed.",
			modelBullet: (model: string, body: string) => `• ${model}: ${body}`,
			fallbackName: (model: string) => `${model} (fallback)`,
			fallbackReviewer: (name: string) => `Reviewed by ${name}; the seat's first choice was unavailable`,
			reviewerBroken: enReviewerBroken,
			modelSection: (index: number, model: string) => `${enTerms.model} ${index} · ${model}`,
			closedHeading: "**Issues closed in this check**:",
			closedItem: (issue: string, round: number) => `• ${issue} (Round ${round})`,
			closedMore: (count: number) => `…and ${count} more; see the review report`,
		},
		prompt: {
			target: "Review target:",
			focus: "Focus:",
			sessionRecord: "Session record:",
			reviewReminder: "Now complete the review under the system prompt and strictly follow its output contract.",
			priorHeader: "Prior round findings (newest first):",
			priorRound: (round: number) => `## Round ${round} · failed`,
			advisorRuling: "Advisor ruling",
			advisorFocus: "Review focus:",
			requirementRecord: "Original request and recent session record (excerpt; the full record is in the session file):",
			thisRoundFindings: "This round FAIL findings:",
			priorHistory: "Prior FAIL history:",
			advisorReminder: "Now arbitrate under the system prompt and strictly follow its output contract.",
			fixInstruction:
				"This round's review failed. Fix the findings below. Treat the review feedback as hypotheses to verify, not facts: verify against current files, test/check output and session constraints. When feedback is valid, fix every valid finding, fixing root causes not symptoms and other occurrences of the same root cause, and verify end-to-end that issues are truly resolved then finish directly (the next review round will start automatically); avoid unrelated refactors, abstractions, dependency or style changes. When feedback is not valid, do not apply it and explain why (files, command output, or constraints). Leave the items under “Suggestions (non-blocking)” and “Needs user decision” alone: suggestions are listed in the wrap-up, decisions go to the user.",
			narrowInstruction:
				"This round's review failed, but the advisor judged the finding list too broad. The full findings below are context only: fix only the part inside the advisor's narrowed scope that actually blocks the current requirement, and leave the rest alone. Verify against current files and command output before fixing, fix root causes not symptoms, and finish directly after verification (the next review round will start automatically); avoid unrelated refactors, abstractions, dependency or style changes. If even the narrowed findings do not hold, explain why and stop. Leave the items under “Suggestions (non-blocking)” and “Needs user decision” alone.",
			advisorScope: "Advisor scope (authoritative):",
			advisorAdvice: "Advisor note:",
			materialTruncated: (omitted: number) => `[material truncated: ${omitted} characters omitted]`,
			materialLabel: { passed: "Final review verdict:", max_rounds: "Final round findings:", advisor_stop: "Advisor ruling:" },
			summaryInstruction: {
				passed: (rounds: number) =>
					`The adversarial review passed after ${rounds} round(s). Wrap up for the user in plain language, without numbered sections, in at most 6 lines besides the decision items: first one or two sentences on what you fixed and why it passed; then list the suggestions you recommend addressing (at most 3, one line each with the reason; a pattern a lint rule, a type constraint or a scripted check could stop from recurring counts — say which kind of check), and leave the rest out; finally list each "Needs user decision" item as raised, for the user to decide. Omit any part that is empty. Summary only: do not change code or run tools; end this turn with the final reply.`,
				max_rounds: (rounds: number) =>
					`The adversarial review did not pass within ${rounds} round(s) and stopped at the limit. Wrap up honestly for the user in plain language, without numbered sections, in at most 6 lines besides the decision items: first two or three sentences on which findings it got stuck on, your root-cause read, the real state of the code and the next step you recommend; then list the suggestions you recommend addressing (at most 3, one line each with the reason; a pattern a lint rule, a type constraint or a scripted check could stop from recurring counts — say which kind of check), and leave the rest out; finally list each "Needs user decision" item as raised, for the user to decide. Omit any part that is empty. Summary only: do not keep changing code or run tools; end this turn with the final reply.`,
				advisor_stop: (rounds: number) =>
					`The adversarial review was stopped by the advisor (round ${rounds}). Using the advisor ruling below, wrap up for the user in plain language, without numbered sections, in at most 6 lines besides the decision items: first two or three sentences on what was fixed, why the advisor called it off, the current state and the next step you recommend; then list the suggestions you recommend addressing (at most 3, one line each with the reason; a pattern a lint rule, a type constraint or a scripted check could stop from recurring counts — say which kind of check), and leave the rest out; finally list each "Needs user decision" item as raised, for the user to decide. Omit any part that is empty. Summary only: do not change code or run tools; end this turn with the final reply.`,
			},

		},
		reviewer: {
			formatInvalid: (issue: string) => `review output format invalid: ${issue}`,
			attempt: (model: string, details: string) => `${model}: ${details}`,
			failFormatNote: (issue: string) => `(The review output did not meet the format contract: ${issue}. Original text follows; findings over the threshold still count as a failure.)`,
			demoted: (title: string, condition: string, frequency: number, impact: number) =>
				`${title} (${condition ? `${enTerms.field.condition}: ${condition}` : "condition not stated"}; ${enTerms.field.frequency} ${frequency} · ${enTerms.field.impact} ${impact})`,
			timeout: "review session timed out before returning valid output.",
			sessionFailed: (reason: string) => `review session failed. ${reason}`,
			emptyOutput: "review output is empty: no check result.",
			noSummary: "missing the summary line (one terse summary line must precede the evidence line)",
			noEvidence: `missing the evidence anchor line (${enTerms.field.evidence}: ${enTerms.anchor.files}=...; ${enTerms.anchor.commands}=...)`,
			noFiles: `evidence line is missing the files segment (${enTerms.anchor.files}=at least one path with an extension)`,
			noCommands: `evidence line is missing the commands segment (${enTerms.anchor.commands}=the commands actually run)`,
			missingFields: (index: number, names: string[]) => `blocking finding ${index} is missing required fields: ${names.join(", ")}`,
			failFallbackSummary: "Review failed with findings.",
		},
		advisor: {
			unavailable: (detail: string) => `advisor session unavailable: ${detail}`,
			unparseable: (sample: string) => `Advisor output was not parseable (first line: ${sample}); continuing with the current findings.`,
			noAdvice: "(no advice)",
		},
		evidence: {
			user: "User",
			assistant: "Assistant",
			custom: (customType: string) => `Message (${customType})`,
			compaction: "History summary (compacted)",
			branchSummary: "Branch summary",
			gap: (omitted: number) => `[${omitted} intermediate message(s) omitted under the evidence budget]`,
			failedCall: " (failed)",
			sessionFile: "the session file",
			lineTruncated: (chars: number, where: string) => `…[truncated, ${chars} chars; full original in ${where}]`,
			messageTruncated: (chars: number, shown: number, where: string) =>
				`[evidence truncated: this message has ${chars} characters, only the first ${shown} are shown; the full original is in ${where} — read it if you need to verify]`,
		},
	},
});
