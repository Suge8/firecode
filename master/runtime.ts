/**
 * 一个指挥官会话的运行时：持久化档案（store）、按名字索引的 Worker 运行时事实（live）、事件发件箱与活动列表。
 * 运行时事实只在进程内；档案与 JSONL 才是身份与续派的事实源。会话关闭后 closed 置位，迟到的异步续延一律作废。
 */
import { getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MasterRole } from "../config.js";
import { HEAT_COLORS, paint } from "../flame.js";
import type { ReviewProgress } from "../review/outcome.js";
import { ActivityList, visibleRows, type ActivityFacts, type SettledFact } from "./activity-list.js";
import { Outbox } from "./outbox.js";
import { openWorkerView } from "./worker-view.js";
import type { InProcessSessionPool } from "./spawn.js";
import { MasterStore, masterStatePath, type MasterState, type WorkerRef } from "./state.js";

/** 注册时定下、跨会话不变的配置与依赖。 */
export interface MasterSetup {
	pi: ExtensionAPI;
	pool: InProcessSessionPool;
	roster: MasterRole[];
	exclusions: string[];
	/** Worker 系统提示；提示词文件坏了时抛错。 */
	workerPrompt(): string;
	/** fire-review 不可用的原因；可用时为 undefined。 */
	reviewGate?: string;
	interruptResumeMs: number;
	/** 指挥官空闲时合并唤醒的安静窗口（见 outbox.ts）。 */
	wakeQuietMs: number;
	/** 在飞子代理数的唯一发布口（跨会话保持上次发布值以便配对）。 */
	publishInFlight(count: number): void;
}

export interface CurrentTool {
	tool: string;
	args: unknown;
	startedAt: number;
}

/** 一个 Worker 名下的全部运行时事实；kill 时整条删除。 */
export interface WorkerLive {
	/** start 到达序号（并发 start 越过 await 的先后不定，只能在同步段取）；reload 恢复的没有。 */
	launch?: number;
	/** start 已占名但档案尚未落盘。 */
	starting?: true;
	/** send/review 的准备过程单飞。 */
	transitioning?: true;
	/** 当前回合的令牌；落定回调只认自己的令牌。 */
	run?: symbol;
	/** interrupt 标记的回合：它落定时按中断处理。 */
	interruptedRun?: symbol;
	interruptTimer?: NodeJS.Timeout;
	/** 本次运行（start/send/review 投递）的起点：活动列表的实时耗时，以及从子代理会话里挑出属于这次运行的轮记录。 */
	runStartedAt?: number;
	/** 这次运行里用户在子代理全过程视图直接说的话；落定事件据此注明来源。 */
	viewPrompts: string[];
	/** 最近一次输出（模型 token 或工具事件），活动列表据此判卡住。 */
	lastOutputAt?: number;
	currentTools: Map<string, CurrentTool>;
	reviewProgress?: ReviewProgress;
	/** 最近一次落定的时刻：池起释放计时、列表“落定 X 前”与活动列表冻结耗时共用这一份。 */
	idleAt?: number;
	/** 活动列表上的落定结局；ack 清掉失败与被中断，完成留到 kill。 */
	outcome?: Omit<SettledFact, "at">;
	observed?: { session: AgentSession; sessionPath: string; unsubscribe: () => void };
}

const LIST_WIDGET_KEY = "firecode-master-list";
/** 边框身份：纯文字，子代理状态由输入框上方的活动列表承担。 */
const MASTER_IDENTITY = paint(HEAT_COLORS.orange, "指挥官");

export class MasterRuntime {
	readonly store: MasterStore;
	readonly outbox: Outbox;
	readonly live = new Map<string, WorkerLive>();
	private launchSeq = 0;
	private list?: ActivityList;
	private closedValue = false;
	private readonly stopReleaseWatch: () => void;
	/** 子代理会话被接上订阅（冷启动或重开）时通知：全过程视图据此在第一条事件之前接上自己的订阅。 */
	private readonly sessionListeners = new Set<(name: string) => void>();

	constructor(readonly setup: MasterSetup, public ctx: ExtensionContext, restored?: MasterState) {
		this.outbox = new Outbox(this);
		this.store = new MasterStore(masterStatePath(getAgentDir(), ctx.sessionManager.getSessionId()), restored, () => this.render());
		// 池空闲释放热会话后放掉订阅：不再持有已关闭的会话。
		this.stopReleaseWatch = setup.pool.onRelease((sessionPath) => {
			for (const live of this.live.values())
				if (live.observed?.sessionPath === sessionPath) this.unobserve(live);
		});
		ctx.ui.setWidget(LIST_WIDGET_KEY, (tui, theme) => {
			this.list = new ActivityList(tui, theme, () => this.activityFacts(),
				() => visibleRows(tui.terminal?.rows), (name) => void openWorkerView(this, name));
			return this.list;
		}, { placement: "aboveEditor" });
	}

	get closed(): boolean {
		return this.closedValue;
	}

	assertOpen(): void {
		if (this.closedValue) throw new Error("Master 会话已替换，取消旧会话动作");
	}

	/** 事实变化后的唯一重绘入口：在飞数、边框身份与活动列表。 */
	render(): void {
		if (this.closedValue) return;
		this.outbox.scheduleInFlight();
		this.ctx.ui.setStatus("master", MASTER_IDENTITY);
		this.list?.sync();
	}

	/** 新的一轮（人类输入）开始：活动列表的展开收起。 */
	collapseList(): void {
		this.list?.collapse();
	}

