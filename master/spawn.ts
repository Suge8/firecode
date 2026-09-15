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
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withSubsessionRole, type SubsessionRole } from "./role.js";
import type { WorkerThinking } from "./state.js";

export const IDLE_SESSION_TIMEOUT_MS = 10 * 60_000;

export type SessionPersistence =
	| { type: "memory" }
	| { type: "file"; sessionPath: string; resume?: boolean };

export interface SpawnSessionOptions {
	cwd: string;
	model: Model<any>;
	role: SubsessionRole;
	thinking: WorkerThinking;
	tools: string[];
	/** 只属于本子会话的工具（如观察员的 advise）；名字仍要出现在 tools 里才激活。 */
	customTools?: ToolDefinition[];
	excludeExtensions?: string[];
	systemPrompt: { mode: "append" | "replace"; text: string };
	contextFiles: boolean;
	persistence: SessionPersistence;
	/** 审查会话关闭自动扩展、Skill 与模板，保持评判政策不受被审项目改写。 */
	isolated?: boolean;
}

export interface SpawnedSession {
	readonly session: AgentSession;
	readonly sessionPath?: string;
	prompt(text: string): Promise<void>;
	/** 先让会话内扩展按宿主契约收口（session_shutdown），再释放；resolve 即收口完成。 */
	dispose(): Promise<void>;
}

interface HeldSession {
	key: string;
	session: AgentSession;
	sessionPath?: string;
	timer?: NodeJS.Timeout;
	releasing?: Promise<void>;
}

const SESSION_WRITERS = new Set<string>();

/** 全插件唯一的进程内子会话入口；池同时是 JSONL 单写者登记。 */
export class InProcessSessionPool {
	private readonly held = new Map<string, HeldSession>();

	constructor(private readonly environment: {
		agentDir?: string;
		modelRuntime?: ModelRuntime;
		idleTimeoutMs?: number;
	} = {}) {}

	async spawn(options: SpawnSessionOptions): Promise<SpawnedSession> {
		const sessionPath = options.persistence.type === "file" ? options.persistence.sessionPath : undefined;
		if (sessionPath && SESSION_WRITERS.has(sessionPath))
			throw new Error(`sessionPath 已有进程内会话持有：${sessionPath}`);
		if (options.persistence.type === "file" && options.persistence.resume && !existsSync(sessionPath!))
			throw new Error(`无法恢复子代理：会话文件不存在：${sessionPath}`);
		if (sessionPath) SESSION_WRITERS.add(sessionPath);

		let created: AgentSession;
		try {
			const loader = new DefaultResourceLoader({
				cwd: options.cwd,
				agentDir: this.environment.agentDir ?? getAgentDir(),
				noContextFiles: !options.contextFiles,
				noExtensions: options.isolated,
				noSkills: options.isolated,
				noPromptTemplates: options.isolated,
				...(options.systemPrompt.mode === "replace"
					? { systemPrompt: options.systemPrompt.text }
					: { appendSystemPrompt: [options.systemPrompt.text] }),
				extensionsOverride: (base) => ({
					...base,
					extensions: base.extensions.filter((extension) =>
						!matchesExtension(extension.path, options.excludeExtensions ?? [])),
				}),
			});
			await withSubsessionRole(options.role, () => loader.reload());
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
				...(options.customTools ? { customTools: options.customTools } : {}),
				resourceLoader: loader,
				sessionManager,
			});
			await result.session.bindExtensions({ mode: "print" });
			created = result.session;
		} catch (error) {
			if (sessionPath) SESSION_WRITERS.delete(sessionPath);
			throw error;
		}

		const key = sessionPath ?? `memory:${crypto.randomUUID()}`;
		const held: HeldSession = { key, session: created, sessionPath };
		this.held.set(key, held);
		return {
			session: created,
			sessionPath,
			prompt: (text) => created.prompt(text),
			dispose: () => this.release(held),
		};
	}

	has(sessionPath: string): boolean {
		return this.held.has(sessionPath);
	}

	getSession(sessionPath: string): AgentSession | undefined {
		const held = this.held.get(sessionPath);
		if (!held) return undefined;
		this.clearTimer(held);
		return held.session;
	}

	/** 空闲只由调用方判定：池不订阅会话事件自判空闲；超时后释放热会话，档案与 JSONL 保留。 */
	markIdle(sessionPath: string): void {
		const held = this.held.get(sessionPath);
		if (!held) return;
		this.clearTimer(held);
		held.timer = setTimeout(() => void this.release(held), this.environment.idleTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS);
		held.timer.unref?.();
	}

	async dispose(sessionPath: string): Promise<boolean> {
		const held = this.held.get(sessionPath);
		if (!held) return false;
		await this.release(held);
		return true;
	}

	async disposeAll(): Promise<void> {
		await Promise.all([...this.held.values()].map((held) => this.release(held)));
	}

	/** 镜像宿主替换会话的顺序：先 session_shutdown 让扩展收口，再 dispose 作废上下文。 */
	private release(held: HeldSession): Promise<void> {
		held.releasing ??= (async () => {
			this.clearTimer(held);
			if (this.held.get(held.key) === held) this.held.delete(held.key);
			try {
				await held.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				held.session.dispose();
				if (held.sessionPath) SESSION_WRITERS.delete(held.sessionPath);
			}
		})();
		return held.releasing;
	}

	private clearTimer(held: HeldSession): void {
		if (held.timer) clearTimeout(held.timer);
		held.timer = undefined;
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
