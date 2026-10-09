/**
 * 轮次时钟：把 busy.ts 的会话进行中事实投影到各轮摘要行——哪一轮开着、机器消息是否刚到。
 * 落定后的耗时与终态不在这里，来自聊天树里的轮记录（round.ts）。
 */
import { type BusyView, IDLE } from "../busy.js";

/** 子代理结果到达后摘要行高亮多久。 */
export const ARRIVAL_FLASH_MS = 2500;

export class TurnClock {
	private busy: BusyView = IDLE;
	private lastKey?: object;
	private readonly arrivals = new WeakMap<object, number>();

	sync(view: BusyView): void {
		this.busy = view;
	}

	/** 指挥官自己的回合在跑；否则这一段只是在等子代理，摘要行没有当前动作可说。 */
	get agentRunning(): boolean {
		return this.busy.agentRunning;
	}

	/** 投影每次渲染声明当前最后一轮。 */
	track(key: object): void {
		this.lastKey = key;
	}

	/** 会话正在进行且这是最后一轮。 */
	live(key: object): boolean {
		return this.busy.busy && key === this.lastKey;
	}

	/** 机器消息距首次出现多久；只有运行中出现的才算“新到达”，恢复的历史永远是旧的。 */
	arrivalAge(item: object): number {
		if (!this.arrivals.has(item)) this.arrivals.set(item, this.busy.busy ? Date.now() : -Infinity);
		return Date.now() - this.arrivals.get(item)!;
	}
}
