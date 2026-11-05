import { clampThinkingLevel, isRetryableAssistantError, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ModelAtom, type ModelChain, type ThinkingLevelValue } from "./config.js";
import { matchModels } from "./model-match.js";
import { msg } from "./messages.js";
import { processShared } from "./process-shared.js";

/** transient：失败会自己过去（网络、过载、限流、写明重置时刻的额度窗口）；否则是鉴权、参数、模型不存在这类要人处理的。 */
interface Cooldown { failures: number; until: number; reason: string; transient: boolean }
interface Candidate { model: Model<Api>; thinking: ThinkingLevelValue }
/** candidates 是最近一次选模型时的候选表：链暂停判定按它查冷却表，不再异步取可用模型。 */
interface RouteState { current?: Candidate; candidates?: Candidate[] }
const cooldowns = processShared("model-cooldowns", () => new Map<string, Cooldown>());
const routes = processShared("physical-models", () => new Map<string, RouteState>());
export function physicalModel(model: Model<Api> | undefined): Model<Api> | undefined {
	return model?.api === "pi-virtual" ? routes.get(`${model.provider}/${model.id}`)?.current?.model : model;
}
const key = (model: Model<Api>) => `${model.provider}/${model.id}`;

/**
 * 宿主分类器之外的瞬时网络错误：Bun fetch 断网时报 “Unable to connect…” 与 ECONNRESET 一类系统错误码，宿主的模式表不认；
 * 不补上它们，断网就会被当成要人处理的失败，恢复后没人续跑。
 */
const NETWORK_ERROR = /unable to connect|\beconn(?:reset|refused|aborted)\b|\benetunreach\b|\behostunreach\b|\betimedout\b/iu;

/** 失败会不会自己过去：宿主判为可重试的、宿主漏掉的断网错误，或报错写明了额度重置时刻。 */
export function transientFailure(reason: string): boolean {
	const message = { role: "assistant", stopReason: "error", errorMessage: reason } as AssistantMessage;
	return isRetryableAssistantError(message) || NETWORK_ERROR.test(reason) || resetTime(reason, Date.now()) !== undefined;
}

/** 第 failures 次连续失败后何时再试：报错写明的重置时刻优先，否则按冷却阶梯（Timing.cooldownMs）。 */
export function retryAt(reason: string, failures: number, ladder: readonly number[], now = Date.now()): number {
	return resetTime(reason, now) ?? now + ladder[Math.min(failures, ladder.length) - 1]!;
}

/** 整条链暂时不可用：最早恢复的瞬时失败候选的时刻与原因。 */
export interface ChainPause { until: number; reason: string }

/**
 * 路由的链此刻是否整条暂停：候选表里每个都有冷却记录（失败过且没成功过），且至少一个是瞬时失败；
 * 恢复时刻取瞬时失败里最早的那个（已过就是现在）。有没失败过的候选、或全是非瞬时失败时没有暂停，照常算失败。
 * 物理模型（不经路由的会话）没有暂停。
 */
export function routePause(model: Model<Api> | undefined): ChainPause | undefined {
	const list = model?.api === "pi-virtual" ? routes.get(key(model))?.candidates : undefined;
	if (!list?.length) return undefined;
	const entries = list.map(({ model: candidate }) => cooldowns.get(key(candidate)));
	if (entries.some((entry) => !entry)) return undefined;
	const first = entries.filter((entry) => entry!.transient).sort((a, b) => a!.until - b!.until)[0];
	return first && { until: Math.max(first.until, Date.now()), reason: first.reason };
}

