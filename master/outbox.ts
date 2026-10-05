/**
 * 事件发件箱：落定事件先以 pending entry 写进主会话，再经 deliver.ts 投递，成功后写 ack；reload 重投差集。
 * 同一节拍内的落定合并成一条消息。在飞子代理数也在这里算：working/reviewing 加上事件还在队列或投递中的子代理，
 * 所以归零只发生在事件交给指挥官之后。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliver, wrapEnvelope } from "../deliver.js";
import { MASTER_EVENT_TYPE, withElapsed, type MasterEvent } from "./event-format.js";
import type { MasterRuntime } from "./runtime.js";

const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";
const EVENT_RETRY_MS = 5_000;

export interface PendingMasterEvent {
	id: string;
	content: string;
	worker?: string;
}

export class Outbox {
	private readonly queued: PendingMasterEvent[] = [];
	/** 已交给 deliver、尚未确认送达的事件：投递完成前对应子代理仍算在飞。 */
	private readonly delivering = new Set<PendingMasterEvent>();
	private flushTimer?: NodeJS.Timeout;
	private inFlightScheduled = false;

	constructor(private readonly active: MasterRuntime) {}

	/** 新产出的事件：追加耗时、持久化为 pending、排队投递。 */
	enqueue(produced: MasterEvent, worker?: string): void {
		if (this.active.closed) return;
		const event: PendingMasterEvent = { id: crypto.randomUUID(), content: this.withElapsed(produced, worker), ...(worker ? { worker } : {}) };
		try {
			this.active.setup.pi.appendEntry(PENDING_EVENT_TYPE, event);
		} catch (error) {
			this.active.ctx.ui.notify(`子代理结果持久化失败，crash 时可能丢失：${String(error)}`, "warning");
		}
		this.push(event);
	}

	/** reload 重投 pending 与 ack 的差集：正文已带落定当时的耗时，原样再投。 */
	replayUnacked(ctx: ExtensionContext): void {
		for (const event of unackedEvents(ctx)) this.push(event);
	}

	/**
	 * 在飞 = working/reviewing + 已落定但结果事件还在队列或投递中（投递失败重试期间也算）。
	 * 落定先改 store、随后才入队事件：同一同步段内合并成一次计算，避免中间闪出一次归零。
	 */
	scheduleInFlight(): void {
		if (this.inFlightScheduled) return;
		this.inFlightScheduled = true;
		queueMicrotask(() => {
			this.inFlightScheduled = false;
			if (this.active.closed) return;
			const names = new Set<string>();
			for (const worker of this.active.store.state.workers)
				if (worker.status === "working" || worker.status === "reviewing") names.add(worker.name);
			for (const event of [...this.queued, ...this.delivering]) if (event.worker) names.add(event.worker);
			this.active.setup.publishInFlight(names.size);
		});
	}

	close(): void {
		clearTimeout(this.flushTimer);
	}

	private push(event: PendingMasterEvent): void {
		this.queued.push(event);
		this.scheduleInFlight();
		if (!this.flushTimer) this.schedule(0);
	}

	private schedule(delay: number): void {
		this.flushTimer = setTimeout(() => this.flush(), delay);
		this.flushTimer.unref?.();
	}

	private flush(): void {
		const { active } = this;
		if (active.closed) return;
		this.flushTimer = undefined;
		if (!this.queued.length) return;
		const batch = this.queued.splice(0);
		for (const event of batch) this.delivering.add(event);
		deliver(active.setup.pi, active.ctx, {
			customType: MASTER_EVENT_TYPE,
			content: batch.map((event) => wrapEnvelope("firecode_master_event", event.content)).join("\n\n"),
		}).then(() => {
			if (active.closed) return;
			for (const event of batch) this.delivering.delete(event);
			try {
				active.setup.pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
			} catch (error) {
				active.ctx.ui.notify(`子代理结果确认写入失败，reload 后可能重复投递：${String(error)}`, "warning");
			}
			for (const event of batch) {
				if (!event.worker) continue;
				const worker = active.store.state.workers.find((candidate) => candidate.name === event.worker);
				if (worker?.status === "idle" && worker.disposition !== "reminded")
					active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker, disposition: "pending" } });
			}
			this.scheduleInFlight();
		}, (error) => {
			if (active.closed) return;
			for (const event of batch) this.delivering.delete(event);
			this.queued.unshift(...batch);
			active.ctx.ui.notify(`子代理结果投递失败，将自动重试：${String(error)}`, "warning");
			this.schedule(EVENT_RETRY_MS);
		});
	}

	/** 两个起点各只有运行时一处记录；reload 后缺失的部分省略。 */
	private withElapsed(produced: MasterEvent, worker?: string): string {
		const now = Date.now();
		const runStartedAt = worker === undefined ? undefined : this.active.live.get(worker)?.runStartedAt;
		const { taskStartedAt } = this.active;
		return withElapsed(produced, {
			...(runStartedAt === undefined ? {} : { run: now - runStartedAt }),
			...(taskStartedAt === undefined ? {} : { task: now - taskStartedAt }),
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
			pending.set(data.id, { id: data.id, content: data.content, ...(typeof data.worker === "string" ? { worker: data.worker } : {}) });
		if (entry.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending.values()].filter((event) => !acked.has(event.id));
}
