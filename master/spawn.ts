import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { WorkerThinking } from "./state.js";

export const IDLE_SESSION_TIMEOUT_MS = 10 * 60_000;

export type SessionPersistence =
	| { type: "memory" }
	| { type: "file"; sessionPath: string; resume?: boolean };

export interface SpawnSessionOptions {
	cwd: string;
	model: Model<any>;
	thinking: WorkerThinking;
	tools: string[];
	excludeExtensions?: string[];
	systemPrompt: { mode: "append" | "replace"; text: string };
	contextFiles: boolean;
	persistence: SessionPersistence;
}

export interface SpawnedSession {
	readonly session: AgentSession;
	readonly sessionPath?: string;
	prompt(text: string): Promise<void>;
	dispose(): void;
}

interface HeldSession {
	session: AgentSession;
	timer?: NodeJS.Timeout;
}

const SESSION_WRITERS = new Set<string>();
let environmentQueue = Promise.resolve();

/** 全插件唯一的进程内子会话入口；池同时是 JSONL 单写者登记。 */
export class InProcessSessionPool {
	private readonly held = new Map<string, HeldSession>();

	constructor(private readonly environment: { agentDir?: string; modelRuntime?: ModelRuntime } = {}) {}

	async spawn(options: SpawnSessionOptions): Promise<SpawnedSession> {
		const sessionPath = options.persistence.type === "file" ? options.persistence.sessionPath : undefined;
		if (sessionPath && SESSION_WRITERS.has(sessionPath))
			throw new Error(`sessionPath 已有进程内会话持有：${sessionPath}`);
		if (options.persistence.type === "file" && options.persistence.resume && !existsSync(sessionPath!))
			throw new Error(`无法恢复子代理：会话文件不存在：${sessionPath}`);
		if (sessionPath) SESSION_WRITERS.add(sessionPath);

		let created: AgentSession;
		try {
			created = await this.withWorkerEnvironment(async () => {
				const loader = new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: this.environment.agentDir ?? getAgentDir(),
					noContextFiles: !options.contextFiles,
					...(options.systemPrompt.mode === "replace"
						? { systemPrompt: options.systemPrompt.text }
						: { appendSystemPrompt: [options.systemPrompt.text] }),
					extensionsOverride: (base) => ({
						...base,
						extensions: base.extensions.filter((extension) =>
							!matchesExtension(extension.path, options.excludeExtensions ?? [])),
					}),
				});
				await loader.reload();
				if (loader.getExtensions().errors.length)
					throw new Error(`子会话扩展加载失败：${JSON.stringify(loader.getExtensions().errors)}`);
				const sessionManager = makeSessionManager(options.persistence, options.cwd);
				const result = await createAgentSession({
					cwd: options.cwd,
					agentDir: this.environment.agentDir,
					modelRuntime: this.environment.modelRuntime,
					model: options.model,
					thinkingLevel: options.thinking,
					tools: options.tools,
					resourceLoader: loader,
					sessionManager,
				});
				await result.session.bindExtensions({ mode: "print" });
				return result.session;
			});
		} catch (error) {
			if (sessionPath) SESSION_WRITERS.delete(sessionPath);
			throw error;
		}

		const key = sessionPath ?? `memory:${crypto.randomUUID()}`;
		const held: HeldSession = { session: created };
		this.held.set(key, held);
		const unsubscribe = created.subscribe((event) => {
			if (event.type === "agent_start") this.clearTimer(held);
			if (event.type === "agent_settled") this.armIdleDisposal(key, held);
		});
		let disposed = false;
		const dispose = () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			this.clearTimer(held);
			created.dispose();
			if (this.held.get(key) === held) this.held.delete(key);
			if (sessionPath) SESSION_WRITERS.delete(sessionPath);
		};
		return { session: created, sessionPath, prompt: (text) => created.prompt(text), dispose };
	}

	has(sessionPath: string): boolean {
		return this.held.has(sessionPath);
	}

	dispose(sessionPath: string): boolean {
		const held = this.held.get(sessionPath);
		if (!held) return false;
		this.clearTimer(held);
		held.session.dispose();
		this.held.delete(sessionPath);
		SESSION_WRITERS.delete(sessionPath);
		return true;
	}

	disposeAll(): void {
		for (const [key, held] of this.held) {
			this.clearTimer(held);
			held.session.dispose();
			this.held.delete(key);
			if (!key.startsWith("memory:")) SESSION_WRITERS.delete(key);
		}
	}

	private armIdleDisposal(key: string, held: HeldSession): void {
		this.clearTimer(held);
		held.timer = setTimeout(() => {
			if (held.session.isStreaming || this.held.get(key) !== held) return;
			held.session.dispose();
			this.held.delete(key);
			if (!key.startsWith("memory:")) SESSION_WRITERS.delete(key);
		}, IDLE_SESSION_TIMEOUT_MS);
		held.timer.unref?.();
	}

	private clearTimer(held: HeldSession): void {
		if (held.timer) clearTimeout(held.timer);
		held.timer = undefined;
	}

	private async withWorkerEnvironment<T>(run: () => Promise<T>): Promise<T> {
		const previous = environmentQueue;
		let release!: () => void;
		environmentQueue = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		const saved = process.env.FIRECODE_MASTER_WORKER;
		process.env.FIRECODE_MASTER_WORKER = "1";
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.FIRECODE_MASTER_WORKER;
			else process.env.FIRECODE_MASTER_WORKER = saved;
			release();
		}
	}
}

export function preallocateWorkerSession(mainSessionPath: string, cwd: string): string {
	const sessionPath = SessionManager.create(cwd, `${dirname(mainSessionPath)}/subagents`).getSessionFile();
	if (!sessionPath) throw new Error("无法为子代理预分配 Pi session 路径");
	return sessionPath;
}

function makeSessionManager(persistence: SessionPersistence, cwd: string): SessionManager {
	if (persistence.type === "memory") return SessionManager.inMemory(cwd);
	return SessionManager.open(persistence.sessionPath, dirname(persistence.sessionPath), cwd);
}

function matchesExtension(path: string, exclusions: string[]): boolean {
	return exclusions.some((excluded) => excluded === path || excluded === basename(path));
}
