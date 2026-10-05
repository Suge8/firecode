/**
 * 轮记录：一段会话进行中（一次人类输入到歇下，含等子代理）的事后事实——整段时长与终态。
 * 歇下边沿写成官方 CustomEntry 持久化，自己不占行；过程组摘要行落定时读它，重载后依然有数。
 */
import type { CustomEntry, EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { SettledRound } from "../busy.js";
import { parseEnvelopes } from "../deliver.js";
import { textOf } from "../format.js";

export const ROUND_ENTRY = "firecode-round";
/** 轮记录写进会话之后在进程内总线上发布（无 payload）：订阅方此刻读分支一定已含这条记录，不依赖歇下边沿的订阅顺序。 */
export const ROUND_RECORDED_CHANNEL = "firecode:round-recorded";

export interface Round extends SettledRound {
	/** 歇下时刻（宿主记录的 entry 时间戳）。 */
	at: number;
}

/** 零行标记组件：只把记录带进聊天树，供投影按能力识别。 */
interface RoundMarker extends Component {
	round: Round;
}

/** 零行标记：投影按 roundOf 识别。会话里的轮记录经宿主渲染成它，没有轮记录的会话（子代理）也可按运行边界直接造。 */
export function roundMarker(round: Round): Component {
	const marker: RoundMarker = { round, render: () => [], invalidate() {} };
	return marker;
}

/** 本模块写的 entry 一定带 data；类型上的 data? 只是宿主给所有 CustomEntry 的通用形状。 */
export const renderRound: EntryRenderer<SettledRound> = (entry: CustomEntry<SettledRound>) =>
	roundMarker({ ...(entry.data as SettledRound), at: Date.parse(entry.timestamp) });

/** 一轮里更早的非完成终态的短标记。 */
const EARLIER_TEXT = { aborted: "中断过", error: "请求失败过" } as const;

/**
 * 一轮可能有多条记录（中断后又跑了一段，如 /fire-review 或命令触发的再次进行）。合成规则不丢信息：
 * 耗时累加（用户关心这一轮总共花了多久），终态与落定时刻取最后一条（这一轮最终怎样），更早的中断/请求失败
 * 以“中断过 N 次”追加；多段的均速没有请求墙钟无法合成，按“不出半截的数”不给。
 */
export interface TurnRecord {
	round: Round;
	earlier: string[];
}

export function combineRounds(rounds: readonly Round[]): TurnRecord | undefined {
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

/** 会话分支条目里本模块读到的部分（宿主 SessionEntry 的结构子集）。 */
export type BranchEntry =
	| { type: "custom"; customType: string; data?: unknown; timestamp: string }
	| { type: "message"; message: { role: string; content?: unknown } }
	| { type: string };

const isHumanEntry = (entry: BranchEntry) => entry.type === "message" && "message" in entry
	&& entry.message.role === "user" && !parseEnvelopes(textOf(entry.message.content));

/** 会话条目若是轮记录，给出它（带落定时刻）；子代理全过程视图与 Master 的本次运行耗时都按它读子代理会话。 */
export function roundFromEntry(entry: unknown): Round | undefined {
	const record = entry as { type?: unknown; customType?: unknown; data?: unknown; timestamp?: unknown };
	if (record?.type !== "custom" || record.customType !== ROUND_ENTRY || typeof record.timestamp !== "string") return undefined;
	return { ...(record.data as SettledRound), at: Date.parse(record.timestamp) };
}

/**
 * 当前分支最近一轮的落定事实：最近一条人类消息之后的全部轮记录，按 combineRounds 合成。
 * 输入框上边框落定态读它，与摘要行是同一份记录、同一条合成规则。
 */
export function latestTurnRecord(branch: readonly BranchEntry[]): TurnRecord | undefined {
	const rounds: Round[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isHumanEntry(entry)) break;
		const round = roundFromEntry(entry);
		if (round) rounds.unshift(round);
	}
	return combineRounds(rounds);
}

/** 宿主把 entry 包成 Container（Spacer + 渲染器组件）；按能力找标记，不依赖类身份。 */
export function roundOf(component: Component): Round | undefined {
	const children = (component as { children?: readonly Component[] }).children;
	return children?.find((child): child is RoundMarker => "round" in child)?.round;
}
