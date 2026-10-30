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

function resetTime(reason: string, now: number): number | undefined {
	const minutes = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*min/iu.exec(reason);
	if (minutes) return now + Number(minutes[1]) * 60_000;
	const seconds = /["']?resets_in_seconds["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/iu.exec(reason);
	if (seconds) return now + Number(seconds[1]) * 1000;
	const at = /["']?resets_at["']?\s*[:=]\s*["']?([^"',}\s]+)/iu.exec(reason);
	if (!at) return undefined;
	const numeric = Number(at[1]);
	const time = Number.isFinite(numeric) ? numeric < 1e12 ? numeric * 1000 : numeric : Date.parse(at[1]);
	return Number.isFinite(time) && time > now ? time : undefined;
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
	let lastReason: string | undefined;
	let currentFailed = false;
	let nextTask = true;
	let settled = true;
	const attempted = new Map<string, string>();
	const fail = (model: Model<Api>, reason: string, cool: boolean) => {
		const name = key(model);
		attempted.set(name, reason);
		if (cool) {
			const previous = cooldowns.get(name);
			const failures = (previous?.failures ?? 0) + 1;
			const now = Date.now();
			cooldowns.set(name, { failures, reason, until: resetTime(reason, now) ?? now + DELAYS[Math.min(failures - 1, DELAYS.length - 1)] });
		}
		lastReason = reason;
	};
	const choose = async (restart: boolean) => {
		const list = await candidates(runtime, chain);
		const available = list.filter(({ model }) => !attempted.has(key(model)) && (cooldowns.get(key(model))?.until ?? 0) <= Date.now());
		const selected = !restart && !currentFailed && state.current && list.find(({ model }) => key(model) === key(state.current!.model)) || available[0];
		if (!selected) {
			const reasons = chain.flatMap((atom) => {
				const matches = list.filter((entry) => entry.model.id === atom.model || key(entry.model) === atom.model || key(entry.model).endsWith(`/${atom.model}`));
				if (!matches.length) return [msg.spawn.modelUnavailable(atom.model)];
				return matches.map(({ model }) => {
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
		currentFailed = false;
		if (!previous || previous.model !== atom.model || previous.thinking !== atom.thinking) onChange?.(atom, previous, lastReason);
		return { model: selected.model, thinkingLevel: atom.thinking };
	};
	runtime.registerVirtualModel({ provider, id, name: "FireCode", thinkingLevels: THINKING_LEVELS,
		route: async (request) => {
			if (request.reason === "retry" && state.current) {
				nextTask = false;
				return { model: state.current.model, thinkingLevel: state.current.thinking };
			}
			const restart = request.reason === "direct" ? settled : nextTask && request.reason !== "retry";
			nextTask = false;
			return choose(restart);
		},
	});
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`Virtual model ${provider}/${id} was not registered`);
	routes.set(`${provider}/${id}`, state);
	const extension: ExtensionFactory = (pi) => {
		pi.on("agent_start", () => {
			if (settled) attempted.clear();
			nextTask = settled;
			settled = false;
		});
		pi.on("agent_settled", () => { settled = true; });
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
			if (!currentFailed) fail(state.current.model, reason, failure.message.stopReason === "error");
			currentFailed = true;
			return { entries: [...event.entries, { type: "context_edit", targetId: failure.id, replacement: null }], continue: true };
		});
	};
	return { model, extension, configure: (next, level) => { chain = next; override = level; }, dispose: () => { routes.delete(`${provider}/${id}`); runtime.unregisterVirtualModel(provider, id); } };
}
