import { defineMessages } from "../i18n.js";

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

export const msg = defineMessages({
	zh: {
		windowTooSmall: (need: number, window: number) => `摘要输入约 ${thousands(need)} token（含输出余量），超出上下文窗口 ${thousands(window)}`,
		chainFailed: (reason: string) => `后台模型没能写出压缩摘要，这次改用 pi 默认压缩（会话模型）：${reason}`,
		idleFailed: (reason: string) => `闲置压缩没准备好：${reason}`,
		idleApplied: (minutes: number, before: number, after: number | undefined) =>
			`闲置 ${minutes} 分钟，缓存已过期，已压缩上下文：${thousands(before)}${after === undefined ? "" : ` → ${thousands(after)}`}`,
		idleApplyFailed: (reason: string) => `闲置压缩失败：${reason}`,
		idlePreparing: "压缩准备中",
		idleArmed: "缓存已过期，发送前压缩",
		progress: {
			brief: (text: string) => `工作说明：${text}`,
			previous: (text: string) => `上一句：${text}`,
			notes: (text: string) => `新动态：\n${text}`,
			said: (text: string) => `说：${text}`,
			empty: "模型没有给出进展",
			failing: (count: number, reason: string) => `进展行连续 ${count} 次生成失败：${reason}`,
		},
	},
	en: {
		windowTooSmall: (need: number, window: number) => `the summary input is about ${thousands(need)} tokens with output room, over the ${thousands(window)} context window`,
		chainFailed: (reason: string) => `The background model could not write the compaction summary; Pi's default compaction (session model) is used this time: ${reason}`,
		idleFailed: (reason: string) => `Idle compaction isn't ready: ${reason}`,
		idleApplied: (minutes: number, before: number, after: number | undefined) =>
			`Idle ${minutes} min, cache expired; context compacted: ${thousands(before)}${after === undefined ? "" : ` → ${thousands(after)}`}`,
		idleApplyFailed: (reason: string) => `Idle compaction failed: ${reason}`,
		idlePreparing: "preparing compaction",
		idleArmed: "cache expired, compacts before send",
		progress: {
			brief: (text: string) => `Brief: ${text}`,
			previous: (text: string) => `Previous: ${text}`,
			notes: (text: string) => `New activity:\n${text}`,
			said: (text: string) => `Said: ${text}`,
			empty: "The model gave no progress line",
			failing: (count: number, reason: string) => `Progress lines failed ${count} times in a row: ${reason}`,
		},
	},
});
