/**
 * Master 事件正文的唯一产文处：第一行是给人看的标题“<名字> <结果词>”（名字是第一个空格前的词），
 * 给模型的指令放在后续正文。分节标记独占一行“<标记>：”；失败只由“错误：”分节表示。
 * 折叠界面（tools/machine.ts）按标题、“错误：”分节与“耗时：本次运行 …”行投影，改格式两侧都要同步。
 */
import { formatDuration } from "../format.js";
import type { ReviewOutcome } from "../review/outcome.js";

export const MASTER_EVENT_TYPE = "firecode-master-event";

const SECTIONS = {
	reply: "回复：",
	error: "错误：",
	finalReply: "最终回复：",
	reason: "原因：",
	advice: "顾问意见：",
} as const;

const OBLIGATION = "此票有审查义务，请显式 review。";

const lines = (...parts: (string | undefined)[]) => parts.filter((part) => part !== undefined).join("\n");

export const masterEvent = {
	returned: (name: string, reply: string, obligation = false) =>
		lines(`${name} 已返回`, SECTIONS.reply, reply, obligation ? OBLIGATION : undefined),
	failed: (name: string, error: string, obligation = false) =>
		lines(`${name} 失败`, SECTIONS.error, error, obligation ? OBLIGATION : undefined),
	interrupted: (name: string) => lines(`${name} 被中断`, "会话与审查义务均已保留"),
	resumeReminder: (name: string) => lines(`${name} 待续跑`, "上次回合被外部中断后无人接手，请 send 续派或 kill 收口"),
	stranded: (name: string, texts: string[]) =>
		lines(`${name} 补充说明未送达`, `回合结束时有 ${texts.length} 条补充说明未送达，请重发：`, texts.join("\n---\n")),
	modelSwitched: (name: string, from: string, to: string, reason: string) =>
		lines(`${name} 已切换模型`, `已切换 ${from}→${to}（${reason}），正在同一会话自动续跑`),
	reviewIncomplete: (name: string, reason: string) => lines(`${name} 审查未完成`, SECTIONS.reason, reason),
	/** 审查终态；reply 是 Worker 最后一条回复。 */
	review(name: string, outcome: ReviewOutcome, reply: string): string {
		const final = lines(SECTIONS.finalReply, reply || "（无回复）");
		if (outcome.status === "passed") return lines(`${name} 审查通过（${outcome.rounds} 轮）`, final);
		if (outcome.status === "stopped")
			return lines(`${name} 审查停止（${outcome.rounds} 轮）`, ...(outcome.advisorAdvice ? [SECTIONS.advice, outcome.advisorAdvice] : []), final);
		if (outcome.status === "failed") return lines(`${name} 审查未完成`, SECTIONS.reason, outcome.reason, final);
		if (outcome.status === "error") return masterEvent.reviewIncomplete(name, `审查读取失败：${outcome.message}`);
		return `${name} 审查未完成`;
	},
};

/** 正文末尾追加耗时行（Worker 本次运行、指挥官当前任务）；缺失的部分省略，不用当前时刻冒充。 */
export function withElapsed(content: string, { run, task }: { run?: number; task?: number }): string {
	const parts = [
		...(run === undefined ? [] : [`本次运行 ${formatDuration(run)}`]),
		...(task === undefined ? [] : [`当前任务 ${formatDuration(task)}`]),
	];
	return parts.length ? `${content}\n耗时：${parts.join(" · ")}` : content;
}
