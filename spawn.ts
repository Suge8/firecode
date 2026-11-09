import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type Api, clampThinkingLevel, type Context, type Model } from "@earendil-works/pi-ai";
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
} from "@earendil-works/pi-coding-agent";
import type { ModelAtom, ModelChain, ThinkingLevelValue } from "./config.js";
import { type Candidate, candidates, type ChainCompletion, completeOnChain, createModelRoute, followRoute, tryOnChain } from "./model-route.js";
import { msg } from "./messages.js";
import { processShared } from "./process-shared.js";
import { DEFAULT_TIMING, type Timing } from "./timing.js";

type SessionPersistence =
	| { type: "memory" }
	| { type: "file"; sessionPath: string; resume?: boolean };

interface SpawnSessionOptions {
	cwd: string;
	chain: ModelChain;
	thinkingOverride?: ThinkingLevelValue;
	onModelChange?: (atom: ModelAtom, previous?: ModelAtom, reason?: string) => void;
	tools: string[];
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
	route?: Awaited<ReturnType<typeof createModelRoute>>;
	/** 宿主发了 agent_start、还没把 agent_settled 发给订阅方的那次运行：idle 等它。 */
	settling?: PromiseWithResolvers<void>;
}

export const CODEMODE_TOOL = "codemode";
/** 宿主只给 CLI 主会话装内置扩展；要 codemode 的子会话自带一份（不标 builtin：隔离会话关掉扩展时也要在），on/only 读同一份 settings。 */
const CODEMODE_EXTENSION: InlineExtension = { name: CODEMODE_TOOL, factory: createCodemodeExtension(), replaceable: true };
/**
 * 宿主让进程里所有会话共用 codemode 名额（缺省 2，每次调用现读环境变量），脚本等工具返回时也占着，满额排队 60 秒后失败。
 * 子会话与主会话同进程：不加名额的话，两个子会话各跑一条长命令就能让 codemode only 的主会话连中断都发不出。
 * 所以每个带 codemode 的子会话另加两个名额（一个运行、一个留给取消后尚未退出的），主会话原有的名额永远不被挤占。
 */
const CODEMODE_LIMIT_ENV = "PI_CODEMODE_MAX_WORKERS";
const HOST_DEFAULT_CODEMODE_WORKERS = 2;
const CODEMODE_SLOTS_PER_SESSION = 2;
// 有子会话在用时环境变量由这里独写，都释放后还原成进程里第一次读到的原值（含未设置）；登记跨模块拷贝共享。
const CODEMODE_SLOTS = processShared("codemode-slots", () => ({ original: process.env[CODEMODE_LIMIT_ENV], sessions: new Set<string>() }));

function trackCodemodeSession(key: string, live: boolean): void {
	const { original, sessions } = CODEMODE_SLOTS;
	if (live) sessions.add(key);
	else if (!sessions.delete(key)) return;
	if (sessions.size > 0) {
		const base = Number(original);
		const limit = Number.isInteger(base) && base > 0 ? base : HOST_DEFAULT_CODEMODE_WORKERS;
		process.env[CODEMODE_LIMIT_ENV] = String(limit + CODEMODE_SLOTS_PER_SESSION * sessions.size);
	} else if (original === undefined) delete process.env[CODEMODE_LIMIT_ENV];
	else process.env[CODEMODE_LIMIT_ENV] = original;
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
	/** 覆盖默认时限（见 timing.ts）：全插件唯一的时间注入点，只给端到端测试缩短等待用。 */
	timing?: Partial<Timing>;
}

/** 全插件唯一的进程内子会话入口：模型解析、单写者登记与热会话生命周期都在这里。 */
export class InProcessSessionPool {
	private readonly held = new Map<string, HeldSession>();
	/** 已摘出 held、session_shutdown 还在收口的落盘会话：同一路径的 spawn 等它落定（单写者登记此时才放开）。 */
	private readonly releasing = new Map<string, Promise<void>>();
	private runtime?: Promise<ModelRuntime>;
	private readonly releaseListeners = new Set<(sessionPath: string) => void>();
	readonly timing: Timing;

	constructor(private readonly environment: PoolEnvironment = {}) {
		this.timing = { ...DEFAULT_TIMING, ...environment.timing };
	}

