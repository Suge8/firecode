/**
 * 轮次时钟：以一次人类输入为单位累计主会话的运行时长。
 * 来源是 agent_start / agent_end 与 Master 发布的在飞子代理数；重载后恢复的历史轮次没有记录，时长未知。
 * 运行区间 = 会话进行中（指挥官回合在跑或有子代理在飞）：指挥官回合结束而子代理仍在飞时区间不闭合，
 * 所以等待期保持运行态、耗时含等待，全部落定且指挥官歇下才定格。
 */
import { sessionBusy } from "../busy.js";

/** 子代理结果到达后摘要行高亮多久。 */
export const ARRIVAL_FLASH_MS = 2500;

export interface TurnView {
	/** 主会话正在跑且这是最后一轮。 */
	live: boolean;
	/** 累计运行时长；未知时为 undefined。 */
	elapsed?: number;
	/** 最近一次落定距今；从未观察到落定为 undefined。 */
	sinceEnd?: number;
}

export class TurnClock {
	private runStart?: number;
	private agentRunning = false;
	private inFlight = 0;
	private lastKey?: object;
	private readonly spent = new WeakMap<object, number>();
	private readonly endedAt = new WeakMap<object, number>();
	private readonly arrivals = new WeakMap<object, number>();

	constructor(private readonly now: () => number = Date.now) {}

	begin(): void {
		this.agentRunning = true;
		this.runStart ??= this.now();
	}

	finish(): void {
		this.agentRunning = false;
		this.settleIfIdle();
	}

	/** Master 发布的在飞子代理数。 */
	setWaiting(inFlight: number): void {
		this.inFlight = inFlight;
		this.settleIfIdle();
	}

	/** 指挥官已歇下、只在等子代理：摘要显示“等待 N 个子代理”。 */
	get waiting(): number {
		return this.runStart !== undefined && !this.agentRunning ? this.inFlight : 0;
	}

	/** 运行区间记到最后一轮名下。 */
	private settleIfIdle(): void {
		const key = this.lastKey;
		if (this.runStart === undefined || sessionBusy(this.agentRunning, this.inFlight)) return;
		if (key) {
			const now = this.now();
			this.spent.set(key, (this.spent.get(key) ?? 0) + now - this.runStart);
			this.endedAt.set(key, now);
		}
		this.runStart = undefined;
	}

	/** 投影每次渲染声明当前最后一轮。 */
	track(key: object): void {
		this.lastKey = key;
	}

	view(key: object): TurnView {
		const live = this.runStart !== undefined && key === this.lastKey;
		const base = this.spent.get(key);
		const ended = this.endedAt.get(key);
		return {
			live,
			elapsed: live ? (base ?? 0) + this.now() - this.runStart! : base,
			sinceEnd: !live && ended !== undefined ? this.now() - ended : undefined,
		};
	}

	/** 机器消息距首次出现多久；只有运行中出现的才算“新到达”，恢复的历史永远是旧的。 */
	arrivalAge(item: object): number {
		if (!this.arrivals.has(item)) this.arrivals.set(item, this.runStart === undefined ? -Infinity : this.now());
		return this.now() - this.arrivals.get(item)!;
	}
}
