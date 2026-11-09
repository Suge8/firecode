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
	/** 工作目录：start 必写（realpath），send 带 cwd 时改写。 */
	cwd: string;
	interruptedAt?: number;
	/**
	 * 启动序：start 在同步段按到达先后取的单调序号，store 按它排序。必须持久化：并行 start 越过
	 * await 后落盘的先后（以及任何落盘时刻）与到达先后不一致，恢复后若靠别的字段排会换序。
	 */
	launch: number;
	reviewNeeded?: boolean;
	/**
	 * 回合被会话重载打断、“待续跑”提醒还没发出：载入时从在飞收敛的票带它，提醒发出或指挥官接手（send/review/ack）时清掉。
	 * 必须持久化：只在载入那一刻推断的话，提醒时限内再 reload 一次，这票已是 idle，与指挥官自己 interrupt 的票分不出来，提醒就丢了。
	 */
	reloadInterrupted?: true;
	/**
	 * 瞬时失败后的自动续跑：idle 且带它就是“暂停到 at，到时自动续跑”（review 为真时续的是审查）。持久化，reload 后按 at 重挂。
	 * 自动续跑开始后保留到这次运行落定才清：续跑中被 reload 打断时载入收敛回暂停、立即再续，而不是变成等指挥官的中断。
	 * 指挥官 send/review/interrupt/ack 会清掉它（工作归指挥官接手），所以同一次暂停只续跑一次；暂停时它已在就说明这次运行告知过“已暂停”。
	 */
	resume?: WorkerResume;
}

/** 给模型的池快照（start 结果与 subagents_list 正文）：只有档案事实。 */
export function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
		role: worker.role,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		session: worker.sessionPath,
		...(worker.interruptedAt ? { interruptedAt: worker.interruptedAt } : {}),
		...(worker.reviewNeeded ? { reviewNeeded: true } : {}),
		...(worker.resume ? { resume: worker.resume } : {}),
	};
}
export type CompactWorker = ReturnType<typeof compactWorker>;

export interface WorkerResume {
	at: number;
	reason: string;
	review?: true;
}

/**
 * 档案转移：每条规则只写在这里，调用方不手写解构去清标记。各标记的寿命见 WorkerRef 的字段注释：
 * interruptedAt 到指挥官下次接手；reloadInterrupted 到提醒发出或指挥官接手；resume 到这次运行落定或指挥官接手。
 */
export const transition = {
	/** 指挥官开新运行（send、review）：工作归它接手，中断、待提醒与续跑意图一并作废。 */
	takeOver({ interruptedAt: _interrupted, reloadInterrupted: _reload, resume: _resume, ...worker }: WorkerRef, status: "working" | "reviewing"): WorkerRef {
		return { ...worker, status };
	},
	/** 暂停后到时自动续跑：resume 留到落定，续跑中被 reload 打断时载入收敛回暂停、立即再续。 */
	continued(worker: WorkerRef, status: "working" | "reviewing"): WorkerRef {
		return { ...worker, status };
	},
	/** 运行落定回到 idle：这次运行（含自动续跑）到此结束，续跑意图随之清掉。 */
	landed({ resume: _resume, ...worker }: WorkerRef): WorkerRef {
		return { ...worker, status: "idle" };
	},
	/** 被中断落定（回合、审查或暂停中被 interrupt）：会话与审查义务保留，等指挥官续派或收口。 */
	interrupted(worker: WorkerRef, at: number): WorkerRef {
		return { ...transition.landed(worker), interruptedAt: at };
	},
	/** 瞬时故障暂停：idle 且带 resume，到时自动续跑。 */
	paused(worker: WorkerRef, resume: WorkerResume): WorkerRef {
		return { ...worker, status: "idle", resume };
	},
	/** 审查通过或被停止：义务履行完毕。 */
	fulfilled({ reviewNeeded: _needed, ...worker }: WorkerRef): WorkerRef {
		return worker;
	},
	/** ack：取消还没发出的续跑提醒与暂停后的自动续跑。 */
	acked({ resume: _resume, reloadInterrupted: _reload, ...worker }: WorkerRef): WorkerRef {
		return worker;
	},
	/** 续跑提醒已发出（pending 已落盘）。 */
	reminded({ reloadInterrupted: _reload, ...worker }: WorkerRef): WorkerRef {
		return worker;
	},
	/**
	 * 载入收敛：运行时不跨进程存活，在飞的票一律回到 idle。自动续跑中被打断的仍是插件自己的续跑，收敛回暂停，激活时按已过的 at 立即再续；
	 * 其余带 interruptedAt 与 reloadInterrupted（会话与审查义务保留，等指挥官续派）。
	 */
	converged(worker: WorkerRef, now: number): WorkerRef {
		if (worker.status === "idle") return worker;
		if (worker.resume) return { ...worker, status: "idle" };
		return { ...worker, status: "idle", interruptedAt: now, reloadInterrupted: true };
	},
};

/** 子代理池档案：与运行配置同一个 Pi Agent 目录（含 PI_CODING_AGENT_DIR 覆写），按主会话 id 分文件。 */
export function masterStatePath(agentDir: string, sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	return join(agentDir, "tmp", `firecode-master-${safeId}.json`);
}

/**
 * 池档案的唯一所有者：每次变更先同步原子落盘（0600）、成功后才换内存列表，写盘失败照常抛错且内存不变，两者不分叉；池变空就删文件。
 * 构造即加载，载入时在飞的票按 transition.converged 收敛。
 * 列表始终按启动序（launch）排列，读者不再二次排序。
 * 旧版档案由所有者丢弃并记下版本，供上层告知；新版本（降级）与格式损坏明确失败，不删、不当作空池。
 */
export class MasterStore {
	private list: readonly WorkerRef[];
	readonly discardedLegacyVersion?: number;

	constructor(private readonly path: string, private readonly onChange?: () => void) {
		const loaded = load(path);
		this.discardedLegacyVersion = loaded.legacyVersion;
		const now = Date.now();
		const list = loaded.workers.map((worker) => transition.converged(worker, now));
		if (loaded.workers.some((worker) => worker.status !== "idle")) this.persist(list);
		this.list = list;
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
		this.commit(existing
			? this.list.map((candidate) => (candidate === existing ? worker : candidate))
			: [...this.list, worker].sort(byLaunch));
	}

	/** 返回是否确有这一票。 */
	remove(name: string): boolean {
		if (!this.find(name)) return false;
		this.commit(this.list.filter((worker) => worker.name !== name));
		return true;
	}

	private commit(list: readonly WorkerRef[]): void {
		this.persist(list);
		this.list = list;
		this.onChange?.();
	}

	private persist(list: readonly WorkerRef[]): void {
		if (!list.length) {
			rmSync(this.path, { force: true });
			return;
		}
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: STATE_VERSION, workers: list })}\n`, { encoding: "utf8", mode: 0o600 });
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

function isResume(value: unknown): value is WorkerResume {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { at, reason, review } = value as Record<string, unknown>;
	return typeof at === "number" && at > 0 && typeof reason === "string" && (review === undefined || review === true);
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
	if (typeof record.cwd !== "string" || !record.cwd) return false;
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (record.reloadInterrupted !== undefined && record.reloadInterrupted !== true) return false;
	if (record.resume !== undefined && !isResume(record.resume)) return false;
	return typeof record.launch === "number" && Number.isInteger(record.launch) && record.launch > 0;
}
