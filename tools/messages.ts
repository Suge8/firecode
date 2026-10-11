import { defineMessages } from "../i18n.js";

export const msg = defineMessages({
	zh: {
		thinking: "思考",
		activity: { thinking: "思考中", replying: "回复中" },
		moreReplies: (count: number) => `+${count} 条`,
		labels: { read: "读取", bash: "操作", edit: "修改", write: "写入", grep: "搜索", find: "查找", ls: "列出" },
		failedWorkers: (count: number) => `${count} 个子代理失败`,
		hostShape: (where: string) => `过程分组已停用：宿主组件形状变了（${where}），已保持原生显示；请升级 FireCode`,
		notMethod: (key: string) => `${key} 不是方法`,
	},
	en: {
		thinking: "Thinking",
		activity: { thinking: "Thinking", replying: "Replying" },
		moreReplies: (count: number) => `+${count} more`,
		labels: { read: "Read", bash: "Run", edit: "Edit", write: "Write", grep: "Grep", find: "Find", ls: "List" },
		failedWorkers: (count: number) => `${count} ${count === 1 ? "worker" : "workers"} failed`,
		hostShape: (where: string) => `Process grouping is disabled: the host component shape changed (${where}); native display is kept. Please upgrade FireCode`,
		notMethod: (key: string) => `${key} is not a method`,
	},
});
