/**
 * 轮记录的宿主适配：宿主把 entry 渲染成零行标记组件，把记录带进聊天树，过程组投影按能力识别。
 * 记录的格式、测量与读取在根 round.ts。
 */
import type { CustomEntry, EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type Round, roundAt, type SettledRound } from "../round.js";

/** 零行标记组件：只把记录带进聊天树，供投影按能力识别。 */
interface RoundMarker extends Component {
	round: Round;
}

/** 零行标记：投影按 roundOf 识别。会话里的轮记录经宿主渲染成它，没有轮记录的会话（子代理）也可按运行边界直接造。 */
export function roundMarker(round: Round): Component {
	const marker: RoundMarker = { round, render: () => [], invalidate() {} };
	return marker;
}

/** 轮记录 entry 一定带 data；类型上的 data? 只是宿主给所有 CustomEntry 的通用形状。 */
export const renderRound: EntryRenderer<SettledRound> = (entry: CustomEntry<SettledRound>) =>
	roundMarker(roundAt(entry.data as SettledRound, entry.timestamp));

/** 宿主把 entry 包成 Container（Spacer + 渲染器组件）；按能力找标记，不依赖类身份。 */
export function roundOf(component: Component): Round | undefined {
	const children = (component as { children?: readonly Component[] }).children;
	return children?.find((child): child is RoundMarker => "round" in child)?.round;
}