	liveOf(name: string): WorkerLive {
		let live = this.live.get(name);
		if (!live) this.live.set(name, live = { currentTools: new Map(), viewPrompts: [] });
		return live;
	}

	/** start 同步段占名并取序号。 */
	reserve(name: string): WorkerLive {
		const live: WorkerLive = { currentTools: new Map(), viewPrompts: [], starting: true, launch: ++this.launchSeq };
		this.live.set(name, live);
		return live;
	}

	/** 删掉名下全部运行时事实；只删属于 expected 的那一条（kill 后同名重开的新票不受影响）。 */
	drop(name: string, expected = this.live.get(name)): void {
		const live = this.live.get(name);
		if (!live || live !== expected) return;
		clearTimeout(live.interruptTimer);
		if (live.observed) this.unobserve(live);
		this.live.delete(name);
	}

	/** await 之后的唯一重读点：档案已被 kill（或同名换票）就释放热会话并放弃本次动作。 */
	current(identity: Pick<WorkerRef, "name" | "sessionPath">): WorkerRef {
		this.assertOpen();
		const current = this.store.state.workers.find((worker) => worker.name === identity.name);
		if (current?.sessionPath === identity.sessionPath) return current;
		void this.setup.pool.dispose(identity.sessionPath);
		throw new Error(`${identity.name} 已被 kill，取消本次动作`);
	}

	/** await 之后的写回只经这里：基于重读的最新档案做函数式更新，不拿 await 前的快照覆盖。 */
	commit(identity: Pick<WorkerRef, "name" | "sessionPath">, update: (current: WorkerRef) => WorkerRef): WorkerRef {
		const next = update(this.current(identity));
		this.store.dispatch({ type: "UPSERT_WORKER", worker: next });
		return next;
	}

	/** 同步读：档案仍是这一票时返回，否则 undefined（落定回调用，不抛）。 */
	find(identity: Pick<WorkerRef, "name" | "sessionPath">): WorkerRef | undefined {
		const current = this.store.state.workers.find((worker) => worker.name === identity.name);
		return current?.sessionPath === identity.sessionPath ? current : undefined;
	}

	/** Worker 闲下来的唯一登记点：记落定时刻与结局，池据此起释放计时。 */
	markIdle(worker: WorkerRef, outcome: WorkerLive["outcome"], at = Date.now()): void {
		const live = this.liveOf(worker.name);
		live.idleAt = at;
		live.outcome = outcome;
		live.currentTools.clear();
		live.reviewProgress = undefined;
		this.setup.pool.markIdle(worker.sessionPath);
	}

	/** 开始一次运行（start/send/review）：起点归这一次，旧的中断提醒作废。 */
	beginRun(name: string): void {
		const live = this.liveOf(name);
		clearTimeout(live.interruptTimer);
		live.interruptTimer = undefined;
		live.runStartedAt = Date.now();
		live.viewPrompts = [];
	}

	/** 每个 Worker 只挂一个会话订阅；换了会话（释放后重开）才重挂。 */
	observe(worker: WorkerRef, session: AgentSession, listener: (live: WorkerLive, event: AgentSessionEvent) => void): void {
		this.assertOpen();
		const live = this.liveOf(worker.name);
		if (live.observed?.session === session) return;
		if (live.observed) this.unobserve(live);
		const unsubscribe = session.subscribe((event) => {
			if (!this.closedValue && this.live.get(worker.name) === live) listener(live, event);
		});
		live.observed = { session, sessionPath: worker.sessionPath, unsubscribe };
		for (const notify of this.sessionListeners) notify(worker.name);
	}

	onWorkerSession(listener: (name: string) => void): () => void {
		this.sessionListeners.add(listener);
		return () => this.sessionListeners.delete(listener);
	}

	close(): void {
		this.closedValue = true;
		this.stopReleaseWatch();
		for (const live of this.live.values()) {
			clearTimeout(live.interruptTimer);
			if (live.observed) this.unobserve(live);
		}
		this.live.clear();
		this.outbox.close();
		this.list?.dispose();
		this.ctx.ui.setWidget(LIST_WIDGET_KEY, undefined);
		this.ctx.ui.setStatus("master", undefined);
	}

	private unobserve(live: WorkerLive): void {
		live.observed?.unsubscribe();
		live.observed = undefined;
	}

	/** 活动列表的输入：档案加运行时事实的一次投影（全过程视图按同一顺序换子代理）。 */
	activityFacts(): ActivityFacts {
		const workers = this.store.state.workers;
		const byPath = <T>(pick: (live: WorkerLive) => T | undefined) => new Map(workers.flatMap((worker) => {
			const live = this.live.get(worker.name);
			const value = live && pick(live);
			return value === undefined ? [] : [[worker.sessionPath, value] as const];
		}));
		return {
			workers,
			currentTools: byPath((live) => (live.currentTools.size ? live.currentTools : undefined)),
			reviewProgress: byPath((live) => live.reviewProgress),
			runStartedAt: byPath((live) => live.runStartedAt),
			lastOutputAt: byPath((live) => live.lastOutputAt),
			settled: byPath((live) => (live.outcome && live.idleAt !== undefined ? { ...live.outcome, at: live.idleAt } : undefined)),
			launchOrder: new Map(workers.flatMap((worker) => {
				const launch = this.live.get(worker.name)?.launch;
				return launch === undefined ? [] : [[worker.name, launch] as const];
			})),
		};
	}
}
