/** subagents / subagents_list 的工具行与 /fire-master status 文本：纯投影，不改状态；状态与动作都取 phase.ts 的相位。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../format.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { type Action, inputOf } from "./actions.js";
import { msg } from "./messages.js";
import { workerPhase, type ActivityFacts, type WorkerPhase } from "./phase.js";
import { compactWorker, type CompactWorker } from "./state.js";

export const renderSubagentsResult = makeResultRenderer(false);
const ACTION_VERB: Record<Action | "list", string> = msg.list.verb;

/** 工具行：参数与工具入口同一份解析（actions.ts 的 inputOf）。 */
export function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const { worker, role, prompt } = inputOf(args);
	const parts: Part[] = [{ text: ACTION_VERB[action as Action] ?? action, bold: true }];
	if (worker) parts.push({ text: ` ${worker}`, color: "accent" });
	if ((action === "start" || action === "send") && role) parts.push({ text: ` · ${role}`, color: "muted" });
	const brief = prompt?.split("\n", 1)[0];
	if (brief && action === "start") parts.push({ text: ` — ${brief}`, color: "muted" });
	return parts;
}

/** 池快照加上只给界面看的相位（模型正文不含）：列出那一刻的快照，展开时按它渲染。 */
export type ListedWorker = CompactWorker & { phase: Pick<WorkerPhase, "kind" | "action" | "startedAt" | "settledAt"> };

/** 池查询的 details：每票带上此刻的相位。 */
export function listedWorkers(facts: ActivityFacts, now: number): ListedWorker[] {
	return facts.workers.map((entry) => {
		const { kind, action, startedAt, settledAt } = workerPhase(entry, facts.stallMs, now);
		return { ...compactWorker(entry.worker), phase: { kind, action, ...(startedAt === undefined ? {} : { startedAt }), ...(settledAt === undefined ? {} : { settledAt }) } };
	});
}

/** 展开行的动作与时刻：在动的写这次运行已多久，落定的写落定多久前，暂停只有续跑时刻，空闲（含 reload 后）不写。 */
function actionParts({ kind, action, startedAt, settledAt }: ListedWorker["phase"]): Part[] {
	const now = Date.now();
	if (kind === "idle") return [];
	if (settledAt !== undefined) return [{ text: ` · ${action} · ${msg.list.settledAgo(formatDuration(Math.max(0, now - settledAt)))}`, color: "muted" }];
	const elapsed = startedAt === undefined || kind === "paused" ? "" : ` · ${msg.list.running(formatDuration(Math.max(0, now - startedAt)))}`;
	return [{ text: ` · ${action}${elapsed}`, color: "accent" }];
}

export function expandedWorkerList(
	workers: ListedWorker[],
	theme: ExtensionContext["ui"]["theme"],
	context: Parameters<typeof renderSubagentsResult>[3],
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			return ["", ...workers.flatMap((worker) => new ToolLine({
				label: worker.name,
				value: [
					{ text: roleStatusText(worker), color: "accent" },
					...actionParts(worker.phase),
					...(worker.model ? [{ text: ` · ${worker.model.split("/").pop()}/${worker.thinking}`, color: "muted" as const }] : []),
				],
				clip: "end",
				theme,
				ctx: { ...context, state: {}, expanded: false },
			}).render(width))];
		},
	};
}

export function listMeta(workers: ListedWorker[]): Part[] {
	if (!workers.length) return [{ text: ` — ${msg.list.poolEmpty}`, color: "muted" }];
	const summary = workers.map((worker) => `${worker.name} ${roleStatusText(worker)}`).join(" · ");
	return [{ text: ` — ${msg.list.pool(workers.length, summary)}`, color: "muted" }];
}

export function statusText(workers: readonly ListedWorker[]): string {
	return workers.length
		? workers.map((worker) => [worker.name, roleStatusText(worker), worker.model?.split("/").pop()].filter(Boolean).join(" ")).join("\n")
		: msg.list.noWorkers;
}

/** 角色为主的状态投影：「工程师·运行中」。 */
function roleStatusText(worker: ListedWorker): string {
	return `${worker.role}·${msg.phase[worker.phase.kind]}`;
}
