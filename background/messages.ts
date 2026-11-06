import { defineMessages } from "../i18n.js";

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

export const msg = defineMessages({
	zh: {
		windowTooSmall: (need: number, window: number) => `摘要输入约 ${thousands(need)} token（含输出余量），超出上下文窗口 ${thousands(window)}`,
		chainFailed: (reason: string) => `后台模型没能写出压缩摘要，这次改用 pi 默认压缩（会话模型）：${reason}`,
		idleFailed: (reason: string) => `闲置压缩的摘要没算出来，下一次请求照常发出：${reason}`,
		idleApplied: (minutes: number, model: string, before: number, after: number | undefined) =>
			`已闲置 ${minutes} 分钟，缓存已过期：用 ${model} 的摘要压缩，上下文 ${thousands(before)} → ${after === undefined ? "?" : thousands(after)}`,
		idleApplyFailed: (reason: string) => `闲置压缩没能应用，这次请求带完整上下文发出：${reason}`,
	},
	en: {
		windowTooSmall: (need: number, window: number) => `the summary input is about ${thousands(need)} tokens with output room, over the ${thousands(window)} context window`,
		chainFailed: (reason: string) => `The background model could not write the compaction summary; Pi's default compaction (session model) is used this time: ${reason}`,
		idleFailed: (reason: string) => `The idle compaction summary could not be prepared; the next request goes out as usual: ${reason}`,
		idleApplied: (minutes: number, model: string, before: number, after: number | undefined) =>
			`Idle for ${minutes} min, cache expired: compacted with a summary from ${model}, context ${thousands(before)} → ${after === undefined ? "?" : thousands(after)}`,
		idleApplyFailed: (reason: string) => `Idle compaction could not be applied; this request goes out with the full context: ${reason}`,
	},
});
