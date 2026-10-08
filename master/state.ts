import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { msg } from "./messages.js";

const STATE_VERSION = 9;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinking = (typeof THINKING_LEVELS)[number];
export type WorkerStatus = "working" | "idle" | "reviewing";
export type WorkerDisposition = "pending" | "reminded";

export interface WorkerRef {
	name: string;
	role: string;
	model: string;
	thinking: WorkerThinking;
	status: WorkerStatus;
	sessionPath: string;
	cwd?: string;
	interruptedAt?: number;
	/**
	 * 启动序：start 在同步段按到达先后取的单调序号，活动列表与全过程视图按它排。必须持久化：并行 start 越过
	 * await 后落盘的先后（以及任何落盘时刻）与到达先后不一致，恢复后若靠别的字段排会换序。
	 */
	launch: number;
	reviewNeeded?: boolean;
	disposition?: WorkerDisposition;
}

export interface MasterState {
	version: typeof STATE_VERSION;
	workers: WorkerRef[];
}

export type MasterEvent =
	| { type: "UPSERT_WORKER"; worker: WorkerRef }
	| { type: "REMOVE_WORKER"; name: string }
	| { type: "CLEAR" };

export function initialMasterState(): MasterState {
	return { version: STATE_VERSION, workers: [] };
}

export function reduceMaster(state: MasterState, event: MasterEvent): MasterState {
	switch (event.type) {
		case "UPSERT_WORKER":
			return { ...state, workers: upsertWorker(state.workers, event.worker) };
		case "REMOVE_WORKER": {
			const workers = state.workers.filter((worker) => worker.name !== event.name);
			return workers.length === state.workers.length ? state : { ...state, workers };
		}
		case "CLEAR":
			return initialMasterState();
	}
}

export function recoverMasterState(state: MasterState, interruptedAt = Date.now()): MasterState {
	let changed = false;
	const workers = state.workers.map((worker) => {
		if (worker.status === "idle") return worker;
		changed = true;
		return { ...worker, status: "idle" as const, interruptedAt };
	});
	return changed ? { ...state, workers } : state;
}

export function restoreMasterState(data: unknown): MasterState | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== STATE_VERSION || !Array.isArray(record.workers) || !record.workers.every(isWorker))
		return undefined;
	const workers = record.workers as WorkerRef[];
	if (new Set(workers.map((worker) => worker.name)).size !== workers.length) return undefined;
	if (new Set(workers.map((worker) => worker.sessionPath)).size !== workers.length) return undefined;
	return { version: STATE_VERSION, workers };
}

export class LegacyMasterStateError extends Error {
	constructor(readonly version: number) {
		super(msg.state.legacy(version, STATE_VERSION));
	}
}

/** 子代理池档案：与运行配置同一个 Pi Agent 目录（含 PI_CODING_AGENT_DIR 覆写），按主会话 id 分文件。 */
export function masterStatePath(agentDir: string, sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	return join(agentDir, "tmp", `firecode-master-${safeId}.json`);
}

export function loadMasterState(path: string): MasterState | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(msg.state.invalidJson(path));
	}
	const version = (data as { version?: unknown } | null)?.version;
	if (typeof version === "number" && version !== STATE_VERSION && version !== 8) throw new LegacyMasterStateError(version);
	const state = restoreMasterState(version === 8 ? migrateFromV8(data as { workers?: unknown }) : data);
	if (!state) throw new Error(msg.state.invalidShape(path));
	return state;
}

export class MasterStore {
	private stateValue: MasterState;
	private readonly path: string;
	private readonly onChange?: () => void;
	readonly discardedLegacyVersion?: number;

	constructor(path: string, restored?: MasterState, onChange?: () => void) {
		this.path = path;
		this.onChange = onChange;
		if (restored) this.stateValue = restored;
		else {
			const loaded = this.loadOwnedState();
			this.stateValue = loaded.state;
			this.discardedLegacyVersion = loaded.discardedLegacyVersion;
		}
	}

	get state(): MasterState {
		return this.stateValue;
	}

	dispatch(event: MasterEvent): MasterState {
		const next = reduceMaster(this.stateValue, event);
		if (next === this.stateValue) return next;
		if (event.type === "CLEAR") rmSync(this.path, { force: true });
		else writeState(this.path, next);
		this.stateValue = next;
		this.onChange?.();
		return next;
	}

	private loadOwnedState(): { state: MasterState; discardedLegacyVersion?: number } {
		try {
			return { state: loadMasterState(this.path) ?? initialMasterState() };
		} catch (error) {
			if (!(error instanceof LegacyMasterStateError)) throw error;
			rmSync(this.path, { force: true });
			return { state: initialMasterState(), discardedLegacyVersion: error.version };
		}
	}
}

/**
 * v8 → v9 只差启动序：v8 的创建时间是同一先后的近似（并行 start 下可能有出入，从此以 launch 为准），没有创建时间的
 * 是更早版本恢复来的、排最前。升级不丢池：池里是用户仍在用的子代理，丢弃会让指挥官失去它们的会话与审查义务。
 */
function migrateFromV8(data: { workers?: unknown }): unknown {
	if (!Array.isArray(data.workers)) return data;
	const workers = data.workers as Record<string, unknown>[];
	const created = (index: number) => (typeof workers[index]?.createdAt === "number" ? workers[index].createdAt as number : -Infinity);
	const order = workers.map((_, index) => index).sort((a, b) => created(a) - created(b) || a - b);
	return {
		version: STATE_VERSION,
		workers: workers.map((worker, index) => {
			const { createdAt: _createdAt, ...rest } = worker ?? {};
			return { ...rest, launch: order.indexOf(index) + 1 };
		}),
	};
}

export function requireWorker(state: MasterState, name: string): WorkerRef {
	const worker = state.workers.find((candidate) => candidate.name === name);
	if (!worker) throw new Error(msg.state.missing(name));
	return worker;
}

function writeState(path: string, state: MasterState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function upsertWorker(workers: WorkerRef[], worker: WorkerRef): WorkerRef[] {
	const index = workers.findIndex((candidate) => candidate.name === worker.name);
	const sessionOwner = workers.find((candidate) => candidate.sessionPath === worker.sessionPath);
	if (sessionOwner && sessionOwner.name !== worker.name)
		throw new Error(msg.state.pathTaken(worker.sessionPath));
	if (index < 0) return [...workers, worker];
	if (workers[index].sessionPath !== worker.sessionPath)
		throw new Error(msg.state.pathChange(worker.name));
	return workers.map((candidate, position) => (position === index ? worker : candidate));
}

function isWorker(value: unknown): value is WorkerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(record.name) ||
		typeof record.role !== "string" || !record.role ||
		typeof record.model !== "string" || !record.model ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.includes(record.thinking as WorkerThinking) ||
		typeof record.status !== "string" || !isStatus(record.status) ||
		typeof record.sessionPath !== "string" || !record.sessionPath
	) return false;
	if (record.cwd !== undefined && (typeof record.cwd !== "string" || !record.cwd)) return false;
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (typeof record.launch !== "number" || !Number.isInteger(record.launch) || record.launch <= 0) return false;
	if (record.disposition !== undefined && record.disposition !== "pending" && record.disposition !== "reminded")
		return false;
	return true;
}

function isStatus(value: string): value is WorkerStatus {
	return value === "working" || value === "idle" || value === "reviewing";
}
