/** subagents / subagents_list 的工具行与 /fire-master status 文本：纯投影，不改状态。 */
import { statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../format.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { msg } from "./messages.js";
import type { WorkerLive } from "./runtime.js";
import type { WorkerRef, WorkerStatus } from "./state.js";

export const renderSubagentsResult = makeResultRenderer(false);
const STATUS_WORD: Record<WorkerStatus, string> = msg.list.status;
const ACTION_VERB: Record<string, string> = msg.list.verb;

export function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const parts: Part[] = [{ text: ACTION_VERB[action] ?? action, bold: true }];
	const target = optionalText(args.worker);
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	const role = optionalText(args.role);
	if ((action === "start" || action === "send") && role) parts.push({ text: ` · ${role}`, color: "muted" });
	const prompt = optionalText(args.prompt)?.split("\n", 1)[0];
	if (prompt && action === "start") parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

type CompactWorker = ReturnType<typeof compactWorker>;

/** 给模型的池快照：只有档案事实。 */
export function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
		role: worker.role,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		session: worker.sessionPath,
		...(worker.interruptedAt ? { interruptedAt: worker.interruptedAt } : {}),
		...(worker.reviewNeeded ? { reviewNeeded: true } : {}),
		...(worker.disposition ? { disposition: worker.disposition } : {}),
	};
}

/** 展开行用的当前动作：审查进度、落定时刻（reload 后退到会话文件 mtime）或最近的工具。 */
export function currentWorkerAction(worker: CompactWorker, live: WorkerLive | undefined) {
	if (worker.status === "reviewing") return live?.reviewProgress && { kind: "review" as const, ...live.reviewProgress };
	if (worker.status === "idle") {
		let since = live?.idleAt;
		try {
			since ??= statSync(worker.session).mtimeMs;
		} catch {
			// 缺失档案仍可 list；真正恢复时由 send 明确报错。
		}
		return { kind: "idle" as const, ...(since ? { since } : {}) };
	}
	const current = [...(live?.currentTools.values() ?? [])].at(-1);
	return current ? { kind: "tool" as const, ...current } : undefined;
}

export function expandedWorkerList(
	workers: unknown[],
	theme: ExtensionContext["ui"]["theme"],
	context: Parameters<typeof renderSubagentsResult>[3],
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			return ["", ...workers.flatMap((value) => {
				const worker = value as Record<string, unknown>;
				const action = worker.currentAction as {
					kind?: string;
					tool?: string;
					startedAt?: number;
					since?: number;
					round?: number;
					settled?: number;
					total?: number;
				} | undefined;
				const actionParts: Part[] = action?.kind === "tool" && action.tool && action.startedAt
					? [{
						text: ` · ${action.tool} · ${msg.list.running(formatDuration(Math.max(0, Date.now() - action.startedAt)))}`,
						color: "accent",
					}]
					: action?.kind === "idle"
						? [{
							text: action.since ? ` · ${msg.list.settledAgo(formatDuration(Date.now() - action.since))}` : ` · ${msg.list.settled}`,
							color: "muted",
						}]
						: action?.kind === "review"
							? [{ text: ` · ${msg.list.reviewRound(action.round!, action.settled!, action.total!)}`, color: "accent" }]
							: [];
				return new ToolLine({
					label: String(worker.name),
					value: [
						{ text: roleStatusText(worker), color: "accent" },
						...actionParts,
						{ text: ` · ${String(worker.model).split("/").pop()}/${String(worker.thinking)}`, color: "muted" },
					],
					clip: "end",
					theme,
					ctx: { ...context, state: {}, expanded: false },
				}).render(width);
			})];
		},
	};
}

export function listMeta(workers: unknown[]): Part[] {
	if (!workers.length) return [{ text: ` — ${msg.list.poolEmpty}`, color: "muted" }];
	const summary = workers.map((value) => {
		const worker = value as Record<string, unknown>;
		return `${String(worker.name)} ${roleStatusText(worker)}`;
	}).join(" · ");
	return [{ text: ` — ${msg.list.pool(workers.length, summary)}`, color: "muted" }];
}

export function statusText(workers: readonly WorkerRef[]): string {
	return workers.length
		? workers.map((worker) => `${worker.name} ${roleStatusText(worker)} ${worker.model.split("/").pop()}`).join("\n")
		: msg.list.noWorkers;
}

/** 角色为主的状态投影：「工程师·工作」；档案缺角色时退到纯状态词。 */
function roleStatusText(worker: { role?: unknown; status?: unknown }): string {
	const status = STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status);
	return worker.role ? `${String(worker.role)}·${status}` : status;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
