/** OpenAI / Codex 请求层：verbosity、加速档（Fast / Ultrafast）、可选原生压缩。 */
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ServiceTier } from "../../config.js";
import { isRecord } from "../../jsonc.js";
import { STATUS_KEYS } from "../../status-keys.js";
import { msg } from "../messages.js";
import { saveServiceTier, withServiceTier } from "./src/config.js";
import { type CompactionHookResult, compactWithOpenAINative, notify, replayOpenAINative } from "./src/native-compaction.js";
import { applyOpenAIOptions } from "./src/options.js";
import { effectiveTier, offeredTiers, sessionAuth } from "./src/tiers.js";

const VERBOSITY_FLAG = "verbosity";

const TIER_LABELS: Record<ServiceTier, string> = { fast: "Fast", ultrafast: "Ultrafast" };

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 原生压缩是否开着：features.openaiNative 与 openai.nativeCompaction 都开。 */
export function nativeCompactionEnabled(): boolean {
	const { features, openai } = loadConfig().config;
	return features.openaiNative !== false && openai.nativeCompaction;
}

export type CompactionHook = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<CompactionHookResult | undefined>;

/**
 * 压缩钩子只注册这一个，先后关系写死在这里：原生压缩先决定（它接管的会话，结果或拒绝都不再往下走），
 * 它不接时才交给 fallback（后台模型链的摘要，见 background/）；都不接就是 pi 默认压缩。
 * 宿主按注册顺序跑处理器、后返回的结果覆盖先返回的，分开注册时后一个会盖掉原生窗口。
 */
export function registerOpenAINative(pi: ExtensionAPI, enabled = true, fallback?: CompactionHook): void {
	let settings = loadConfig().config.openai;
	const nativeEnabled = enabled && nativeCompactionEnabled();

	/** 这次请求实际用的档：没选档时不去问列表。 */
	async function currentTier(ctx: ExtensionContext): Promise<ServiceTier | undefined> {
		const chosen = ctx.model && settings.providers[ctx.model.provider]?.serviceTier;
		return chosen && effectiveTier(chosen, await offeredTiers(ctx.model!, sessionAuth(ctx)));
	}

	async function updateFastStatus(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		// 列表读不到时不显示；选了档的话，发请求时会明确提示。
		const tier = await currentTier(ctx).catch(() => undefined);
		// 等列表期间又切了模型：以后一次的结果为准。
		if (ctx.model !== model) return;
		ctx.ui.setStatus(STATUS_KEYS.fast, tier ? ctx.ui.theme.fg("warning", TIER_LABELS[tier]) : undefined);
	}

	pi.on("session_before_compact", async (event, ctx) => await compactWithOpenAINative(event, ctx, nativeEnabled) ?? await fallback?.(event, ctx));
	pi.on("before_provider_request", async (event, ctx) => {
		const replay = await replayOpenAINative(event.payload, ctx, nativeEnabled);
		if (replay && !replay.ok) {
			// 宿主会吞掉钩子的 throw；用公开 abort 中止流，不能带着占位摘要继续请求。
			ctx.abort();
			notify(ctx, msg.compaction.replayDeclined(replay), "error");
			return;
		}
		const payload = replay?.ok ? replay.payload : event.payload;
		let tier: ServiceTier | undefined;
		if (enabled) {
			try {
				tier = await currentTier(ctx);
			} catch (error) {
				notify(ctx, msg.tiersUnavailableOnSend(reasonOf(error)), "error");
			}
		}
		const next = enabled && isRecord(payload) ? applyOpenAIOptions(payload, ctx.model, settings, pi.getFlag(VERBOSITY_FLAG), tier) : payload;
		return next === event.payload ? undefined : next;
	});
	if (!enabled) return;

	/** 关 → 当前模型提供的各档从慢到快 → 关。档按供应商存，所以从模型实际生效的那一档往下走。 */
	async function cycleFastMode(ctx: ExtensionContext): Promise<void> {
		const model = ctx.model;
		if (!model) return;
		let offered: readonly ServiceTier[];
		try {
			offered = await offeredTiers(model, sessionAuth(ctx));
		} catch (error) {
			ctx.ui.notify(msg.tiersUnavailable(reasonOf(error)), "error");
			return;
		}
		if (offered.length === 0) {
			ctx.ui.notify(msg.fastUnsupported, "warning");
			return;
		}
		const current = effectiveTier(settings.providers[model.provider]?.serviceTier, offered);
		const next = current ? offered[offered.indexOf(current) + 1] : offered[0];
		try {
			saveServiceTier(model.provider, next);
		} catch (error) {
			ctx.ui.notify(msg.fastSaveFailed(reasonOf(error)), "error");
			return;
		}
		settings = withServiceTier(settings, model.provider, next);
		await updateFastStatus(ctx);
		ctx.ui.notify(msg.fastSwitched(next && TIER_LABELS[next]), "info");
	}

	pi.registerFlag(VERBOSITY_FLAG, { description: msg.verbosityFlag, type: "string" });
	pi.registerCommand("fast", {
		description: msg.fastCommand,
		handler: async (_args, ctx) => cycleFastMode(ctx),
	});
	pi.registerShortcut(loadConfig().config.keys.fast as never, {
		description: msg.fastShortcut,
		handler: cycleFastMode,
	});

	pi.on("session_start", (_event, ctx) => updateFastStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateFastStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEYS.fast, undefined);
	});
}
