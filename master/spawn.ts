import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { msg } from "./messages.js";
import { withSubsessionRole, type SubsessionRole } from "./role.js";
import type { WorkerThinking } from "./state.js";

export const IDLE_SESSION_TIMEOUT_MS = 10 * 60_000;
/** 宿主只给 CLI 主会话注入内置扩展；子会话自带 codemode（按 builtin 名受 settings 开关），激活仍由 tools 决定。 */
const BUILTIN_CODEMODE: InlineExtension = { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true };

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

// 单写者登记必须进程唯一：宿主按文件重新求值模块图（见 role.ts），模块级集合在副本间互不可见。
const WRITERS_KEY = Symbol.for("firecode.session-writers");
const SESSION_WRITERS = ((globalThis as Record<symbol, unknown>)[WRITERS_KEY] ??= new Set<string>()) as Set<string>;

export interface PoolEnvironment {
	agentDir?: string;
	modelRuntime?: ModelRuntime;
	idleTimeoutMs?: number;
	/** 模型原子 id（provider/model）解析；默认用池内缓存的一份 ModelRuntime。 */
	resolveModel?: (id: string) => Promise<Model<any>>;
}

/** 全插件唯一的进程内子会话入口：模型解析、单写者登记与热会话生命周期都在这里。 */
export class InProcessSessionPool {
	private readonly held = new Map<string, HeldSession>();
	private runtime?: Promise<ModelRuntime>;
	private readonly releaseListeners = new Set<(sessionPath: string) => void>();

	constructor(private readonly environment: PoolEnvironment = {}) {}

	/**
	 * 把 "provider/model" 解析成模型。ModelRuntime 每个池只建一次（auth.json 与 models.json 只读一次），解析与建子会话共用；
	 * 扩展注册的 provider 在这里不可见，只能用内置 provider 与 models.json 里的模型。
	 */
	async resolveModel(id: string): Promise<Model<any>> {
		if (this.environment.resolveModel) return this.environment.resolveModel(id);
		const runtime = await this.modelRuntime();
		const slash = id.indexOf("/");
		const model = slash > 0 ? runtime.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
		if (!model) throw new Error(msg.spawn.modelNotFound(id));
		return model;
	}

	async spawn(options: SpawnSessionOptions): Promise<SpawnedSession> {
		const sessionPath = options.persistence.type === "file" ? options.persistence.sessionPath : undefined;
		if (sessionPath && SESSION_WRITERS.has(sessionPath))
			throw new Error(msg.spawn.held(sessionPath));
		if (options.persistence.type === "file" && options.persistence.resume && !existsSync(sessionPath!))
			throw new Error(msg.spawn.missingFile(sessionPath!));
		if (sessionPath) SESSION_WRITERS.add(sessionPath);

		let created: AgentSession;
		try {
			const loader = new DefaultResourceLoader({
				cwd: options.cwd,
				agentDir: this.environment.agentDir ?? getAgentDir(),
				noContextFiles: !options.contextFiles,
				extensionFactories: [BUILTIN_CODEMODE],
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
				throw new Error(msg.spawn.extensionErrors(JSON.stringify(loader.getExtensions().errors)));
			const sessionManager = makeSessionManager(options.persistence, options.cwd);
			const result = await createAgentSession({
				cwd: options.cwd,
				agentDir: this.environment.agentDir,
				// 与模型解析同一份：不传时宿主会为每个子会话重读一次 auth.json 与 models.json。
				modelRuntime: await this.modelRuntime(),
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

	/** 热会话被释放（空闲到期或 dispose）后通知持有方放掉对它的订阅与引用；返回退订函数。 */
	onRelease(listener: (sessionPath: string) => void): () => void {
		this.releaseListeners.add(listener);
		return () => this.releaseListeners.delete(listener);
	}

	private modelRuntime(): Promise<ModelRuntime> {
		const agentDir = this.environment.agentDir ?? getAgentDir();
		this.runtime ??= this.environment.modelRuntime
			? Promise.resolve(this.environment.modelRuntime)
			: ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
		return this.runtime;
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
				if (held.sessionPath) {
					SESSION_WRITERS.delete(held.sessionPath);
					for (const listener of this.releaseListeners) listener(held.sessionPath);
				}
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
	if (!sessionPath) throw new Error(msg.spawn.noSessionPath);
	return sessionPath;
}

function makeSessionManager(persistence: SessionPersistence, cwd: string): SessionManager {
	if (persistence.type === "memory") return SessionManager.inMemory(cwd);
	return SessionManager.open(persistence.sessionPath, dirname(persistence.sessionPath), cwd);
}

function matchesExtension(path: string, exclusions: string[]): boolean {
	return exclusions.some((excluded) => excluded === path || excluded === basename(path));
}
