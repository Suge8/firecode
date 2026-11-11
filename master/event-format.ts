/**
 * Master 事件正文的唯一产文处：第一行是给人看的标题“<名字> <结果词>”（名字是第一个空格前的词），
 * 给模型的指令放在后续正文。分节标记独占一行“<标记>：”；失败只由“错误：”分节表示——
 * 红色与失败计数都从这一个事实来（失败、审查未完成）；审查未通过用“结论：”分节，画黄色、不算失败；被中断不是失败。
 * 折叠界面（tools/machine.ts）按标题、错误分节与“耗时：本次运行 …”行投影，改格式两侧都要同步。
 */
import { clip, clockText, formatDuration, oneLine } from "../format.js";
import { msg as root } from "../messages.js";
import type { ReviewOutcome } from "../review/outcome.js";
import { msg } from "./messages.js";

export const MASTER_EVENT_TYPE = "firecode-master-event";

/** 分节与耗时词汇同源于根 messages.ts 的 envelope：折叠界面（tools/machine.ts）读同一份。 */
const SECTIONS = root.envelope.sections;
/** 停摆事件里正在跑的动作截到这么宽：认得出是哪条命令即可，整条命令用 tail 看。 */
const STALL_ACTION_WIDTH = 160;
/** 暂停与续跑事件里的故障原文截到这么宽：供应商报错常带整段 JSON，认得出是哪类故障即可。 */
const FAILURE_WIDTH = 300;

/**
 * 产出的事件：正文与是否落定类。落定类（已返回、失败、被中断、审查通过/未通过/未完成）才带“本次运行”耗时，
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
 * 指挥官据此知道这次运行不是它派的，只记下不向用户复述；成败、在飞数与普通 send 完全相同。
 */
type ViewPrompts = readonly string[];
const runTitle = (name: string, word: string, view: ViewPrompts) => `${name} ${word}${view.length ? msg.event.viewMark : ""}`;
const youSaid = (view: ViewPrompts) => view.map(msg.event.youSaid);

export const masterEvent = {
	returned: (name: string, reply: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.returned, view), ...youSaid(view), SECTIONS.reply, reply, obligation ? msg.event.obligation : undefined),
	failed: (name: string, error: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.failed, view), ...youSaid(view), SECTIONS.error, error, obligation ? msg.event.obligation : undefined),
	interrupted: (name: string, obligation: boolean, view: ViewPrompts = []) =>
		settled(runTitle(name, msg.event.interrupted, view), ...youSaid(view), msg.event.interruptedKept(obligation)),
	/** 审查被 interrupt 取消：不是失败，会话保留，审查义务照旧。 */
	reviewInterrupted: (name: string, obligation: boolean) =>
		settled(`${name} ${msg.event.reviewInterrupted}`, msg.event.reviewInterruptedKept(obligation)),
	reviewIncomplete: (name: string, reason: string, reply?: string) =>
		settled(`${name} ${msg.event.reviewIncomplete}`, SECTIONS.error, reason, ...(reply === undefined ? [] : [SECTIONS.finalReply, reply || msg.event.noReply])),
	/** 审查终态；reply 是 Worker 最后一条回复。未通过的原因进“结论：”分节、顾问意见在其后；未完成是失败，原因进“错误：”分节。 */
	review(name: string, outcome: ReviewOutcome, reply: string): MasterEvent {
		const final = [SECTIONS.finalReply, reply || msg.event.noReply];
		const fallback = "fallback" in outcome && outcome.fallback ? msg.event.reviewFallback(outcome.fallback.join(", ")) : undefined;
		if (outcome.status === "passed") return settled(`${name} ${msg.event.reviewPassed(outcome.rounds)}`, fallback, ...final);
		if (outcome.status === "stopped")
			return settled(
				`${name} ${msg.event.reviewRejected}`,
				fallback,
				SECTIONS.verdict,
				msg.event.rejectedWhy(outcome.rounds, Boolean(outcome.advisorAdvice)),
				...(outcome.advisorAdvice ? [SECTIONS.advice, outcome.advisorAdvice] : []),
				...final,
			);
		if (outcome.status === "failed") return masterEvent.reviewIncomplete(name, outcome.reason, reply);
		if (outcome.status === "cancelled") return masterEvent.reviewIncomplete(name, msg.event.reviewCancelled);
		if (outcome.status === "refused") return masterEvent.reviewIncomplete(name, outcome.message);
		if (outcome.status === "error") return masterEvent.reviewIncomplete(name, msg.event.reviewReadFailed(outcome.message));
		return masterEvent.reviewIncomplete(name, msg.event.reviewNoFinal(outcome.status));
	},
	/** 只给会话重载打断的回合：指挥官自己发起的 interrupt 它知道现场，不提醒。 */
	resumeReminder: (name: string) => notice(`${name} ${msg.event.pendingResume}`, msg.event.pendingResumeBody),
	extensionError: (name: string, extension: string, event: string, error: string) =>
		notice(`${name} ${msg.event.extensionError}`, msg.event.extensionErrorBody(extension, event, error)),
	stranded: (name: string, texts: string[]) =>
		notice(`${name} ${msg.event.stranded}`, msg.event.strandedBody(texts.length), texts.join("\n---\n")),
	/** 在跑的回合卡住（活动列表同一判定）：正在跑的动作与本次运行已用时长；不是落定，子代理仍在跑。 */
	stalled: (name: string, minutes: number, action: string, elapsed?: number) =>
		notice(
			`${name} ${msg.activity.silentFull(minutes)}`,
			msg.event.stalledAction(clip(oneLine(action), STALL_ACTION_WIDTH)),
			elapsed === undefined ? undefined : msg.event.stalledElapsed(formatDuration(elapsed)),
		),
	modelSwitched: (name: string, from: string, to: string, reason: string) =>
		notice(`${name} ${msg.event.modelSwitched}`, msg.event.modelSwitchedBody(from, to, reason)),
	/** 瞬时失败后暂停、到时自动续跑：不是落定，指挥官不必处理（只告知不唤醒）。 */
	paused: (name: string, until: number, reason: string, review: boolean) =>
		notice(
			`${name} ${review ? msg.event.reviewPaused : msg.event.paused}`,
			msg.event.pausedBody(clockText(until), formatDuration(Math.max(0, until - Date.now())), review),
			msg.event.pausedReason(clip(oneLine(reason), FAILURE_WIDTH)),
		),
	/** 指挥官自己的回合因瞬时故障中断、手上的事件还没处理：恢复后补的唤醒。 */
	masterResume: (reason: string) => notice(msg.event.masterResume, msg.event.masterResumeBody(clip(oneLine(reason), FAILURE_WIDTH))),
};

/** 落定类正文末尾追加 Worker 本次运行耗时（子代理会话写下的轮记录给出）；没有记录或非落定事件不追加，不用别处的计时冒充。 */
export function withElapsed(event: MasterEvent, { run, task }: { run?: number; task?: number }): string {
	const parts = [
		...(run === undefined || !event.settled ? [] : [`${root.envelope.thisRun} ${formatDuration(run)}`]),
		...(task === undefined ? [] : [`${root.envelope.currentTask} ${formatDuration(task)}`]),
	];
	return parts.length ? `${event.body}\n${root.envelope.elapsed}${parts.join(" · ")}` : event.body;
}
