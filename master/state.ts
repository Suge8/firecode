import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { THINKING_LEVELS, type ModelAtom, type ThinkingLevelValue } from "../config.js";
import { msg } from "./messages.js";

const STATE_VERSION = 10;
export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

export type WorkerStatus = "working" | "idle" | "reviewing";

export interface WorkerRef {
	name: string;
	role: string;
	model: string;
	thinking: ThinkingLevelValue;
	status: WorkerStatus;
	sessionPath: string;
	cwd?: string;
	interruptedAt?: number;
	/**
	 * 启动序：start 在同步段按到达先后取的单调序号，store 按它排序。必须持久化：并行 start 越过
	 * await 后落盘的先后（以及任何落盘时刻）与到达先后不一致，恢复后若靠别的字段排会换序。
	 */
	launch: number;
	reviewNeeded?: boolean;
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
 * 池档案的唯一所有者：每次变更同步原子落盘（0600），池变空就删文件。构造即加载——运行时不跨进程存活，所以载入时
 * 在飞的 working/reviewing 一律收敛为带 interruptedAt 的 idle（会话与审查义务保留，等指挥官续派），名字记在 recovered。
 * 列表始终按启动序（launch）排列，读者不再二次排序。
 * 旧版档案由所有者丢弃并记下版本，供上层告知；新版本（降级）与格式损坏明确失败，不删、不当作空池。
 */
export class MasterStore {
	private list: readonly WorkerRef[];
	readonly discardedLegacyVersion?: number;
	/** 本次载入从在飞收敛为 idle 的子代理名字：只有它们的回合是被会话重载打断的。 */
	readonly recovered: readonly string[];

	constructor(private readonly path: string, private readonly onChange?: () => void) {
		const loaded = load(path);
		this.discardedLegacyVersion = loaded.legacyVersion;
		const now = Date.now();
		const recovered: string[] = [];
		this.list = loaded.workers.map((worker) => {
			if (worker.status === "idle") return worker;
			recovered.push(worker.name);
			return { ...worker, status: "idle", interruptedAt: now };
		});
		this.recovered = recovered;
		if (recovered.length) this.persist();
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

	/** 按名字新增或覆盖；新增的按启动序插入。 */
	upsert(worker: WorkerRef): void {
		const existing = this.find(worker.name);
		this.list = existing
			? this.list.map((candidate) => (candidate === existing ? worker : candidate))
			: [...this.list, worker].sort(byLaunch);
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
		if (!this.list.length) {
			rmSync(this.path, { force: true });
			return;
		}
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

const byLaunch = (a: WorkerRef, b: WorkerRef) => a.launch - b.launch;

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
	if (typeof data?.version === "number" && data.version > STATE_VERSION) throw new Error(msg.state.newerVersion(path, data.version));
	if (typeof data?.version === "number" && data.version < STATE_VERSION) {
		rmSync(path, { force: true });
		return { workers: [], legacyVersion: data.version };
	}
	const workers = data?.workers;
	if (data?.version !== STATE_VERSION || !Array.isArray(workers) || !workers.every(isWorker)
		|| new Set(workers.map((worker) => worker.name)).size !== workers.length
		|| new Set(workers.map((worker) => worker.sessionPath)).size !== workers.length)
		throw new Error(msg.state.invalidShape(path));
	if (!workers.length) rmSync(path, { force: true });
	return { workers: workers.sort(byLaunch) };
}

function isWorker(value: unknown): value is WorkerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.name !== "string" || !WORKER_NAME.test(record.name) ||
		typeof record.role !== "string" || !record.role ||
		typeof record.model !== "string" || !record.model ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.includes(record.thinking as ThinkingLevelValue) ||
		(record.status !== "working" && record.status !== "idle" && record.status !== "reviewing") ||
		typeof record.sessionPath !== "string" || !record.sessionPath
	) return false;
	if (record.cwd !== undefined && (typeof record.cwd !== "string" || !record.cwd)) return false;
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	return typeof record.launch === "number" && Number.isInteger(record.launch) && record.launch > 0;
}
