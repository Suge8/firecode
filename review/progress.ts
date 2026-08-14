/**
 * 审查者实时进度：从子进程事件流派生的 UI 层状态（纯函数）。
 *
 * 不进 reducer、不写 checkpoint：更新频率是每次工具调用，持久化它只会放大写入，
 * 而它对恢复毫无价值——重启后由 reducer 状态重建骨架即可，丢掉的只是流水。
 */
import { clip, formatModelName } from "../format.js";
import type { Language } from "../config.js";
import type { ReviewerStatus } from "./state.js";

export interface ProgressTool {
	id: string;
	tool: string;
	args: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

/** 单个审查者的活动快照。 */
export interface ReviewerProgress {
	index: number;
	label: string;
	status: ReviewerStatus;
	/** 当前动作的人话描述（读某文件 / 跑某命令 / 思考中）。 */
	action: string;
	toolCalls: number;
	tokens: number;
	activeTools: ProgressTool[];
	recentTools: ProgressTool[];
	/** 最近动作流水，供活动测试和降级展示。 */
	trail: string[];
}

const TRAIL_LIMIT = 40;
const RECENT_TOOL_LIMIT = 5;
const ACTION_WIDTH = 48;

export function initialProgress(
	reviewers: readonly { model: string }[],
	language: Language,
): ReviewerProgress[] {
	return reviewers.map((reviewer, index) => ({
		index,
		label: formatModelName(reviewer.model),
		status: "running",
		action: thinkingText(language),
		toolCalls: 0,
		tokens: 0,
		activeTools: [],
		recentTools: [],
		trail: [],
	}));
}

/**
 * 把一条子进程事件并入进度快照，返回新数组（无事件相关变化时返回原数组，
 * 调用方据此跳过重绘）。
 */
export function applyProcessEvent(
	progress: readonly ReviewerProgress[],
	index: number,
	event: Record<string, unknown>,
	language: Language,
): readonly ReviewerProgress[] {
	const current = progress.find((item) => item.index === index);
	if (!current) return progress;
	const next = applyReviewerEvent(current, event, language);
	if (next === current) return progress;
	return progress.map((item) => item.index === index ? next : item);
}

function applyReviewerEvent(
	item: ReviewerProgress,
	event: Record<string, unknown>,
	language: Language,
): ReviewerProgress {
	if (event.type === "tool_execution_start") {
		const tool = typeof event.toolName === "string" ? event.toolName : "tool";
		const args = summarizeArgs(event.args);
		const active: ProgressTool = {
			id: typeof event.toolCallId === "string" ? event.toolCallId : `${tool}:${Date.now()}`,
			tool,
			args,
			startedAt: Date.now(),
		};
		const action = actionOf(tool, args, language);
		return {
			...item,
			action,
			toolCalls: item.toolCalls + 1,
			activeTools: [...item.activeTools, active],
			trail: [...item.trail, action].slice(-TRAIL_LIMIT),
		};
	}
	if (event.type === "tool_execution_end") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const completed = item.activeTools.find((tool) => tool.id === id);
		if (!completed) return item;
		const activeTools = item.activeTools.filter((tool) => tool.id !== id);
		const current = activeTools.at(-1);
		return {
			...item,
			action: current ? actionOf(current.tool, current.args, language) : thinkingText(language),
			activeTools,
			recentTools: [
				...item.recentTools,
				{ ...completed, endedAt: Date.now(), isError: event.isError === true },
			].slice(-RECENT_TOOL_LIMIT),
		};
	}
	if (event.type === "message_end") {
		const message = isRecord(event.message) ? event.message : {};
		const usage = isRecord(message.usage) ? message.usage : {};
		const tokens = Number.isFinite(usage.totalTokens) ? Number(usage.totalTokens) : 0;
		return tokens ? { ...item, tokens: item.tokens + tokens } : item;
	}
	return item;
}

export function settleProgress(
	progress: readonly ReviewerProgress[],
	index: number,
	status: ReviewerStatus,
	language: Language,
): readonly ReviewerProgress[] {
	return progress.map((item) =>
		item.index === index
			? { ...item, status, action: settledText(status, language), activeTools: [] }
			: item,
	);
}

/** 工具调用事件 → 人话动作；非工具事件返回 undefined。 */
function actionOf(tool: string, args: string, language: Language) {
	const verb = verbOf(tool, language);
	const target = tool === "bash" ? args : basename(args);
	return clip(target ? `${verb} ${target}` : verb, ACTION_WIDTH);
}

function verbOf(tool: string, language: Language) {
	const zh: Record<string, string> = {
		read: "读",
		bash: "跑",
		grep: "搜",
		find: "找",
		ls: "看",
	};
	const en: Record<string, string> = {
		read: "read",
		bash: "run",
		grep: "grep",
		find: "find",
		ls: "ls",
	};
	const table = language === "en" ? en : zh;
	return table[tool] ?? tool ?? "?";
}

function summarizeArgs(value: unknown) {
	const args = isRecord(value) ? value : {};
	const raw =
		firstString(args, ["command"]) ??
		firstString(args, ["path", "pattern", "query", "file"]);
	if (raw) return oneLine(raw);
	if (value === undefined) return "";
	try {
		const serialized = JSON.stringify(value);
		return serialized === "{}" ? "" : clip(serialized, 100);
	} catch {
		return clip(String(value), 100);
	}
}

function firstString(args: Record<string, unknown>, keys: readonly string[]) {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function basename(path: string) {
	const parts = path.split("/").filter(Boolean);
	return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : (parts.at(-1) ?? path);
}

function oneLine(text: string) {
	return text.replace(/\s+/gu, " ").trim();
}

function thinkingText(language: Language) {
	return language === "en" ? "thinking" : "思考中";
}

function settledText(status: ReviewerStatus, language: Language) {
	if (language === "en")
		return status === "passed"
			? "passed"
			: status === "failed"
				? "found issues"
				: status === "error"
					? "infra error"
					: "thinking";
	return status === "passed"
		? "通过"
		: status === "failed"
			? "发现问题"
			: status === "error"
				? "异常"
				: "思考中";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
