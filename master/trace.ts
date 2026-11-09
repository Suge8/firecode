/**
 * tail 动作的轨迹快照：最后一条外部输入之后发生了什么。热会话读内存里的 messages，冷会话经 readWorkerSession 读会话文件
 * （全过程视图读冷记录也只经它）。
 * 错误（stopReason / errorMessage）放最前，其后是按时间的正文，超出预算时丢最早的行；
 * 工具调用只留名字与简短参数，工具结果只留开头，免得一次大输出吃掉整份预算。
 */
import { existsSync, readFileSync } from "node:fs";
import { type AgentSession, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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

/**
 * 已释放（冷）子代理的会话只读载入：宿主解析、迁移与分支规则，但放在内存会话里。不用 SessionManager.open：它遇到空文件写头、
 * 遇到旧版格式迁移后整份重写，看一眼记录不该改文件。文件不存在只可能是子代理在第一条回复落盘之前就被中断或释放
 * （宿主此前没写文件），没有任何记录，返回 undefined；恢复会话时同一条规则改为新开（run.ts 的 spawnWorker）。
 */
export function readWorkerSession(worker: WorkerRef): SessionManager | undefined {
	if (!existsSync(worker.sessionPath)) return undefined;
	const content = readFileSync(worker.sessionPath, "utf8");
	const entries = parseSessionEntries(content);
	if (!entries.length && content.trim()) throw new Error(msg.action.sessionInvalid(worker.sessionPath));
	return SessionManager.inMemory(worker.cwd, undefined, entries);
}

export function workerTrace(worker: WorkerRef, session: AgentSession | undefined): string {
	return `${msg.action.traceHeader(worker.name, worker.status)}\n${renderTrace(messagesOf(worker, session))}`;
}

function messagesOf(worker: WorkerRef, session: AgentSession | undefined): readonly TraceMessage[] {
	if (session) return session.messages as readonly TraceMessage[];
	try {
		return (readWorkerSession(worker)?.buildSessionContext().messages ?? []) as readonly TraceMessage[];
	} catch (error) {
		throw new Error(msg.action.traceUnreadable(worker.name, error instanceof Error ? error.message : String(error)));
	}
}

function renderTrace(all: readonly TraceMessage[]): string {
	// 外部输入 = 用户消息；插件自己的续跑与审查提示是自定义消息。
	const input = all.findLastIndex((message) => message.role === "user");
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
	// 自定义消息（插件的事件与提示）在模型侧就是用户消息。
	if (message.role === "user" || message.role === "custom") return text ? [`user: ${clip(text, TEXT_WIDTH)}`] : [];
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
