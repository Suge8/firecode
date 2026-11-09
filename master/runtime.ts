/**
 * 一个指挥官会话的运行时：持久化档案（store）、按名字索引的 Worker 运行时事实（live）与事件发件箱。不认识界面：
 * 活动列表与全过程视图由 index.ts 挂载，读 activityFacts() 并经 onChange 重绘。
 * 运行时事实只在进程内；档案与 JSONL 才是身份与续派的事实源。会话关闭后 closed 置位，迟到的异步续延一律作废。
 */
import { getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { HEAT_COLORS, paint } from "../flame.js";
import type { ReviewRoundProgress } from "../review/outcome.js";
import { roundFromEntry } from "../round.js";
import { withElapsed, type MasterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import { Outbox } from "./outbox.js";
import type { ActivityFacts, SettledFact, WorkerFacts } from "./phase.js";
import { ProgressLines } from "./progress.js";
import type { InProcessSessionPool } from "../spawn.js";
import { STATUS_KEYS } from "../status-keys.js";
import type { Roles } from "./roles.js";
import { subagentInfos, type SubagentInfo } from "./roster.js";
import { MasterStore, masterStatePath, type WorkerRef } from "./state.js";

/** 一次回到 idle（落定、被中断、暂停、续跑失败）：下一份档案、活动列表上的结局（暂停没有）、给指挥官的事件。 */
export interface Landing {
	worker: WorkerRef;
	outcome?: Omit<SettledFact, "at">;
	event?: MasterEvent;
	/** 只告知不唤醒；省略按这次运行的来源（落定前的档案）。 */
	informOnly?: boolean;
	at?: number;
}

/** 注册时定下、跨会话不变的配置与依赖。 */
export interface MasterSetup {
	pi: ExtensionAPI;
	pool: InProcessSessionPool;
	/** 在跑子代理进展行的模型链（配置 background.model）；false 不生成。 */
	progress: ModelChain | false;
	exclusions: string[];
	/** fire-review 不可用的原因；可用时为 undefined。 */
	reviewGate?: string;
	/** 在飞子代理数的唯一发布口（跨会话保持上次发布值以便配对）。 */
	publishInFlight(count: number): void;
	/** 子代理名册的唯一发布口（内容没变不发）。 */
	publishRoster(workers: SubagentInfo[]): void;
	/** 本段会话进行中的起点（busy.ts 的 since，与上边框计时同一事实）；歇下时为 undefined。 */
	sessionSince(): number | undefined;
}

interface CurrentTool {
	tool: string;
	args: unknown;
}

/**
 * 一个回合或一次审查：从开会话、宿主前置阶段到落定。档案进入 working/reviewing 的同一同步段挂上，落定回调只认自己这一个。
 * 宿主 prompt 的前置阶段（input 处理器、鉴权）里会话仍报空闲，落在那里的 abort 会被静默丢弃；所以碰会话的中止与补话（run.ts 的
 * interruptTurn、steerTurn）在后台先等 running，动作本身不等：回合在飞时给出它的会话，没开成（开会话失败、准备期间被 kill、输入被处理器吃掉）给 undefined，此后也不会在飞。
 */
export interface Turn {
	readonly running: Promise<AgentSession | undefined>;
	/** interrupt 记下的意图：回合落定时按中断处理；审查以取消收场时按中断落定（义务保留），而不是审查失败。 */
	interrupted?: true;
}

/** 一个 Worker 名下的全部运行时事实；kill 时整条删除。 */
export interface WorkerLive {
	/** start 已占名但档案尚未落盘。 */
	starting?: true;
	/** send/review 的准备过程单飞。 */
	transitioning?: true;
	/** 最近一个回合或审查；working/reviewing 时就是在跑的那一个。还没跑过时是一个从未在飞的回合。 */
	turn: Turn;
	interruptTimer?: NodeJS.Timeout;
	/** 暂停后的自动续跑计时（档案里的 resume.at）：run.ts 的 armResume。 */
	resumeTimer?: NodeJS.Timeout;
	/** 本次运行（start/send/review 投递）的起点：活动列表的实时耗时，以及从子代理会话里挑出属于这次运行的轮记录。 */
	runStartedAt?: number;
	/** 无输出计时的起点：本回合开始（runWorker）或其后最近一次输出（模型 token 或工具事件），活动列表据此判卡住。 */
	quietSince?: number;
	/** 停摆检查计时：只在“卡住”可能成立的时刻看一眼（run.ts 的 watchStall）。 */
	stallTimer?: NodeJS.Timeout;
	/** 这段无输出已报给指挥官：同一次运行不再报，有输出后清掉、可再报。 */
	stallReported?: true;
	currentTools: Map<string, CurrentTool>;
	/** 已告知指挥官的子代理扩展错误（扩展 + 事件 + 原文）：同一处错误只报一次。 */
	reportedErrors: Set<string>;
	reviewProgress?: ReviewRoundProgress;
	/** 最近一次落定的时刻：池起释放计时、列表“落定 X 前”与活动列表冻结耗时共用这一份。 */
	idleAt?: number;
	/** 活动列表上的落定结局；ack 清掉失败与被中断，完成留到 kill。 */
	outcome?: Omit<SettledFact, "at">;
	observed?: { session: AgentSession; sessionPath: string; unsubscribe: () => void };
}

/** 边框身份：纯文字，子代理状态由输入框上方的活动列表承担。 */
const MASTER_IDENTITY = paint(HEAT_COLORS.orange, msg.command.identity);

const newLive = (): WorkerLive => ({
	turn: { running: Promise.resolve(undefined) }, currentTools: new Map(), reportedErrors: new Set(),
});

export class MasterRuntime {
	readonly store: MasterStore;
	readonly outbox: Outbox;
	readonly live = new Map<string, WorkerLive>();
	/** 在跑子代理的进展行；配置关闭时没有。 */
	readonly progress?: ProgressLines;
	/** 最近取出的启动序；接着档案里已有的最大值，恢复后新 start 仍排在后面。 */
	private launchSeq: number;
	private publishScheduled = false;
	private closedValue = false;
	private readonly stopReleaseWatch: () => void;
	/** 子代理会话被接上订阅（冷启动或重开）时通知：全过程视图据此在第一条事件之前接上自己的订阅。 */
	private readonly sessionListeners = new Set<(name: string) => void>();
	/** 子代理被移除（kill 或启动失败撤票）时通知：全过程视图据此显示已移除。 */
	private readonly removedListeners = new Set<(name: string) => void>();
	/** 事实变化时通知（活动列表重绘）。 */
	private readonly changeListeners = new Set<() => void>();

	/** roles：这次会话核对过的角色表（roles.ts）。 */
	constructor(readonly setup: MasterSetup, readonly ctx: ExtensionContext, readonly roles: Roles) {
		this.outbox = new Outbox({ pi: setup.pi, ctx, timing: setup.pool.timing, changed: () => this.schedulePublish() });
		if (setup.progress)
			this.progress = new ProgressLines(setup.progress, {
				complete: (chain, context, options) => setup.pool.complete(chain, context, options),
				timing: setup.pool.timing,
				changed: () => this.render(),
				warn: (text) => ctx.ui.notify(text, "warning"),
			});
		this.store = new MasterStore(masterStatePath(getAgentDir(), ctx.sessionManager.getSessionId()), () => this.render());
		this.launchSeq = Math.max(0, ...this.store.workers.map((worker) => worker.launch));
		// 池空闲释放热会话后放掉订阅：不再持有已关闭的会话。
		this.stopReleaseWatch = setup.pool.onRelease((sessionPath) => {
			for (const live of this.live.values())
				if (live.observed?.sessionPath === sessionPath) this.unobserve(live);
		});
	}

	get closed(): boolean {
		return this.closedValue;
	}

	assertOpen(): void {
		if (this.closedValue) throw new Error(msg.runtime.replaced);
	}

	/** 事实变化后的唯一重绘入口：在飞数、名册、边框身份与 onChange 的订阅方（活动列表）。 */
	render(): void {
		if (this.closedValue) return;
		this.schedulePublish();
		this.ctx.ui.setStatus(STATUS_KEYS.master, MASTER_IDENTITY);
		for (const notify of this.changeListeners) notify();
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	/**
	 * 在飞数与名册的唯一发布点：状态、当前动作、审查进度、落定时刻或待发事件变化后调用，同一同步段合并成一次发布。
	 * 落定先改档案、随后才入队事件，合并避免中间闪出一次在飞归零；两个发布口各自丢弃没变的内容。
	 */
	schedulePublish(): void {
		if (this.publishScheduled) return;
		this.publishScheduled = true;
		queueMicrotask(() => {
			this.publishScheduled = false;
			if (this.closedValue) return;
			this.setup.publishInFlight(this.inFlight());
			this.setup.publishRoster(subagentInfos(this.activityFacts(), Date.now()));
		});
	}

	liveOf(name: string): WorkerLive {
		let live = this.live.get(name);
		if (!live) this.live.set(name, live = newLive());
		return live;
	}

	/** start 同步段占名并取启动序（并发 start 越过后续 await 的先后不定，序号必须在此取）。 */
	reserve(name: string): { live: WorkerLive; launch: number } {
		const live: WorkerLive = { ...newLive(), starting: true };
		this.live.set(name, live);
		return { live, launch: ++this.launchSeq };
	}

	/**
	 * 移除子代理的唯一入口：删名下全部运行时事实与档案，档案确有这一票时通知订阅方。
	 * 运行时事实只删属于 expected 的那一条（kill 后同名重开的新票不受影响）。
	 */
	remove(name: string, expected = this.live.get(name)): void {
		// 先删档案：写盘失败时照常抛错，运行时事实与档案都不动。
		const removed = this.store.remove(name);
		const live = this.live.get(name);
		if (live && live === expected) {
			clearTimeout(live.interruptTimer);
			clearTimeout(live.resumeTimer);
			clearTimeout(live.stallTimer);
			if (live.observed) this.unobserve(live);
			this.live.delete(name);
			this.progress?.remove(name);
		}
		if (!removed) return;
		for (const notify of this.removedListeners) notify(name);
	}

	/**
	 * 没有调用方可抛的续延（回合与审查落定、计时器、换模型回调）的唯一执行口：失败（如档案写盘失败）报给用户，
	 * 不成为无人处理的拒绝。档案没写成就保持写前的样子，reload 时照常收敛。
	 */
	detached(name: string, task: () => void | Promise<void>): void {
		const report = (error: unknown) => {
			if (!this.closedValue) this.ctx.ui.notify(msg.runtime.detachedFailed(name, error instanceof Error ? error.message : String(error)), "error");
		};
		try {
			const pending = task();
			if (pending) pending.catch(report);
		} catch (error) {
			report(error);
		}
	}

	/** await 之后的唯一重读点：档案已被 kill（或同名换票）就放弃本次动作；准备段占住的会话由 run.ts 的 returnSession 归还。 */
	current(identity: Pick<WorkerRef, "name" | "sessionPath">): WorkerRef {
		this.assertOpen();
		const current = this.find(identity);
		if (current) return current;
		throw new Error(msg.runtime.killed(identity.name));
	}

	/** await 之后的写回只经这里：基于重读的最新档案做函数式更新，不拿 await 前的快照覆盖。 */
	commit(identity: Pick<WorkerRef, "name" | "sessionPath">, update: (current: WorkerRef) => WorkerRef): WorkerRef {
		const next = update(this.current(identity));
		this.store.upsert(next);
		return next;
	}

	/** 同步读：会话未关闭且档案仍是这一票时返回，否则 undefined（落定回调用，不抛）。 */
	find(identity: Pick<WorkerRef, "name" | "sessionPath">): WorkerRef | undefined {
		if (this.closedValue) return undefined;
		const current = this.store.find(identity.name);
		return current?.sessionPath === identity.sessionPath ? current : undefined;
	}

	/**
	 * 回到 idle 的唯一执行口：重读档案（票已不在、或 decide 不接就什么也不做），然后固定顺序写档、登记空闲、入队事件——
	 * 先写档后入队，在飞数的合并发布才不会闪出一次归零。空闲登记记下落定时刻与结局、清掉这次运行的计时与动作，池据此起释放计时。
	 */
	settle(identity: Pick<WorkerRef, "name" | "sessionPath">, decide: (current: WorkerRef) => Landing | undefined): WorkerRef | undefined {
		const current = this.find(identity);
		const landing = current && decide(current);
		if (!landing) return undefined;
		const { worker, outcome, event, informOnly = current.origin === "view", at = Date.now() } = landing;
		this.store.upsert(worker);
		const live = this.liveOf(worker.name);
		live.idleAt = at;
		live.outcome = outcome;
		clearTimeout(live.stallTimer);
		live.stallTimer = undefined;
		live.stallReported = undefined;
		live.currentTools.clear();
		live.reviewProgress = undefined;
		this.progress?.stop(worker.name);
		this.setup.pool.markIdle(worker.sessionPath);
		this.schedulePublish();
		if (event) this.enqueue(event, worker.name, informOnly);
		return worker;
	}

	/**
	 * 给指挥官的事件：正文追加耗时、按档案里的运行来源定是否只告知（视图起的运行指挥官不在等），再交发件箱持久化与投递。
	 * 返回 pending 是否落盘（见 Outbox.enqueue）。
	 */
	enqueue(produced: MasterEvent, worker?: string, informOnly = worker !== undefined && this.store.find(worker)?.origin === "view"): boolean {
		return this.outbox.enqueue(this.withElapsed(produced, worker), worker, informOnly);
	}

	/** 在飞 = 指挥官在等的 working/reviewing，加上唤醒事件还在队列或投递中的子代理。 */
	inFlight(): number {
		const names = this.outbox.awaited();
		for (const worker of this.store.workers)
			if (worker.status !== "idle" && worker.origin !== "view") names.add(worker.name);
		return names.size;
	}

	/**
	 * 本次运行耗时 = 这次运行（start/send/review 起点之后）在子代理会话里写下的轮记录之和：模型切换或审查里的
	 * 修复回合各自成段，合起来才是这次运行。子代理排除了 FireCode（没有轮记录器）或 reload 后起点丢失时省略。
	 * 读得到：宿主在 prompt 结束前发 agent_settled，审查则先写终态 checkpoint 再释放占用，记录都早于这里的读取。
	 */
	private withElapsed(produced: MasterEvent, worker?: string): string {
		const live = worker === undefined ? undefined : this.live.get(worker);
		const since = live?.runStartedAt;
		const branch = live?.observed?.session.sessionManager.getBranch() ?? [];
		const rounds = since === undefined ? [] : branch.flatMap((entry) => {
			const round = roundFromEntry(entry);
			return round && round.at >= since ? [round] : [];
		});
		const sessionSince = this.setup.sessionSince();
		return withElapsed(produced, {
			...(rounds.length ? { run: rounds.reduce((total, round) => total + round.elapsed, 0) } : {}),
			...(sessionSince === undefined ? {} : { task: Date.now() - sessionSince }),
		});
	}

	/** 开始一次运行（start/send/review）：起点归这一次（来源与视图原话在档案里，见 transition.takeOver），旧的中断提醒与暂停续跑作废；给了工作说明就为它起进展行。 */
	beginRun(name: string, prompt?: string): void {
		const live = this.liveOf(name);
		this.cancelTimers(live);
		live.runStartedAt = Date.now();
		if (prompt !== undefined) this.progress?.begin(name, prompt);
		this.schedulePublish();
	}

	/** 暂停后的自动续跑接着这次运行：起点沿用（来源与视图原话在档案里本就沿用）；reload 后起点已丢就从此刻算。 */
	continueRun(name: string): void {
		this.liveOf(name).runStartedAt ??= Date.now();
		this.schedulePublish();
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

	onWorkerRemoved(listener: (name: string) => void): () => void {
		this.removedListeners.add(listener);
		return () => this.removedListeners.delete(listener);
	}

	close(): void {
		this.closedValue = true;
		this.stopReleaseWatch();
		for (const live of this.live.values()) {
			this.cancelTimers(live);
			clearTimeout(live.stallTimer);
			if (live.observed) this.unobserve(live);
		}
		this.live.clear();
		this.progress?.close();
		this.outbox.close();
		this.changeListeners.clear();
		this.ctx.ui.setStatus(STATUS_KEYS.master, undefined);
	}

	/** 指挥官接手（起新运行、ack、interrupt 暂停中的票）时作废还没触发的续跑提醒与自动续跑。 */
	cancelTimers(live: WorkerLive): void {
		clearTimeout(live.interruptTimer);
		clearTimeout(live.resumeTimer);
		live.interruptTimer = live.resumeTimer = undefined;
	}

	private unobserve(live: WorkerLive): void {
		live.observed?.unsubscribe();
		live.observed = undefined;
	}

	/** 相位的输入：所有展示（活动列表、全过程视图、池查询、status、名册）与停摆唤醒都读这一份投影，按启动序。 */
	activityFacts(): ActivityFacts {
		return { workers: this.store.workers.map((worker) => this.workerFacts(worker)), stallMs: this.setup.pool.timing.stallMs };
	}

	/** 一个子代理的档案加这次运行的运行时事实。 */
	workerFacts(worker: WorkerRef): WorkerFacts {
		const live = this.live.get(worker.name);
		const tool = live && [...live.currentTools.values()].at(-1);
		const progress = this.progress?.text(worker.name);
		return {
			worker,
			...(tool ? { tool: { tool: tool.tool, args: tool.args } } : {}),
			...(live?.reviewProgress ? { review: live.reviewProgress } : {}),
			...(live?.runStartedAt === undefined ? {} : { startedAt: live.runStartedAt }),
			...(live?.quietSince === undefined ? {} : { quietSince: live.quietSince }),
			...(progress ? { progress } : {}),
			...(live?.outcome && live.idleAt !== undefined ? { settled: { ...live.outcome, at: live.idleAt } } : {}),
		};
	}
}
