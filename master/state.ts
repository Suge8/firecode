import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { THINKING_LEVELS, type ModelAtom, type ThinkingLevelValue } from "../config.js";
import { msg } from "./messages.js";

const STATE_VERSION = 10;
export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

export type WorkerStatus = "working" | "idle" | "reviewing";

/**
 * 这次运行是谁派的。在飞数的定义是“指挥官在等结果的运行”：用户在全过程视图里直接派的运行指挥官并不在等，
 * 不计入在飞数（主会话不因它进入进行中、不产生主会话轮记录），落定事件只告知不唤醒；
 * 指挥官在这次运行中途又 send 给它时转为指挥官的（它从此在等）。
 */
export type RunOrigin = "master" | "view";

/**
 * 实际原子（model 与 thinking 同有同无）：只由路由回调写（run.ts 的 onModelChange），回合的第一次请求路由到具体模型时才有；
 * start 之后、选定之前都没有。
 */
export type WorkerRef = WorkerFields & (ModelAtom | { model?: undefined; thinking?: undefined });

interface WorkerFields {
	name: string;
	role: string;
	/**
	 * 指挥官在 start/send 指定的思考档（覆盖角色链各原子的档）；省略按原子。开会话与重配路由都只从这里取，热会话与冷启动（含暂停后的
	 * 自动续跑、续审）一致；send 每次按自己的 thinking 改写，不带就清掉。thinking 是路由按它选出的实际档，两者不是同一件事。
	 */
	thinkingOverride?: ThinkingLevelValue;
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
	/**
	 * 这次运行的来源（省略即指挥官）与用户在全过程视图里对它说过的话（落定事件据此注明来源、带上原话）。随运行持久化：
	 * 暂停后的自动续跑可能跨 reload，续跑落定仍要按视图来源只告知、带原话。运行落定、被中断、ack 或指挥官接手时清掉。
	 */
	origin?: "view";
	viewPrompts?: string[];
}

/** 给模型的池快照（start 结果与 subagents_list 正文）：只有档案事实。 */
export function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
		role: worker.role,
		status: worker.status,
		...(worker.model ? { model: worker.model, thinking: worker.thinking } : {}),
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
	/**
	 * 开新运行（send、review）：工作归派它的一方接手，中断、待提醒与续跑意图一并作废，上次运行的来源与原话不带过来。
	 * 全过程视图派的带上来源与这句原话。
	 */
	takeOver({ interruptedAt: _interrupted, reloadInterrupted: _reload, resume: _resume, ...worker }: WorkerRef, status: "working" | "reviewing", viewPrompt?: string): WorkerRef {
		return { ...endRun(worker), status, ...(viewPrompt === undefined ? {} : { origin: "view" as const, viewPrompts: [viewPrompt] }) };
	},
	/** 用户在全过程视图里对在跑的运行补的话（送达后记下）；不改来源。 */
	viewSaid(worker: WorkerRef, prompt: string): WorkerRef {
		return { ...worker, viewPrompts: [...worker.viewPrompts ?? [], prompt] };
	},
	/** 指挥官补进视图起的运行：它从此在等结果。 */
	awaitedByMaster({ origin: _origin, ...worker }: WorkerRef): WorkerRef {
		return worker;
	},
	/** 暂停后到时自动续跑：resume 留到落定，续跑中被 reload 打断时载入收敛回暂停、立即再续。 */
	continued(worker: WorkerRef, status: "working" | "reviewing"): WorkerRef {
		return { ...worker, status };
	},
	/** 运行落定回到 idle：这次运行（含自动续跑）到此结束，续跑意图、来源与原话随之清掉。 */
	landed({ resume: _resume, ...worker }: WorkerRef): WorkerRef {
		return { ...endRun(worker), status: "idle" };
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
	/** ack：取消还没发出的续跑提醒与暂停后的自动续跑；暂停中的运行就此结束。 */
	acked({ resume: _resume, reloadInterrupted: _reload, ...worker }: WorkerRef): WorkerRef {
		return endRun(worker);
	},
	/** 续跑提醒已发出（pending 已落盘）。 */
	reminded({ reloadInterrupted: _reload, ...worker }: WorkerRef): WorkerRef {
		return worker;
	},
	/**
	 * 载入收敛：运行时不跨进程存活，在飞的票一律回到 idle。自动续跑中被打断的仍是插件自己的续跑，收敛回暂停（来源与原话随运行保留），
	 * 激活时按已过的 at 立即再续；其余这次运行到此结束，带 interruptedAt 与 reloadInterrupted（会话与审查义务保留，等指挥官续派）。
	 */
	converged(worker: WorkerRef, now: number): WorkerRef {
		if (worker.status === "idle") return worker;
		if (worker.resume) return { ...worker, status: "idle" };
		return { ...endRun(worker), status: "idle", interruptedAt: now, reloadInterrupted: true };
	},
};

/** 一次运行结束：它的来源与视图原话不再有用。 */
function endRun({ origin: _origin, viewPrompts: _prompts, ...worker }: WorkerRef): WorkerRef {
	return worker;
}

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
		(record.status !== "working" && record.status !== "idle" && record.status !== "reviewing") ||
		typeof record.sessionPath !== "string" || !record.sessionPath
	) return false;
	if (typeof record.cwd !== "string" || !record.cwd) return false;
	if (record.model !== undefined || record.thinking !== undefined) {
		if (typeof record.model !== "string" || !record.model) return false;
		if (!THINKING_LEVELS.includes(record.thinking as ThinkingLevelValue)) return false;
	}
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.thinkingOverride !== undefined && !THINKING_LEVELS.includes(record.thinkingOverride as ThinkingLevelValue)) return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (record.reloadInterrupted !== undefined && record.reloadInterrupted !== true) return false;
	if (record.resume !== undefined && !isResume(record.resume)) return false;
	if (record.origin !== undefined && record.origin !== "view") return false;
	if (record.viewPrompts !== undefined && !(Array.isArray(record.viewPrompts) && record.viewPrompts.every((prompt) => typeof prompt === "string"))) return false;
	return typeof record.launch === "number" && Number.isInteger(record.launch) && record.launch > 0;
}