	async resolveChain(chain: ModelChain, override?: ThinkingLevelValue): Promise<ModelAtom | undefined> {
		const first = (await candidates(await this.modelRuntime(), chain))[0];
		return first && { model: `${first.model.provider}/${first.model.id}`, thinking: clampThinkingLevel(first.model, override ?? first.thinking) };
	}

	/** 实际用的物理模型（provider/id）是不是这条链首选原子匹配到的模型；匹配规则与路由选候选同一份。 */
	async isChainHead(chain: ModelChain, model: string): Promise<boolean> {
		return (await candidates(await this.modelRuntime(), chain.slice(0, 1))).some((entry) => `${entry.model.provider}/${entry.model.id}` === model);
	}

	/** 在链上做一次不开会话的单请求（选择、冷却与失败记账同 model-route.ts 的 completeOnChain）。 */
	async complete(chain: ModelChain, context: Context, options: { maxTokens: number; signal: AbortSignal }): Promise<ChainCompletion> {
		return completeOnChain(await this.modelRuntime(), chain, this.timing.cooldownMs, context, options);
	}

	/** 在链上逐个候选做一件活直到成功（选择、冷却与失败记账同 model-route.ts 的 tryOnChain）；attempt 拿到池的模型运行时发请求。 */
	async tryOnChain<T>(
		chain: ModelChain,
		signal: AbortSignal,
		unfit: (model: Model<Api>) => string | undefined,
		attempt: (candidate: Candidate, runtime: ModelRuntime) => Promise<T>,
	): Promise<{ value: T; model: string }> {
		const runtime = await this.modelRuntime();
		return tryOnChain(runtime, chain, this.timing.cooldownMs, signal, unfit, (candidate) => attempt(candidate, runtime));
	}

	configureRoute(sessionPath: string, chain: ModelChain, override?: ThinkingLevelValue): void {
		this.held.get(sessionPath)?.route?.configure(chain, override);
	}

