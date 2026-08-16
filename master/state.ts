import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinking = (typeof THINKING_LEVELS)[number];
export type WorkerStatus = "starting" | "working" | "blocked" | "idle" | "reviewing" | "dormant";

export interface WorkerRef {
	name: string;
	model: string;
	thinking: WorkerThinking;
	status: WorkerStatus;
	paneId?: string;
	tabId?: string;
	sessionPath?: string;
	/** review action 投递前观察到的 runId；null 表示当时没有审查。 */
	reviewPreviousRunId?: string | null;
	/** start 时声明的审查意图：完成后由机器自动发起对抗审查，一次性消耗。 */
	reviewNeeded?: boolean;
}

export interface MasterState {
	version: 4;
	workers: WorkerRef[];
}

export type MasterEvent =
	| { type: "UPSERT_WORKER"; worker: WorkerRef }
	| { type: "REMOVE_WORKER"; name: string }
	| { type: "CLEAR" };

export function initialMasterState(): MasterState {
	return { version: 4, workers: [] };
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

export function restoreMasterState(data: unknown): MasterState | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 4 || !Array.isArray(record.workers) || !record.workers.every(isWorker))
		return undefined;
	const workers = record.workers as WorkerRef[];
	if (new Set(workers.map((worker) => worker.name)).size !== workers.length) return undefined;
	const sessions = workers.flatMap((worker) => worker.sessionPath ? [worker.sessionPath] : []);
	if (new Set(sessions).size !== sessions.length) return undefined;
	return { version: 4, workers };
}

export function masterStatePath(sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	return join(homedir(), ".pi", "agent", "tmp", `firecode-master-${safeId}.json`);
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
		throw new Error(`Master Worker Pool 状态不是合法 JSON：${path}`);
	}
	const state = restoreMasterState(data);
	if (!state) throw new Error(`Master Worker Pool 状态结构无效：${path}`);
	return state;
}

export class MasterStore {
	private stateValue: MasterState;
	private readonly path: string;

	constructor(path: string, restored?: MasterState) {
		this.path = path;
		this.stateValue = restored ?? loadMasterState(path) ?? initialMasterState();
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
		return next;
	}
}

export function liveWorkers(state: MasterState): WorkerRef[] {
	return state.workers.filter((worker) => worker.status !== "dormant");
}

export function requireWorker(state: MasterState, name: string): WorkerRef {
	const worker = state.workers.find((candidate) => candidate.name === name);
	if (!worker) throw new Error(`Worker 不存在：${name}`);
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
	if (index < 0) return [...workers, worker];
	return workers.map((candidate, position) => (position === index ? worker : candidate));
}

function isWorker(value: unknown): value is WorkerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(record.name) ||
		typeof record.model !== "string" || !record.model ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.includes(record.thinking as WorkerThinking) ||
		typeof record.status !== "string" || !isStatus(record.status)
	) return false;
	if (
		record.reviewPreviousRunId !== undefined &&
		record.reviewPreviousRunId !== null &&
		typeof record.reviewPreviousRunId !== "string"
	) return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (record.status === "dormant") return typeof record.sessionPath === "string" && !!record.sessionPath;
	return typeof record.paneId === "string" && !!record.paneId && typeof record.tabId === "string" && !!record.tabId;
}

function isStatus(value: string): value is WorkerStatus {
	return value === "starting" || value === "working" || value === "blocked" || value === "idle"
		|| value === "reviewing" || value === "dormant";
}
