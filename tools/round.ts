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

/** 一轮里更早的非完成终态的短标记。 */
const EARLIER_TEXT = { aborted: "中断过", error: "请求失败过" } as const;

/**
 * 一轮可能有多条记录（中断后又跑了一段，如 /fire-review 或命令触发的再次进行）。合成规则不丢信息：
 * 耗时累加（用户关心这一轮总共花了多久），终态与落定时刻取最后一条（这一轮最终怎样），更早的中断/请求失败
 * 以“中断过 N 次”追加；多段的均速没有请求墙钟无法合成，按“不出半截的数”不给。
 */
export function combineRounds(rounds: readonly Round[]): { round: Round; earlier: string[] } | undefined {
	const last = rounds.at(-1);
	if (!last) return undefined;
	const elapsed = rounds.reduce((total, round) => total + round.elapsed, 0);
	const round: Round = rounds.length === 1 ? last : { elapsed, outcome: last.outcome, at: last.at };
	const earlier = (["aborted", "error"] as const).flatMap((outcome) => {
		const count = rounds.slice(0, -1).filter((round) => round.outcome === outcome).length;
		return count ? [`${EARLIER_TEXT[outcome]} ${count} 次`] : [];
	});
	return { round, earlier };
}

/** 宿主把 entry 包成 Container（Spacer + 渲染器组件）；按能力找标记，不依赖类身份。 */
export function roundOf(component: Component): Round | undefined {
	const children = (component as { children?: readonly Component[] }).children;
	return children?.find((child): child is RoundMarker => "round" in child)?.round;
}