	async spawn(options: SpawnSessionOptions): Promise<SpawnedSession> {
		const sessionPath = options.persistence.type === "file" ? options.persistence.sessionPath : undefined;
		// 空闲释放收口期间重开同一会话（send、自动续跑）是正当的接续：等那次释放落定（成败都行，登记在 finally 里放开），
		// 而不是撞上还没放开的单写者登记报“已持有”。落定后的登记检查与占位仍在同一同步段，并发 spawn 照样只放行一个。
		const releasing = sessionPath && this.releasing.get(sessionPath);
		if (releasing) await releasing.then(() => undefined, () => undefined);
		if (sessionPath && SESSION_WRITERS.has(sessionPath))
			throw new Error(msg.spawn.held(sessionPath));
		if (options.persistence.type === "file" && options.persistence.resume && !existsSync(sessionPath!))
			throw new Error(msg.spawn.missingFile(sessionPath!));
		if (sessionPath) SESSION_WRITERS.add(sessionPath);

		const codemode = options.tools.includes(CODEMODE_TOOL);
		let created: AgentSession;
		let partial: AgentSession | undefined;
		let route: Awaited<ReturnType<typeof createModelRoute>> | undefined;
		try {
			const agentDir = getAgentDir();
			const runtime = await this.modelRuntime();
			route = await createModelRoute(runtime, options.chain, this.timing.cooldownMs, options.thinkingOverride, options.onModelChange);
			// 加载器与会话共用同一个 SettingsManager：项目信任只判定一次，两处读到的设置也不会分叉；压缩设置按路由到的物理模型查。
			const settingsManager = followRoute(SettingsManager.create(options.cwd, agentDir, { projectTrusted: false }));
			settingsManager.setProjectTrusted(projectTrusted(options.cwd, agentDir, settingsManager));
			const loader = new DefaultResourceLoader({
				cwd: options.cwd,
				agentDir,
				settingsManager,
				noContextFiles: !options.contextFiles,
				extensionFactories: [
					...(codemode ? [CODEMODE_EXTENSION] : []),
					...(!options.isolated && this.environment.firecode ? [{ name: "firecode", factory: this.environment.firecode, hidden: true }] : []),
					...(route ? [{ name: "firecode-route", factory: route.extension, hidden: true }] : []),
				],
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
				modelRuntime: runtime,
				model: route.model,
				tools: options.tools,
				resourceLoader: loader,
				settingsManager,
				sessionManager,
			});
			partial = result.session;
			await partial.bindExtensions({ mode: "print", ...(options.onExtensionError ? { onError: options.onExtensionError } : {}) });
			created = partial;
		} catch (error) {
			partial?.dispose();
			route?.dispose();
			if (sessionPath) SESSION_WRITERS.delete(sessionPath);
			throw error;
		}

		const key = sessionPath ?? `memory:${crypto.randomUUID()}`;
		const held: HeldSession = { key, session: created, sessionPath, route };
		// 建会话即挂上、随会话 dispose 失效，所以每次运行的开始与收尾都看得到（idle 的判据）。
		created.subscribe((event) => {
			if (event.type === "agent_start") held.settling ??= Promise.withResolvers();
			else if (event.type === "agent_settled") {
				held.settling?.resolve();
				held.settling = undefined;
			}
		});
		this.held.set(key, held);
		if (codemode) trackCodemodeSession(key, true);
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

	private modelRuntime(): Promise<ModelRuntime> {
		const agentDir = getAgentDir();
		this.runtime ??= ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
		return this.runtime;
	}

	/**
	 * 等池里的子会话真正空闲，再在它上面开回合（prompt 或 triggerTurn）。宿主的 waitForIdle 在 agent_settled 处理器还在跑时就返回
	 * （那时 isIdle 已为 true），此刻的 prompt 与 triggerTurn 被宿主推迟到处理器跑完、调用当场返回而不开回合，回合就没人跟踪了。
	 * 宿主没有“处理器还在跑”的公开状态，只在全部处理器跑完后才把 agent_settled 发给订阅方；所以真正空闲 = waitForIdle 返回，
	 * 且最近一个 agent_start 已等到它的 agent_settled。处理器里又开了运行就再等一轮。
	 */
	async idle(session: AgentSession): Promise<void> {
		for (;;) {
			await session.waitForIdle();
			const settling = [...this.held.values()].find((held) => held.session === session)?.settling;
			if (!settling) return;
			await settling.promise;
		}
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

	/** 何时可释放只由调用方判定：池不按会话事件自判释放；超时后释放热会话，档案与 JSONL 保留。 */
	markIdle(sessionPath: string): void {
		const held = this.held.get(sessionPath);
		if (!held) return;
		this.clearTimer(held);
		held.timer = setTimeout(() => void this.release(held), this.timing.idleSessionMs);
		held.timer.unref?.();
	}

	async dispose(sessionPath: string): Promise<boolean> {
		const held = this.held.get(sessionPath);
		if (!held) return false;
		await this.release(held);
		return true;
	}

	/**
	 * 释放全部落盘的（Worker）会话。内存会话（审查）归创建它的一方 dispose，不在此列：
	 * 池由 Master 与审查共用，Master 关闭时不能顺手掐掉审查会话。
	 */
	async disposeWorkers(): Promise<void> {
		await Promise.all([...this.held.values()].filter((held) => held.sessionPath).map((held) => this.release(held)));
	}

	/** 镜像宿主替换会话的顺序：先 session_shutdown 让扩展收口，再 dispose 作废上下文。 */
	private release(held: HeldSession): Promise<void> {
		if (held.releasing) return held.releasing;
		held.releasing = (async () => {
			this.clearTimer(held);
			if (this.held.get(held.key) === held) this.held.delete(held.key);
			try {
				await held.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				held.session.dispose();
				held.route?.dispose();
				// 会话作废、脚本已被中止后才收回名额。
				trackCodemodeSession(held.key, false);
				if (held.sessionPath) {
					SESSION_WRITERS.delete(held.sessionPath);
					for (const listener of this.releaseListeners) listener(held.sessionPath);
				}
			}
		})();
		const { sessionPath, releasing } = held;
		if (sessionPath) {
			this.releasing.set(sessionPath, releasing);
			const settled = () => {
				if (this.releasing.get(sessionPath) === releasing) this.releasing.delete(sessionPath);
			};
			void releasing.then(settled, settled);
		}
		return releasing;
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
