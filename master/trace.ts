/**
 * tail 动作的轨迹快照：最后一条外部输入之后发生了什么。热会话读内存里的 messages，冷会话读会话文件。
 * 错误（stopReason / errorMessage）放最前，其后是按时间的正文，超出预算时丢最早的行；
 * 工具调用只留名字与简短参数，工具结果只留开头，免得一次大输出吃掉整份预算。
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseEnvelopes } from "../deliver.js";
import { clip, oneLine, textOf } from "../format.js";
import { isRecord } from "../jsonc.js";
import { msg } from "./messages.js";
import type { WorkerRef } from "./state.js";

/** 快照总宽度预算（显示列）。 */
const TRACE_BUDGET = 4_000;
const TEXT_WIDTH = 600;
const RESULT_WIDTH = 160;
const ERROR_WIDTH = 300;
const ARG_VALUE_WIDTH = 40;
const ARGS_WIDTH = 100;

type TraceMessage = { role: string; content?: unknown; stopReason?: string; errorMessage?: string; isError?: boolean };

export function workerTrace(worker: WorkerRef, session: AgentSession | undefined): string {
	return `${msg.action.traceHeader(worker.name, worker.status)}\n${renderTrace(messagesOf(worker, session))}`;
}

function messagesOf(worker: WorkerRef, session: AgentSession | undefined): readonly TraceMessage[] {
	if (session) return session.messages as readonly TraceMessage[];
	try {
		if (!existsSync(worker.sessionPath)) throw new Error(msg.action.traceMissing);
		return SessionManager.open(worker.sessionPath, dirname(worker.sessionPath), worker.cwd).buildSessionContext().messages as readonly TraceMessage[];
	} catch (error) {
		throw new Error(msg.action.traceUnreadable(worker.name, error instanceof Error ? error.message : String(error)));
	}
}

function renderTrace(all: readonly TraceMessage[]): string {
	// 外部输入 = 不是整条由 Master 信封构成的用户消息（续跑核对、fallback 续跑提示是插件自己发的）。
	const input = all.findLastIndex((message) => message.role === "user" && !parseEnvelopes(textOf(message.content)));
	const recent = all.slice(Math.max(0, input));
	const errors = recent.flatMap((message) => {
		if (message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted")) return [];
		return [clip(oneLine(message.errorMessage || message.stopReason), ERROR_WIDTH)];
	}).map(msg.action.traceError);
	const lines = recent.flatMap(linesOf);
	const kept: string[] = [];
	let room = TRACE_BUDGET - errors.reduce((sum, line) => sum + visibleWidth(line) + 1, 0);
	for (const line of lines.reverse()) {
		const width = visibleWidth(line) + 1;
		if (kept.length && width > room) break;
		kept.unshift(width > room ? clip(line, Math.max(1, room)) : line);
		room -= width;
	}
	return [...errors, ...kept].join("\n");
}

function linesOf(message: TraceMessage): string[] {
	const text = oneLine(textOf(message.content));
	if (message.role === "user") return text ? [`user: ${clip(text, TEXT_WIDTH)}`] : [];
	if (message.role === "toolResult") return text ? [`${message.isError ? "error" : "result"}: ${clip(text, RESULT_WIDTH)}`] : [];
	const calls = Array.isArray(message.content) ? message.content.flatMap((part) => (isRecord(part) && part.type === "toolCall" ? [toolCallLine(part)] : [])) : [];
	return [...(text ? [`assistant: ${clip(text, TEXT_WIDTH)}`] : []), ...calls];
}

function toolCallLine(call: Record<string, unknown>): string {
	const args = isRecord(call.arguments)
		? Object.entries(call.arguments).map(([key, value]) => `${key}=${clip(oneLine(typeof value === "string" ? value : JSON.stringify(value)), ARG_VALUE_WIDTH)}`).join(" ")
		: "";
	return `tool: ${String(call.name)}${args ? ` ${clip(args, ARGS_WIDTH)}` : ""}`;
}
