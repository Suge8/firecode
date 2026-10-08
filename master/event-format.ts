/**
 * Master 事件正文的唯一产文处：第一行是给人看的标题“<名字> <结果词>”（名字是第一个空格前的词），
 * 给模型的指令放在后续正文。分节标记独占一行“<标记>：”；失败只由“错误：”分节表示——
 * 红色、失败计数与活动列表失败组都从这一个事实来（失败、审查停止、审查未完成；被中断不是失败）。
 * 折叠界面（tools/machine.ts）按标题、错误分节与“耗时：本次运行 …”行投影，改格式两侧都要同步。
 */
import { formatDuration } from "../format.js";
import { msg as root } from "../messages.js";
import type { ReviewOutcome } from "../review/outcome.js";
import { msg } from "./messages.js";

export const MASTER_EVENT_TYPE = "firecode-master-event";

/** 分节与耗时词汇同源于根 messages.ts 的 envelope：折叠界面（tools/machine.ts）读同一份。 */
const SECTIONS = root.envelope.sections;

/**
 * 产出的事件：正文与是否落定类。落定类（已返回、失败、被中断、审查通过/停止/未完成）才带“本次运行”耗时，
 * 界面据此触发到达高亮；其余事件（待续跑、已切换模型、补充说明未送达）只带当前任务耗时。
 */
export interface MasterEvent {
	body: string;
	settled: boolean;
}

const lines = (...parts: (string | undefined)[]) => parts.filter((part) => part !== undefined).join("\n");
const settled = (...parts: (string | undefined)[]): MasterEvent => ({ body: lines(...parts), settled: true });
const notice = (...parts: (string | undefined)[]): MasterEvent => ({ body: lines(...parts), settled: false });

/**
 * 一次运行里用户在子代理全过程视图直接说的话（按顺序）。有就在标题结果词后注明来源、正文先列原话：
 * 指挥官据此知道这次运行不是它派的，只记下不向用户复述；成败、发落、在飞数与普通 send 完全相同。
 */
export type ViewPrompts = readonly string[];
const runTitle = (name: string, word: string, view: ViewPrompts) => `${name} ${word}${view.length ? msg.event.viewMark : ""}`;
const youSaid = (view: ViewPrompts) => view.map(msg.event.youSaid);

export const masterEvent = {
	returned: (name: string, reply: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.returned, view), ...youSaid(view), SECTIONS.reply, reply, obligation ? msg.event.obligation : undefined),
	failed: (name: string, error: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.failed, view), ...youSaid(view), SECTIONS.error, error, obligation ? msg.event.obligation : undefined),
	interrupted: (name: string, obligation: boolean, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.interrupted, view), ...youSaid(view), msg.event.interruptedKept(obligation)),
	reviewIncomplete: (name: string, reason: string, reply?: string) =>
		settled(`${name} ${msg.event.reviewIncomplete}`, SECTIONS.error, reason, ...(reply === undefined ? [] : [SECTIONS.finalReply, reply || msg.event.noReply])),
	/** 审查终态；reply 是 Worker 最后一条回复。停止与未完成是失败：原因进“错误：”分节，顾问意见在其后。 */
	review(name: string, outcome: ReviewOutcome, reply: string): MasterEvent {
		const final = [SECTIONS.finalReply, reply || msg.event.noReply];
		if (outcome.status === "passed") return settled(`${name} ${msg.event.reviewPassed(outcome.rounds)}`, ...final);
		if (outcome.status === "stopped")
			return settled(
				`${name} ${msg.event.reviewStopped(outcome.rounds)}`,
				SECTIONS.error,
				outcome.advisorAdvice ? msg.event.stoppedByAdvisor(outcome.rounds) : msg.event.roundsExhausted(outcome.rounds),
				...(outcome.advisorAdvice ? [SECTIONS.advice, outcome.advisorAdvice] : []),
				...final,
			);
		if (outcome.status === "failed") return masterEvent.reviewIncomplete(name, outcome.reason, reply);
		if (outcome.status === "refused") return masterEvent.reviewIncomplete(name, outcome.message);
		if (outcome.status === "error") return masterEvent.reviewIncomplete(name, msg.event.reviewReadFailed(outcome.message));
		return masterEvent.reviewIncomplete(name, msg.event.reviewNoFinal(outcome.status));
	},
	/** 只给会话重载打断的回合：指挥官自己发起的 interrupt 它知道现场，不提醒。 */
	resumeReminder: (name: string) => notice(`${name} ${msg.event.pendingResume}`, msg.event.pendingResumeBody),
	stranded: (name: string, texts: string[]) =>
		notice(`${name} ${msg.event.stranded}`, msg.event.strandedBody(texts.length), texts.join("\n---\n")),
	modelSwitched: (name: string, from: string, to: string, reason: string) =>
		notice(`${name} ${msg.event.modelSwitched}`, msg.event.modelSwitchedBody(from, to, reason)),
};

/** 落定类正文末尾追加 Worker 本次运行耗时（子代理会话写下的轮记录给出）；没有记录或非落定事件不追加，不用别处的计时冒充。 */
export function withElapsed(event: MasterEvent, { run, task }: { run?: number; task?: number }): string {
	const parts = [
		...(run === undefined || !event.settled ? [] : [`${root.envelope.thisRun} ${formatDuration(run)}`]),
		...(task === undefined ? [] : [`${root.envelope.currentTask} ${formatDuration(task)}`]),
	];
	return parts.length ? `${event.body}\n${root.envelope.elapsed}${parts.join(" · ")}` : event.body;
}
