import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ModelAtom, type ModelChain, type ThinkingLevelValue } from "./config.js";
import { matchModels } from "./model-match.js";
import { msg } from "./messages.js";
import { processShared } from "./process-shared.js";

interface Cooldown { failures: number; until: number; reason: string }
interface Candidate { model: Model<Api>; thinking: ThinkingLevelValue }
interface RouteState { current?: Candidate }
const cooldowns = processShared("model-cooldowns", () => new Map<string, Cooldown>());
const routes = processShared("physical-models", () => new Map<string, RouteState>());
export function physicalModel(model: Model<Api> | undefined): Model<Api> | undefined {
	return model?.api === "pi-virtual" ? routes.get(`${model.provider}/${model.id}`)?.current?.model : model;
}
const DELAYS = [5, 15, 60].map((minutes) => minutes * 60_000);
const key = (model: Model<Api>) => `${model.provider}/${model.id}`;

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
		const previous = cooldowns.get(name);
		const failures = (previous?.failures ?? 0) + 1;
		const now = Date.now();
		cooldowns.set(name, { failures, reason, until: resetTime(reason, now) ?? now + DELAYS[Math.min(failures - 1, DELAYS.length - 1)] });
	};
	const choose = async (restart: boolean) => {
		const list = await candidates(runtime, chain);
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
			if (request.reason === "retry" && state.current) {
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
