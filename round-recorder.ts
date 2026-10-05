/**
 * 轮记录器：会话歇下时把这一段的整段时长、终态与均速写成轮记录（CustomEntry），写入后在进程内总线上通知。
 * 每个会话都注册——主会话与每个子代理会话跑的是同一段代码、同一个歇下判定（busy.ts），与界面无关：
 * 主会话的摘要行、输入框外壳、子代理全过程视图都只读记录；Master 结果事件的“本次运行”耗时也读子代理会话里的
 * 这份记录，不再在指挥官这边另外计时——同一段时长只有一个事实源，视图与事件不会对不上。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watchBusy } from "./busy.js";
import { ROUND_ENTRY, ROUND_RECORDED_CHANNEL } from "./tools/round.js";

export function registerRoundRecorder(pi: ExtensionAPI): void {
	watchBusy(pi, {
		onSettled: (_ctx, round) => {
			pi.appendEntry(ROUND_ENTRY, round);
			pi.events.emit(ROUND_RECORDED_CHANNEL, undefined);
		},
	});
}
