/** OpenAI / Codex 请求层：verbosity、Fast（priority）、可选原生压缩。 */
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig, type OpenAISettings } from "../../config.js";
import { isRecord } from "../../jsonc.js";
import { STATUS_KEYS } from "../../status-keys.js";
import { msg } from "../messages.js";
import { togglePriority, withPriority } from "./src/config.js";
import { type CompactionHookResult, compactWithOpenAINative, notify, replayOpenAINative } from "./src/native-compaction.js";
import { applyOpenAIOptions, fastModeEnabled, supportsFastMode } from "./src/options.js";

const VERBOSITY_FLAG = "verbosity";

function updateFastStatus(ctx: ExtensionContext, settings: OpenAISettings): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEYS.fast, fastModeEnabled(ctx.model, settings) ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined);
}

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
		const next = enabled && isRecord(payload) ? applyOpenAIOptions(payload, ctx.model, settings, pi.getFlag(VERBOSITY_FLAG)) : payload;
		return next === event.payload ? undefined : next;
	});
	if (!enabled) return;

	function toggleFastMode(ctx: ExtensionContext): void {
		if (!ctx.model) return;
		if (!supportsFastMode(ctx.model)) {
			ctx.ui.notify(msg.fastUnsupported, "warning");
			return;
		}
		try {
			const enabled = togglePriority(ctx.model.provider);
			settings = withPriority(settings, ctx.model.provider, enabled);
			updateFastStatus(ctx, settings);
			ctx.ui.notify(msg.fastToggled(enabled), "info");
		} catch (error) {
			ctx.ui.notify(msg.fastSaveFailed(error instanceof Error ? error.message : String(error)), "error");
		}
	}

	pi.registerFlag(VERBOSITY_FLAG, { description: msg.verbosityFlag, type: "string" });
	pi.registerCommand("fast", {
		description: msg.fastCommand,
		handler: async (_args, ctx) => toggleFastMode(ctx),
	});
	pi.registerShortcut(loadConfig().config.keys.fast as never, {
		description: msg.fastShortcut,
		handler: toggleFastMode,
	});

	pi.on("session_start", (_event, ctx) => updateFastStatus(ctx, settings));
	pi.on("model_select", (_event, ctx) => updateFastStatus(ctx, settings));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEYS.fast, undefined);
	});
}
