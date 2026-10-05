/**
 * Master 事件正文的唯一产文处：第一行是给人看的标题“<名字> <结果词>”（名字是第一个空格前的词），
 * 给模型的指令放在后续正文。分节标记独占一行“<标记>：”；失败只由“错误：”分节表示——
 * 红色、失败计数与活动列表失败组都从这一个事实来（失败、审查停止、审查未完成；被中断不是失败）。
 * 折叠界面（tools/machine.ts）按标题、“错误：”分节与“耗时：本次运行 …”行投影，改格式两侧都要同步。
 */
import { formatDuration } from "../format.js";
import type { ReviewOutcome } from "../review/outcome.js";

export const MASTER_EVENT_TYPE = "firecode-master-event";

const SECTIONS = {
	reply: "回复：",
	error: "错误：",
	finalReply: "最终回复：",
	advice: "顾问意见：",
} as const;

const OBLIGATION = "此票有审查义务，请显式 review。";

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
const VIEW_MARK = "（你在子代理视图里直接派的）";
const runTitle = (name: string, word: string, view: ViewPrompts) => `${name} ${word}${view.length ? VIEW_MARK : ""}`;
const youSaid = (view: ViewPrompts) => view.map((prompt) => `你说：${prompt}`);

export const masterEvent = {
	returned: (name: string, reply: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, "已返回", view), ...youSaid(view), SECTIONS.reply, reply, obligation ? OBLIGATION : undefined),
	failed: (name: string, error: string, obligation = false, view: ViewPrompts = []) =>
		settled(runTitle(name, "失败", view), ...youSaid(view), SECTIONS.error, error, obligation ? OBLIGATION : undefined),
	interrupted: (name: string, obligation: boolean, view: ViewPrompts = []) =>
		settled(runTitle(name, "被中断", view), ...youSaid(view), obligation ? "会话与审查义务均已保留，可 send 续派" : "会话已保留，可 send 续派"),
	reviewIncomplete: (name: string, reason: string, reply?: string) =>
		settled(`${name} 审查未完成`, SECTIONS.error, reason, ...(reply === undefined ? [] : [SECTIONS.finalReply, reply || "（无回复）"])),
	/** 审查终态；reply 是 Worker 最后一条回复。停止与未完成是失败：原因进“错误：”分节，顾问意见在其后。 */
	review(name: string, outcome: ReviewOutcome, reply: string): MasterEvent {
		const final = [SECTIONS.finalReply, reply || "（无回复）"];
		if (outcome.status === "passed") return settled(`${name} 审查通过（${outcome.rounds} 轮）`, ...final);
		if (outcome.status === "stopped")
			return settled(
				`${name} 审查停止（${outcome.rounds} 轮）`,
				SECTIONS.error,
				outcome.advisorAdvice ? `审查 ${outcome.rounds} 轮未通过，顾问叫停` : `审查 ${outcome.rounds} 轮用尽仍未通过`,
				...(outcome.advisorAdvice ? [SECTIONS.advice, outcome.advisorAdvice] : []),
				...final,
			);
		if (outcome.status === "failed") return masterEvent.reviewIncomplete(name, outcome.reason, reply);
		if (outcome.status === "error") return masterEvent.reviewIncomplete(name, `审查读取失败：${outcome.message}`);
		return masterEvent.reviewIncomplete(name, `审查结束时没有终态：${outcome.status}`);
	},
	/** 只给会话重载打断的回合：指挥官自己发起的 interrupt 它知道现场，不提醒。 */
	resumeReminder: (name: string) => notice(`${name} 待续跑`, "上次回合被会话重载打断，恢复后一直没有续派；请 send 续派或 kill 收口"),
	stranded: (name: string, texts: string[]) =>
		notice(`${name} 补充说明未送达`, `回合结束时有 ${texts.length} 条补充说明未送达，请重发：`, texts.join("\n---\n")),
	modelSwitched: (name: string, from: string, to: string, reason: string) =>
		notice(`${name} 已切换模型`, `已切换 ${from}→${to}（${reason}），正在同一会话自动续跑`),
};

/** 落定类正文末尾追加 Worker 本次运行耗时（子代理会话写下的轮记录给出）；没有记录或非落定事件不追加，不用别处的计时冒充。 */
export function withElapsed(event: MasterEvent, { run }: { run?: number }): string {
	return run === undefined || !event.settled ? event.body : `${event.body}\n耗时：本次运行 ${formatDuration(run)}`;
}
