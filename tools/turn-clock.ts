/**
 * 轮次时钟：把 busy.ts 的会话进行中事实投影到各轮摘要行。
 * 运行中只知道“开着”（实时状态与计时只在边框）；歇下边沿把整段时长记到最后一轮名下定格。
 * 重载后恢复的历史轮次没有记录，时长未知。
 */
import { type BusyView, IDLE } from "../busy.js";

/** 子代理结果到达后摘要行高亮多久。 */
export const ARRIVAL_FLASH_MS = 2500;

export interface TurnView {
	/** 会话正在进行且这是最后一轮。 */
	live: boolean;
	/** 歇下时定格的整段时长；未知时为 undefined。 */
	elapsed?: number;
	/** 最近一次落定距今；从未观察到落定为 undefined。 */
	sinceEnd?: number;
}

export class TurnClock {
	private busy: BusyView = IDLE;
	private lastKey?: object;
	private readonly total = new WeakMap<object, number>();
	private readonly endedAt = new WeakMap<object, number>();
	private readonly arrivals = new WeakMap<object, number>();

	constructor(private readonly now: () => number = Date.now) {}

	sync(view: BusyView): void {
		this.busy = view;
	}

	/** 指挥官自己的回合在跑；否则这一段只是在等子代理，摘要行没有当前动作可说。 */
	get agentRunning(): boolean {
		return this.busy.agentRunning;
	}

	/** 歇下边沿：整段时长记到最后一轮名下；同一轮不经人类输入再次进行（如命令触发的回合）则累加。 */
	settle(elapsed: number): void {
		const key = this.lastKey;
		if (!key) return;
		this.total.set(key, (this.total.get(key) ?? 0) + elapsed);
		this.endedAt.set(key, this.now());
	}

	/** 投影每次渲染声明当前最后一轮。 */
	track(key: object): void {
		this.lastKey = key;
	}

	view(key: object): TurnView {
		const live = this.busy.busy && key === this.lastKey;
		const ended = this.endedAt.get(key);
		return {
			live,
			elapsed: live ? undefined : this.total.get(key),
			sinceEnd: !live && ended !== undefined ? this.now() - ended : undefined,
		};
	}

	/** 机器消息距首次出现多久；只有运行中出现的才算“新到达”，恢复的历史永远是旧的。 */
	arrivalAge(item: object): number {
		if (!this.arrivals.has(item)) this.arrivals.set(item, this.busy.busy ? this.now() : -Infinity);
		return this.now() - this.arrivals.get(item)!;
	}
}
