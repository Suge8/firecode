/**
 * 事件发件箱：落定事件先以 pending entry 写进主会话，再经 deliver.ts 投递，成功后写 ack；reload 重投差集。
 * 同一节拍内的落定合并成一条消息。在飞子代理数也在这里算：指挥官在等的 working/reviewing 加上它们的事件还在队列
 * 或投递中的子代理，所以归零只发生在事件交给指挥官之后。视图起的运行（见 RunOrigin）不算在飞，它的事件只告知不唤醒。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliver, inform, wrapEnvelope } from "../deliver.js";
import { roundFromEntry } from "../tools/round.js";
import { MASTER_EVENT_TYPE, withElapsed, type MasterEvent } from "./event-format.js";
import { msg } from "./messages.js";
import type { MasterRuntime } from "./runtime.js";

const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";
const EVENT_RETRY_MS = 5_000;
/** 指挥官空闲时，从第一条结果入队起最多等这么久就唤醒，即使结果还在陆续到达。 */
const WAKE_MAX_MS = 6_000;

interface PendingMasterEvent {
	id: string;
	content: string;
	worker?: string;
	/** 指挥官没在等这个结果（视图起的运行）：只告知不唤醒，也不计入在飞。 */
	inform?: true;
}

export class Outbox {
	private readonly queued: PendingMasterEvent[] = [];
	/** 已交给 deliver、尚未确认送达的事件：投递完成前对应子代理仍算在飞。 */
	private readonly delivering = new Set<PendingMasterEvent>();
	private flushTimer?: NodeJS.Timeout;
	private retrying = false;
	/** 空闲合并窗口里第一条事件入队的时刻。 */
	private firstQueuedAt?: number;

	constructor(private readonly active: MasterRuntime) {}

	/** 新产出的事件：追加耗时、持久化为 pending、排队投递。 */
	enqueue(produced: MasterEvent, worker?: string): void {
		if (this.active.closed) return;
		const informOnly = worker !== undefined && this.active.live.get(worker)?.origin === "view";
		const event: PendingMasterEvent = {
			id: crypto.randomUUID(),
			content: this.withElapsed(produced, worker),
			...(worker ? { worker } : {}),
			...(informOnly ? { inform: true as const } : {}),
		};
		try {
			this.active.setup.pi.appendEntry(PENDING_EVENT_TYPE, event);
		} catch (error) {
			this.active.ctx.ui.notify(msg.outbox.persistFailed(String(error)), "warning");
		}
		this.push(event);
	}

	/** reload 重投 pending 与 ack 的差集：正文已带落定当时的耗时，原样再投。 */
	replayUnacked(ctx: ExtensionContext): void {
		for (const event of unackedEvents(ctx)) this.push(event);
	}

	/** 在飞 = working/reviewing + 已落定但结果事件还在队列或投递中（投递失败重试期间也算）。 */
	inFlight(): number {
		const names = new Set<string>();
		for (const worker of this.active.store.workers)
			if ((worker.status === "working" || worker.status === "reviewing") && this.active.live.get(worker.name)?.origin !== "view")
				names.add(worker.name);
		for (const event of [...this.queued, ...this.delivering]) if (event.worker && !event.inform) names.add(event.worker);
		return names.size;
	}

	close(): void {
		clearTimeout(this.flushTimer);
	}

	/**
	 * 指挥官在跑：立即投（句缝送达，不打断）。指挥官空闲：每次唤醒都是一个完整回合，陆续到达的一批结果
	 * 等一个安静窗口合并成一次唤醒——最后一条入队后 wakeQuietMs 内没有新结果才唤醒，从第一条起最多等 WAKE_MAX_MS。
	 * 只告知的事件不开窗口、立即追加；窗口已开就随那一批唤醒送达。
	 */
	private push(event: PendingMasterEvent): void {
		this.queued.push(event);
		this.active.schedulePublish();
		if (this.retrying) return;
		const quiet = this.active.setup.wakeQuietMs;
		if (!this.active.ctx.isIdle() || quiet <= 0) {
			if (!this.flushTimer || this.firstQueuedAt !== undefined) this.schedule(0);
			return;
		}
		if (event.inform) {
			if (this.firstQueuedAt === undefined) this.schedule(0);
			return;
		}
		this.firstQueuedAt ??= Date.now();
		this.schedule(Math.min(quiet, Math.max(0, this.firstQueuedAt + WAKE_MAX_MS - Date.now())));
	}

