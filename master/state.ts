import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelAtom } from "../config.js";
import { msg } from "./messages.js";

const STATE_VERSION = 9;
export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinking = (typeof THINKING_LEVELS)[number];
export type WorkerStatus = "working" | "idle" | "reviewing";

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
	disposition?: "pending" | "reminded";
}

export function modelAtomText(atom: Pick<ModelAtom, "model" | "thinking">): string {
	return `${atom.model}/${atom.thinking}`;
}

/** 子代理池档案：与运行配置同一个 Pi Agent 目录（含 PI_CODING_AGENT_DIR 覆写），按主会话 id 分文件。 */
export function masterStatePath(agentDir: string, sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	return join(agentDir, "tmp", `firecode-master-${safeId}.json`);
}

/**
 * 池档案的唯一所有者：每次变更同步原子落盘（0600）。构造即加载——运行时不跨进程存活，所以载入时在飞的
 * working/reviewing 一律收敛为带 interruptedAt 的 idle（会话与审查义务保留，等指挥官续派）。
 * 旧版档案由所有者丢弃并记下版本，供上层告知；格式损坏明确失败，不当作空池。
 */
export class MasterStore {
	private list: readonly WorkerRef[];
	readonly discardedLegacyVersion?: number;

	constructor(private readonly path: string, private readonly onChange?: () => void) {
		const loaded = load(path);
		this.discardedLegacyVersion = loaded.legacyVersion;
		const now = Date.now();
		this.list = loaded.workers.map((worker) =>
			worker.status === "idle" ? worker : { ...worker, status: "idle", interruptedAt: now });
		if (this.list.some((worker, index) => worker !== loaded.workers[index])) this.persist();
	}

	get workers(): readonly WorkerRef[] {
		return this.list;
	}

	find(name: string): WorkerRef | undefined {
		return this.list.find((worker) => worker.name === name);
	}

	require(name: string): WorkerRef {
		const worker = this.find(name);
		if (!worker) throw new Error(msg.state.missing(name));
		return worker;
	}

	/** 按名字新增或覆盖；名字与 sessionPath 各自唯一，身份（sessionPath）一经建立不可更换。 */
	upsert(worker: WorkerRef): void {
		const owner = this.list.find((candidate) => candidate.sessionPath === worker.sessionPath);
		if (owner && owner.name !== worker.name) throw new Error(msg.state.pathTaken(worker.sessionPath));
		const existing = this.find(worker.name);
		if (existing && existing.sessionPath !== worker.sessionPath) throw new Error(msg.state.pathChange(worker.name));
		this.list = existing
			? this.list.map((candidate) => (candidate === existing ? worker : candidate))
			: [...this.list, worker];
		this.commit();
	}

	/** 返回是否确有这一票。 */
	remove(name: string): boolean {
		if (!this.find(name)) return false;
		this.list = this.list.filter((worker) => worker.name !== name);
		this.commit();
		return true;
	}

	private commit(): void {
		this.persist();
		this.onChange?.();
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: STATE_VERSION, workers: this.list })}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}
}

function load(path: string): { workers: WorkerRef[]; legacyVersion?: number } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workers: [] };
		throw error;
	}
	let data: { version?: unknown; workers?: unknown } | null;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(msg.state.invalidJson(path));
	}
	if (typeof data?.version === "number" && data.version !== STATE_VERSION) {
		rmSync(path, { force: true });
		return { workers: [], legacyVersion: data.version };
	}
	const workers = data?.workers;
	if (data?.version !== STATE_VERSION || !Array.isArray(workers) || !workers.every(isWorker)
		|| new Set(workers.map((worker) => worker.name)).size !== workers.length
		|| new Set(workers.map((worker) => worker.sessionPath)).size !== workers.length)
		throw new Error(msg.state.invalidShape(path));
	return { workers };
}

function isWorker(value: unknown): value is WorkerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.name !== "string" || !WORKER_NAME.test(record.name) ||
		typeof record.role !== "string" || !record.role ||
		typeof record.model !== "string" || !record.model ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.includes(record.thinking as WorkerThinking) ||
		(record.status !== "working" && record.status !== "idle" && record.status !== "reviewing") ||
		typeof record.sessionPath !== "string" || !record.sessionPath
	) return false;
	if (record.cwd !== undefined && (typeof record.cwd !== "string" || !record.cwd)) return false;
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (typeof record.launch !== "number" || !Number.isInteger(record.launch) || record.launch <= 0) return false;
	return record.disposition === undefined || record.disposition === "pending" || record.disposition === "reminded";
}
