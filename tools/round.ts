/**
 * 轮记录：一段会话进行中（一次人类输入到歇下，含等子代理）的事后事实——整段时长与终态。
 * 歇下边沿写成官方 CustomEntry 持久化，自己不占行；过程组摘要行落定时读它，重载后依然有数。
 */
import type { CustomEntry, EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { SettledRound } from "../busy.js";

export const ROUND_ENTRY = "firecode-round";

export interface Round extends SettledRound {
	/** 歇下时刻（宿主记录的 entry 时间戳）。 */
	at: number;
}

/** 零行标记组件：只把记录带进聊天树，供投影按能力识别。 */
interface RoundMarker extends Component {
	round: Round;
}

/** 本模块写的 entry 一定带 data；类型上的 data? 只是宿主给所有 CustomEntry 的通用形状。 */
export const renderRound: EntryRenderer<SettledRound> = (entry: CustomEntry<SettledRound>): RoundMarker => ({
	round: { ...(entry.data as SettledRound), at: Date.parse(entry.timestamp) },
	render: () => [],
	invalidate() {},
});

/** 宿主把 entry 包成 Container（Spacer + 渲染器组件）；按能力找标记，不依赖类身份。 */
export function roundOf(component: Component): Round | undefined {
	const children = (component as { children?: readonly Component[] }).children;
	return children?.find((child): child is RoundMarker => "round" in child)?.round;
}
