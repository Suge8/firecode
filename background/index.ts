/**
 * 后台小模型：配置 background 的两条链是四项后台活唯一的模型来源——lineModel 写进展行与会话名，compactionModel 写压缩摘要与闲置压缩；
 * 省略整节四项都关，压缩回到 pi 默认（会话模型写摘要）。子代理进展行的接线在 master/，本模块管其余：
 * - 主会话进展行：progress.ts，只在主会话且输入框外壳开着时（没有显示处就不花调用）。
 * - 压缩摘要：主会话与子会话的自动压缩与 /compact 都由后台链写摘要（summarize.ts）。整条链都失败时出一条提示，交回 pi 默认压缩，不静默；
 *   子会话没有界面，提示以扩展错误抛出，经 spawn.ts 的 onExtensionError 报给指挥官，宿主同样接着走默认压缩。
 * - 闲置压缩：idle.ts，只在主会话（理由见其头注释）。
 * - 会话命名：naming.ts，只在主会话。触发、写回前复查与只起一次的理由见其头注释。
 * 与原生压缩的先后在 registerOpenAINative：它接管的会话不会走到这里。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { CompactionHook } from "../provider/openai-native/index.js";
import type { InProcessSessionPool } from "../spawn.js";
import { IdleCompaction } from "./idle.js";
import { registerSessionNaming } from "./naming.js";
import { registerSessionProgress } from "./progress.js";
import { msg } from "./messages.js";
import { summarize } from "./summarize.js";

/** 返回交给压缩钩子的后台摘要；没配 background 时 undefined（pi 默认压缩）。 */
export function registerBackground(pi: ExtensionAPI, pool: InProcessSessionPool, subsession: boolean): CompactionHook | undefined {
	const { background, features } = loadConfig().config;
	if (!background) return undefined;
	if (background.sessionNames && !subsession) registerSessionNaming(pi, pool, background.lineModel);
	if (features.statusbar !== false && !subsession) registerSessionProgress(pi, pool, background.lineModel);
	const idle = background.idleCompaction && !subsession ? new IdleCompaction(pi, pool, background.compactionModel) : undefined;
	return async (event, ctx) => {
		const ready = idle?.applying();
		if (ready) return { compaction: ready };
		try {
			const result = await summarize(pool, background.compactionModel, event.preparation, event.customInstructions, event.signal);
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
