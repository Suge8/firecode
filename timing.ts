/**
 * 进程内全部“等多久”的业务时限，以及它们唯一的注入点：生产用 DEFAULT_TIMING，
 * 端到端测试经池的构造参数缩短（池由入口建一次并传给 Master、观察员与审查，读者都从 `pool.timing` 取）。
 */
export interface Timing {
	/** 热会话空闲这么久后释放（档案与 JSONL 保留）。 */
	idleSessionMs: number;
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
}

export const DEFAULT_TIMING: Timing = {
	idleSessionMs: 10 * 60_000,
	interruptResumeMs: 5 * 60_000,
	wakeQuietMs: 1_500,
	eventRetryMs: 5_000,
};
