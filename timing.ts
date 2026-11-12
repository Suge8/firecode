/**
 * 进程内全部“等多久”的业务时限，以及它们唯一的注入点：生产用 DEFAULT_TIMING，
 * 端到端测试经池的构造参数缩短（池由入口建一次并传给 Master 与审查，读者都从 `pool.timing` 取）。
 */
export interface Timing {
	/** 热会话空闲这么久后释放（档案与 JSONL 保留）。 */
	idleSessionMs: number;
	/**
	 * 释放会话时，中止在跑的回合后最多等这么久让它落定，再发 session_shutdown（顺序的理由见 spawn.ts 的 release）。
	 * 正常的中止在流读到信号后立刻落定；模型流卡在半开连接上时永不落定（Bun fetch 在网络切换后不保证响应 AbortSignal），
	 * 这类会话到点照旧收口。取 2 秒：远大于正常落定，又不至于让关会话、退出明显变慢。
	 */
	abortSettleMs: number;
	/** 会话重载打断的回合，恢复后这么久仍未续派就提醒指挥官。 */
	interruptResumeMs: number;
	/**
	 * 一批结果陆续返回时，最后一条后静默这么久才唤醒空闲的指挥官：合并唤醒，单条结果最多多等这一下。
	 * 这是业务语义的等待：“这一批还会不会马上再来一条”没有事件能回答。同批结果相邻间隔约 2～3 秒，而唤醒回合本身要数秒，
	 * 1.5 秒足以把紧挨着的并进一次唤醒，回合开跑后再到的走句缝。
	 */
	wakeQuietMs: number;
	/** 事件投递失败后的首次重试间隔，之后逐次翻倍（上限见 outbox.ts）。 */
	eventRetryMs: number;
	/**
	 * 在跑的回合连续这么久没有任何输出（模型 token 或工具事件）就算卡住：活动列表置顶标“N 分钟无输出”，
	 * 同时给指挥官投一条停摆事件并唤醒（同一次运行只报一次，有输出后重新计时）。
	 * 取 30 分钟：本机子代理会话里 2.3 万次构建/测试类工具调用，单次时长 p99 13 分钟、p99.5 18 分钟、p99.9 35 分钟，
	 * 30 分钟以上 38 次（0.17%）；工具时长是无输出时长的上界（边跑边出输出的命令早已算“有输出”）。
	 * 再短会把正常长构建、评测与哨兵盯守当成卡住去叫醒指挥官（按 20 分钟巡查“没动静”时多次误报正常长跑的评测）；
	 * 真卡死的命令一卡就是数小时（ffmpeg 无限输入卡了 8.5 小时），晚报十几分钟代价很小。
	 */
	stallMs: number;
	/**
	 * 瞬时失败（网络、过载、限流）且报错里读不出重置时刻时，第 1、2、3… 次连续失败后多久再试，末项封顶：
	 * 模型路由的冷却、暂停的子代理与指挥官回合的自动续跑共用这一份。首项 1 分钟：断网多在几分钟内恢复，晚续一分钟代价小；
	 * 封顶 15 分钟：长时间故障里每次重试只是一次失败的请求，恢复后最多晚 15 分钟续上。否决 5/15/60 分钟：一次 31 分钟的断网要拖到 80 分钟才续上。
	 */
	cooldownMs: readonly number[];
	/**
	 * 进展行（子代理与主会话）：运行满这么久才出第一句。更短的运行看工具行就够了，不值得为它花一次调用。
	 * 取 30 秒与 Claude Code 后台子代理的状态行同一节奏。
	 */
	progressFirstMs: number;
	/** 进展行两次生成之间至少隔这么久（只在有新输出时才生成）：每个在跑的会话每小时最多 60 次小模型调用。 */
	progressEveryMs: number;
	/**
	 * 闲置压缩的缓存过期线：会话闲置超过它，下一次请求按缓存已失效处理，改从预先算好的摘要开始。
	 * 按 Claude 的 1 小时缓存档定（Claude Code 同样在闲置约 54 分钟、过期前压缩；本机经 magpie 闲置 30 分钟仍完整命中），
	 * 取 55 分钟留 5 分钟余量：过期线之前的请求仍读缓存，此时压缩反而要重写整段前缀。不做保温续期：闲置会话靠这条线压缩。
	 */
	cacheTtlMs: number;
	/**
	 * 闲置压缩的提前量：闲置到“过期线减它”时开始预算摘要。序列化后输入最大约 9.7 万 token，小模型一次要数十秒，
	 * 10 分钟足够算完；提前越多，用户在过期前回来、摘要白算的机会越大（每次约 $0.005）。
	 */
	idleCompactionLeadMs: number;
}

export const DEFAULT_TIMING: Timing = {
	idleSessionMs: 10 * 60_000,
	abortSettleMs: 2_000,
	interruptResumeMs: 5 * 60_000,
	wakeQuietMs: 1_500,
	eventRetryMs: 5_000,
	stallMs: 30 * 60_000,
	cooldownMs: [1, 5, 15].map((minutes) => minutes * 60_000),
	progressFirstMs: 30_000,
	progressEveryMs: 60_000,
	cacheTtlMs: 55 * 60_000,
	idleCompactionLeadMs: 10 * 60_000,
};

/** setTimeout 能表示的最长延迟（2^31−1 ms，约 24.8 天）：超过时运行时按 1ms 立即触发。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 到绝对时刻 at 的计时延迟，截到 setTimeout 上限。at 来自供应商写明的重置时刻，可以远超上限；
 * 截断后回调可能早于 at 触发，调用方在回调里见 `Date.now() < at` 就按同一个 at 重挂。
 */
export function delayUntil(at: number): number {
	return Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
}
