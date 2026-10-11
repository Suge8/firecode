import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionError,
	type ExtensionFactory,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelValue } from "./config.js";
import { msg } from "./messages.js";
import { processShared } from "./process-shared.js";

const IDLE_SESSION_TIMEOUT_MS = 10 * 60_000;
/** 宿主只给 CLI 主会话注入内置扩展；子会话自带 codemode（按 builtin 名受 settings 开关），激活仍由 tools 决定。 */
const BUILTIN_CODEMODE: InlineExtension = { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true };

type SessionPersistence =
	| { type: "memory" }
	| { type: "file"; sessionPath: string; resume?: boolean };

interface SpawnSessionOptions {
	cwd: string;
	model: Model<any>;
	thinking: ThinkingLevelValue;
	tools: string[];
	/** 只属于本子会话的工具（如观察员的 advise）；名字仍要出现在 tools 里才激活。 */
	customTools?: ToolDefinition[];
	excludeExtensions?: string[];
	systemPrompt: { mode: "append" | "replace"; text: string };
	contextFiles: boolean;
	persistence: SessionPersistence;
	/** 审查会话关闭自动扩展（含 FireCode）、Skill 与模板，保持评判政策不受被审项目改写。 */
	isolated?: boolean;
	/** 子会话里的扩展出错（加载后的事件处理抛错）时通知；不给就不接线，宿主丢弃这些错误。 */
	onExtensionError?: (error: ExtensionError) => void;
}

interface SpawnedSession {
	readonly session: AgentSession;
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

// 单写者登记必须进程唯一，跨模块拷贝共享。
const SESSION_WRITERS = processShared("session-writers", () => new Set<string>());
// 子会话加载扩展期间的标记，跨模块拷贝共享：宿主从磁盘另读的那份 FireCode 读到它就不注册。
const LOADING_SUBSESSION = processShared("loading-subsession", () => new AsyncLocalStorage<true>());

/** 当前是否处在本池建子会话、加载扩展的过程中。 */
export function loadingSubsession(): boolean {
	return LOADING_SUBSESSION.getStore() === true;
}

interface PoolEnvironment {
	/**
	 * 注册进非隔离子会话的 FireCode：主会话已加载的这一份。宿主为子会话从磁盘另读的 FireCode 不注册，
	 * 否则 FireCode 在会话中途更新后，主会话与子会话会跑两个版本，彼此的落盘约定（如审查 checkpoint 版本）对不上。
	 */
	firecode?: ExtensionFactory;
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
		let partial: AgentSession | undefined;
		try {
			const agentDir = getAgentDir();
			// 加载器与会话共用同一个 SettingsManager：项目信任只判定一次，两处读到的设置也不会分叉。
			const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: false });
			settingsManager.setProjectTrusted(projectTrusted(options.cwd, agentDir, settingsManager));
			const loader = new DefaultResourceLoader({
				cwd: options.cwd,
				agentDir,
				settingsManager,
				noContextFiles: !options.contextFiles,
				extensionFactories: this.extensionsFor(options),
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
			await LOADING_SUBSESSION.run(true, () => loader.reload());
			if (loader.getExtensions().errors.length)
				throw new Error(msg.spawn.extensionErrors(JSON.stringify(loader.getExtensions().errors)));
			const sessionManager = makeSessionManager(options.persistence, options.cwd);
			const result = await createAgentSession({
				cwd: options.cwd,
				// 与模型解析同一份：不传时宿主会为每个子会话重读一次 auth.json 与 models.json。
				modelRuntime: await this.modelRuntime(),
				model: options.model,
				thinkingLevel: options.thinking,
				tools: options.tools,
				...(options.customTools ? { customTools: options.customTools } : {}),
				resourceLoader: loader,
				settingsManager,
				sessionManager,
			});
			partial = result.session;
			await partial.bindExtensions({ mode: "print", ...(options.onExtensionError ? { onError: options.onExtensionError } : {}) });
			created = partial;
		} catch (error) {
			partial?.dispose();
			if (sessionPath) SESSION_WRITERS.delete(sessionPath);
			throw error;
		}

		const key = sessionPath ?? `memory:${crypto.randomUUID()}`;
		const held: HeldSession = { key, session: created, sessionPath };
		this.held.set(key, held);
		return {
			session: created,
			prompt: (text) => created.prompt(text),
			dispose: () => this.release(held),
		};
	}

	/** 热会话被释放（空闲到期或 dispose）后通知持有方放掉对它的订阅与引用；返回退订函数。 */
	onRelease(listener: (sessionPath: string) => void): () => void {
		this.releaseListeners.add(listener);
		return () => this.releaseListeners.delete(listener);
	}

	private extensionsFor(options: SpawnSessionOptions): InlineExtension[] {
		const firecode = this.environment.firecode;
		if (options.isolated || !firecode) return [BUILTIN_CODEMODE];
		return [BUILTIN_CODEMODE, { name: "firecode", factory: firecode, hidden: true }];
	}

	private modelRuntime(): Promise<ModelRuntime> {
		const agentDir = getAgentDir();
		this.runtime ??= this.environment.modelRuntime
			? Promise.resolve(this.environment.modelRuntime)
			: ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
		return this.runtime;
	}

	/** 纯查询：不改变释放计时（视图、steer、interrupt 只看不占）。 */
	getSession(sessionPath: string): AgentSession | undefined {
		return this.held.get(sessionPath)?.session;
	}

	/** 占用热会话：取消空闲释放计时，直到调用方再次 markIdle。只有要在它上面开回合的一方调用。 */
	hold(sessionPath: string): AgentSession | undefined {
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

	/**
	 * 释放全部落盘的（Worker）会话。内存会话归创建它的一方（观察员自己 dispose），不在此列：
	 * 池由 Master 与观察员共用，Master 关闭时不能顺手掐掉观察员正在评估的会话。
	 */
	async disposeWorkers(): Promise<void> {
		await Promise.all([...this.held.values()].filter((held) => held.sessionPath).map((held) => this.release(held)));
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

/**
 * 子会话的项目信任，与宿主非交互路径同一判定：没有需要信任的项目资源就信任；否则取信任存储里离 cwd 最近的显式决定，
 * 没有决定时看全局 defaultProjectTrust 是否为 always。子会话无法弹窗询问，所以 ask 按不信任；
 * 主会话里只对本次会话生效、没写进信任存储的选择，子会话看不到，同样按不信任。
 */
function projectTrusted(cwd: string, agentDir: string, settings: SettingsManager): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return new ProjectTrustStore(agentDir).get(cwd) ?? settings.getDefaultProjectTrust() === "always";
}

function makeSessionManager(persistence: SessionPersistence, cwd: string): SessionManager {
	if (persistence.type === "memory") return SessionManager.inMemory(cwd);
	return SessionManager.open(persistence.sessionPath, dirname(persistence.sessionPath), cwd);
}

function matchesExtension(path: string, exclusions: string[]): boolean {
	return exclusions.some((excluded) => excluded === path || excluded === basename(path));
}
