import { defineMessages } from "../i18n.js";

export const msg = defineMessages({
	zh: {
		newSession: "新会话",
		working: "处理中",
		waitingWorkers: (count: number) => `等待 ${count} 个子代理`,
		review: "审查",
		reviewRound: (round: number) => `第${round}轮`,
		reviewBlocked: (count: number) => `${count} 阻断`,
		reviewStage: { queued: "排队中", advisor: "顾问介入", fixing: "修复中", summarizing: "总结中" },
		rename: { title: "重命名会话", placeholder: "新名字", done: (name: string) => `会话已改名：${name}` },
	},
	en: {
		newSession: "New session",
		working: "Working",
		waitingWorkers: (count: number) => `Waiting for ${count} ${count === 1 ? "worker" : "workers"}`,
		review: "Review",
		reviewRound: (round: number) => `round ${round}`,
		reviewBlocked: (count: number) => `${count} blocking`,
		reviewStage: { queued: "queued", advisor: "advisor", fixing: "fixing", summarizing: "summarizing" },
		rename: { title: "Rename session", placeholder: "New name", done: (name: string) => `Session renamed: ${name}` },
	},
});
