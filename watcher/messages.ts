import { defineMessages } from "../i18n.js";

export const msg = defineMessages({
	zh: {
		command: "翻转当前会话的观察员开关",
		noArguments: "/fire-watch 不接受参数",
		statusLabel: "观察员",
		enabled: "观察员已开启",
		disabled: "观察员已关闭",
		deliveryFailed: (reason: string) => `观察员这条建议投递失败，已丢弃：${reason}`,
		stopped: (reason: string) => `观察员已停止：${reason}`,
		card: {
			label: "👓 观察员",
			weighNotice: "这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。",
			headline: (turnIndex: number) => `👓 观察员（基于第 ${turnIndex} 回合前的观察）`,
			expandedFooter: "（供权衡，勿盲从）",
		},
		advise: {
			label: "建议",
			description: "向主代理提交一条供权衡的观察建议；每次评估只接受一条，请只提最要紧的那一条。",
			noteDescription: "一句话说清问题与定位。",
			alreadySubmitted: "本次评估已提交过建议；余下的问题留到下一次评估",
			emptyNote: "note 不能为空",
			recorded: "已记录，本次评估结束。",
		},
		transcript: {
			thinking: "（思考）",
			noOutput: "（无输出）",
			separator: "：",
			defaultTool: "工具",
			characters: (count: number) => `<${count} 字符>`,
		},
	},
	en: {
		command: "Toggle the watcher for the current session",
		noArguments: "/fire-watch takes no arguments",
		statusLabel: "Watcher",
		enabled: "Watcher enabled",
		disabled: "Watcher disabled",
		deliveryFailed: (reason: string) => `Could not deliver this watcher suggestion; discarded: ${reason}`,
		stopped: (reason: string) => `Watcher stopped: ${reason}`,
		card: {
			label: "👓 Watcher",
			weighNotice: "This is a second opinion from the watcher for you to weigh, not an instruction: if it conflicts with context you hold, continue by your own judgment.",
			headline: (turnIndex: number) => `👓 Watcher (based on what was observed before turn ${turnIndex})`,
			expandedFooter: "(for weighing; don't follow blindly)",
		},
		advise: {
			label: "Advise",
			description: "Submit one observation for the main agent to weigh; only one is accepted per evaluation, so submit only the most pressing one.",
			noteDescription: "One sentence stating the problem and where it is.",
			alreadySubmitted: "A suggestion was already submitted for this evaluation; leave the remaining issues for the next one",
			emptyNote: "note must not be empty",
			recorded: "Recorded. This evaluation is over.",
		},
		transcript: {
			thinking: "(thinking) ",
			noOutput: "(no output)",
			separator: ": ",
			defaultTool: "tool",
			characters: (count: number) => `<${count} chars>`,
		},
	},
});
