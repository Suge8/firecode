/**
 * 后台小模型：配置 background.model 是四项后台活唯一的模型来源——子代理进展行（master/progress.ts）、压缩摘要、闲置压缩与会话命名；
 * 省略整节四项都关，压缩回到 pi 默认（会话模型写摘要）。本模块管后三项：
 * - 压缩摘要：主会话与子会话的自动压缩与 /compact 都由后台链写摘要（summarize.ts）。整条链都失败时出一条提示，交回 pi 默认压缩，不静默；
 *   子会话没有界面，提示以扩展错误抛出，经 spawn.ts 的 onExtensionError 报给指挥官，宿主同样接着走默认压缩。
 * - 闲置压缩：idle.ts，主会话与子会话都有（子代理热会话多数在闲置 Timing.idleSessionMs 后释放、预算随之作废，
 *   但审查中的子代理会一直持有，可能闲过缓存过期线）。
 * - 会话命名：naming.ts，只在主会话。触发、写回前复查与只起一次的理由见其头注释。
 * 与原生压缩的先后在 registerOpenAINative：它接管的会话不会走到这里。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { CompactionHook } from "../provider/openai-native/index.js";
import type { InProcessSessionPool } from "../spawn.js";
import { IdleCompaction } from "./idle.js";
import { registerSessionNaming } from "./naming.js";
import { msg } from "./messages.js";
import { summarize } from "./summarize.js";

/** 返回交给压缩钩子的后台摘要；没配 background 时 undefined（pi 默认压缩）。 */
export function registerBackground(pi: ExtensionAPI, pool: InProcessSessionPool, subsession: boolean): CompactionHook | undefined {
	const background = loadConfig().config.background;
	if (!background) return undefined;
	if (background.sessionNames && !subsession) registerSessionNaming(pi, pool, background.model);
	const idle = background.idleCompaction ? new IdleCompaction(pi, pool, background.model) : undefined;
	return async (event, ctx) => {
		const ready = idle?.applying();
		if (ready) return { compaction: ready };
		try {
			const { result } = await summarize(pool, background.model, event.preparation, event.customInstructions, event.signal);
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			const text = msg.chainFailed(error instanceof Error ? error.message : String(error));
			if (!ctx.hasUI) throw new Error(text);
			ctx.ui.notify(text, "warning");
			return undefined;
		}
	};
}