/** 报错里写明的额度重置时刻；读不出就交给退避表。 */
function resetTime(reason: string, now: number): number | undefined {
	const minutes = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*min/iu.exec(reason);
	if (minutes) return now + Number(minutes[1]) * 60_000;
	const seconds = /["']?resets_in_seconds["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/iu.exec(reason);
	if (seconds) return now + Number(seconds[1]) * 1000;
	// Claude 订阅：“You've hit your 5-hour limit · resets 5:10am (Asia/Singapore)”，只给当地时刻与 IANA 时区。
	const clock = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/iu.exec(reason);
	if (clock) {
		const hour = Number(clock[1]);
		const meridiem = clock[3]?.toLowerCase();
		return nextWallClock(now, clock[4]!, meridiem ? hour % 12 + (meridiem === "pm" ? 12 : 0) : hour, Number(clock[2] ?? 0));
	}
	const at = /["']?resets_at["']?\s*[:=]\s*["']?([^"',}\s]+)/iu.exec(reason);
	if (!at) return undefined;
	const numeric = Number(at[1]);
	const time = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(at[1]);
	return Number.isFinite(time) && time > now ? time : undefined;
}

/** 时区 zone 里下一次到达 hour:minute 的时刻；时区不认识时读不出。 */
function nextWallClock(now: number, zone: string, hour: number, minute: number): number | undefined {
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
	} catch {
		return undefined;
	}
	const wall = (time: number) => {
		const part = Object.fromEntries(format.formatToParts(time).map((entry) => [entry.type, Number(entry.value)]));
		return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
	};
	const today = new Date(wall(now));
	for (let day = 0; day <= 1; day += 1) {
		const target = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
		// 当地时刻换成绝对时刻：减去该时刻附近的时区偏移，再按新位置的偏移校一次（跨夏令时）。
		let time = target - (wall(target) - target);
		time = target - (wall(time) - time);
		if (time > now) return time;
	}
	return undefined;
}

export async function candidates(runtime: ModelRuntime, chain: ModelChain): Promise<Candidate[]> {
	const available = (await runtime.getAvailable()).filter((model) => model.api !== "pi-virtual");
	const seen = new Set<string>();
	return chain.flatMap((atom) => matchModels(available, atom.model).flatMap((model) => {
		const name = key(model);
		if (seen.has(name)) return [];
		seen.add(name);
		return [{ model, thinking: atom.thinking }];
	}));
}

export async function createModelRoute(
	runtime: ModelRuntime,
	initialChain: ModelChain,
	ladder: readonly number[],
	initialOverride?: ThinkingLevelValue,
	onChange?: (atom: ModelAtom, previous?: ModelAtom, reason?: string) => void,
): Promise<{ model: Model<Api>; extension: ExtensionFactory; configure(chain: ModelChain, override?: ThinkingLevelValue): void; dispose(): void }> {
	let chain = initialChain;
	let override = initialOverride;
	const provider = "firecode-route";
	const id = crypto.randomUUID();
	const state: RouteState = {};
	/**
	 * 任务相：idle 没有回合在跑（空闲时的 direct 请求按新任务从链首选）；pending 新回合已开始、第一个请求还没路由，从链首重选；
	 * running 同一件活留在当前模型。attempted 是本任务里已经以最终错误失败的模型与原因；failure 是当前模型刚失败的原因，
	 * 只在紧接着的那次换模型上报告，换完即清，新任务不会带出旧任务的错误。
	 */
	type Task = { phase: "idle" } | { phase: "pending" | "running"; attempted: Map<string, string>; failure?: string };
	let task: Task = { phase: "idle" };
	const attemptedOf = (current: Task) => (current.phase === "idle" ? new Map<string, string>() : current.attempted);
	const fail = (model: Model<Api>, reason: string, cool: boolean) => {
		if (task.phase === "idle") return;
		const name = key(model);
		task.attempted.set(name, reason);
		task.failure = reason;
		if (!cool) return;
		const failures = (cooldowns.get(name)?.failures ?? 0) + 1;
		cooldowns.set(name, { failures, reason, until: retryAt(reason, failures, ladder), transient: transientFailure(reason) });
	};
	const choose = async (restart: boolean) => {
		const list = await candidates(runtime, chain);
		state.candidates = list;
		const attempted = attemptedOf(task);
		const failure = task.phase === "idle" ? undefined : task.failure;
		const available = list.filter(({ model }) => !attempted.has(key(model)) && (cooldowns.get(key(model))?.until ?? 0) <= Date.now());
		const selected = !restart && failure === undefined && state.current && list.find(({ model }) => key(model) === key(state.current!.model)) || available[0];
		if (!selected) {
			const reasons = chain.flatMap((atom) => {
				const matches = matchModels(list.map((entry) => entry.model), atom.model);
				if (!matches.length) return [msg.spawn.modelUnavailable(atom.model)];
				return matches.map((model) => {
					const name = key(model);
					const failure = cooldowns.get(name);
					const reason = attempted.get(name);
					if (reason && failure?.reason !== reason) return msg.spawn.modelFailed(name, reason);
					return failure ? msg.spawn.modelCooling(name, failure.reason, new Date(failure.until).toISOString()) : msg.spawn.modelUnavailable(name);
				});
			});
			const times = list.flatMap(({ model }) => {
				const failure = cooldowns.get(key(model));
				return failure ? [failure.until] : [];
			});
			const earliest = times.length ? msg.spawn.earliestRecovery(new Date(Math.min(...times)).toISOString()) : "";
			throw new Error(msg.spawn.chainExhausted([reasons.join("; "), earliest].filter(Boolean).join("; ")));
		}
		const previous = state.current && { model: key(state.current.model), thinking: state.current.thinking };
		const atom = { model: key(selected.model), thinking: clampThinkingLevel(selected.model, override ?? selected.thinking) };
		state.current = { model: selected.model, thinking: atom.thinking };
		if (task.phase !== "idle") task = { phase: "running", attempted };
		if (!previous || previous.model !== atom.model || previous.thinking !== atom.thinking) onChange?.(atom, previous, failure);
		return { model: selected.model, thinkingLevel: atom.thinking };
	};
	runtime.registerVirtualModel({ provider, id, name: "FireCode", thinkingLevels: THINKING_LEVELS,
		route: async (request) => {
			// 宿主重试的是路由自己抛的“链已用尽”时没有 failed：重新选（冷却期内照旧抛），不把刚冷却的模型再交出去——
			// 否则报错文本命中宿主的可重试模式时，重试与续跑交替，整条链冷却期间也在同一回合里无限循环。
			if (request.reason === "retry" && request.failed && state.current) {
				if (task.phase === "pending") task = { ...task, phase: "running" };
				return { model: state.current.model, thinkingLevel: state.current.thinking };
			}
			return choose(request.reason === "direct" ? task.phase === "idle" : task.phase === "pending" && request.reason !== "retry");
		},
	});
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`Virtual model ${provider}/${id} was not registered`);
	routes.set(`${provider}/${id}`, state);
	const extension: ExtensionFactory = (pi) => {
		// 续跑（agent_before_settle 返回 continue）在同一任务里再开回合，不是新任务。
		pi.on("agent_start", () => { if (task.phase === "idle") task = { phase: "pending", attempted: new Map() }; });
		pi.on("agent_settled", () => { task = { phase: "idle" }; });
		pi.on("message_end", (event) => {
			const message = event.message;
			if (message.role === "assistant" && state.current && message.api !== "pi-virtual"
				&& message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length") cooldowns.delete(key(state.current.model));
		});
		pi.on("agent_before_settle", (event, ctx) => {
			if (event.outcome === "aborted" || event.continue) return;
			const failure = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message");
			if (failure?.type !== "message" || failure.message.role !== "assistant") return;
			if (failure.message.stopReason !== "error" && failure.message.stopReason !== "length") return;
			if (!state.current || failure.message.api === "pi-virtual") return;
			const reason = failure.message.stopReason === "length" ? msg.outputTruncated : failure.message.errorMessage ?? "model error";
			if (task.phase !== "idle" && task.failure === undefined) fail(state.current.model, reason, failure.message.stopReason === "error");
			return { entries: [...event.entries, { type: "context_edit", targetId: failure.id, replacement: null }], continue: true };
		});
	};
	return { model, extension, configure: (next, level) => { chain = next; override = level; }, dispose: () => { routes.delete(`${provider}/${id}`); runtime.unregisterVirtualModel(provider, id); } };
}