	private schedule(delay: number): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => this.flush(), delay);
		this.flushTimer.unref?.();
	}

	private flush(): void {
		const { active } = this;
		if (active.closed) return;
		this.flushTimer = undefined;
		this.retrying = false;
		this.firstQueuedAt = undefined;
		if (!this.queued.length) return;
		const batch = this.queued.splice(0);
		for (const event of batch) this.delivering.add(event);
		const send = batch.every((event) => event.inform) ? inform : deliver;
		send(active.setup.pi, active.ctx, {
			customType: MASTER_EVENT_TYPE,
			content: batch.map((event) => wrapEnvelope("firecode_master_event", event.content)).join("\n\n"),
		}).then(() => {
			if (active.closed) return;
			for (const event of batch) this.delivering.delete(event);
			try {
				active.setup.pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
			} catch (error) {
				active.ctx.ui.notify(msg.outbox.ackFailed(String(error)), "warning");
			}
			for (const event of batch) {
				if (!event.worker) continue;
				const worker = active.store.find(event.worker);
				if (worker?.status === "idle" && worker.disposition !== "reminded")
					active.store.upsert({ ...worker, disposition: "pending" });
			}
			active.schedulePublish();
		}, (error) => {
			if (active.closed) return;
			for (const event of batch) this.delivering.delete(event);
			this.queued.unshift(...batch);
			active.ctx.ui.notify(msg.outbox.deliverFailed(String(error)), "warning");
			this.retrying = true;
			this.schedule(EVENT_RETRY_MS);
		});
	}

	/**
	 * 本次运行耗时 = 这次运行（start/send/review 起点之后）在子代理会话里写下的轮记录之和：fallback 续跑或审查里的
	 * 修复回合各自成段，合起来才是这次运行。子代理排除了 FireCode（没有轮记录器）或 reload 后起点丢失时省略。
	 * 读得到：宿主在 prompt 结束前发 agent_settled，审查则先写终态 checkpoint 再释放占用，记录都早于这里的读取。
	 */
	private withElapsed(produced: MasterEvent, worker?: string): string {
		const live = worker === undefined ? undefined : this.active.live.get(worker);
		const since = live?.runStartedAt;
		const branch = live?.observed?.session.sessionManager.getBranch() ?? [];
		const rounds = since === undefined ? [] : branch.flatMap((entry) => {
			const round = roundFromEntry(entry);
			return round && round.at >= since ? [round] : [];
		});
		const sessionSince = this.active.setup.sessionSince();
		return withElapsed(produced, {
			...(rounds.length ? { run: rounds.reduce((total, round) => total + round.elapsed, 0) } : {}),
			...(sessionSince === undefined ? {} : { task: Date.now() - sessionSince }),
		});
	}
}

function unackedEvents(ctx: ExtensionContext): PendingMasterEvent[] {
	const pending = new Map<string, PendingMasterEvent>();
	const acked = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Record<string, unknown>;
		if (entry.customType === PENDING_EVENT_TYPE && typeof data.id === "string" && typeof data.content === "string")
			pending.set(data.id, {
				id: data.id,
				content: data.content,
				...(typeof data.worker === "string" ? { worker: data.worker } : {}),
				...(data.inform === true ? { inform: true as const } : {}),
			});
		if (entry.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending.values()].filter((event) => !acked.has(event.id));
}
