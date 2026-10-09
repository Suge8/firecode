import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../../jsonc.js";
import { STATUS_KEYS } from "../../../status-keys.js";
import { msg } from "../../messages.js";
import { loadOpenAINativeSettings, togglePriority, type OpenAINativeSettings } from "./config.js";
import { compactWithOpenAINative, declineDisabledReplay, replayOpenAINative } from "./native-compaction.js";
import { applyOpenAIOptions, fastModeEnabled, supportsFastMode } from "./options.js";

const VERBOSITY_FLAG = "verbosity";

function updateFastStatus(ctx: ExtensionContext, settings: OpenAINativeSettings): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEYS.fast,
		fastModeEnabled(ctx.model, settings) ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined,
	);
}

export default function openAINativeExtension(
	pi: ExtensionAPI,
	configPath: string,
	fastShortcut: string,
): void {
	let loadedSettings = loadOpenAINativeSettings(configPath);
	let settings = loadedSettings.settings;
	// 同一次压缩只提醒一次，免得每个请求都弹。
	let warnedCompactionId: string | undefined;

	function toggleFastMode(ctx: ExtensionContext): void {
		if (!ctx.model) {
			return;
		}
		if (!supportsFastMode(ctx.model)) {
			ctx.ui.notify(msg.fastUnsupported, "warning");
			return;
		}

		try {
			const result = togglePriority(ctx.model.provider, configPath);
			loadedSettings = result.loaded;
			settings = loadedSettings.settings;
			updateFastStatus(ctx, settings);
			ctx.ui.notify(msg.fastToggled(result.enabled), "info");
		} catch (error) {
			ctx.ui.notify(msg.fastSaveFailed(error instanceof Error ? error.message : String(error)), "error");
		}
	}

	pi.registerFlag(VERBOSITY_FLAG, {
		description: msg.verbosityFlag,
		type: "string",
	});
	pi.registerCommand("fast", {
		description: msg.fastCommand,
		handler: async (_args, ctx) => {
			toggleFastMode(ctx);
		},
	});
	pi.registerShortcut(fastShortcut as never, {
		description: msg.fastShortcut,
		handler: toggleFastMode,
	});

	pi.on("session_start", (_event, ctx) => {
		if (loadedSettings.warnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(msg.configWarning(loadedSettings.warnings[0]), "warning");
		}
		updateFastStatus(ctx, settings);
	});

	pi.on("model_select", (_event, ctx) => updateFastStatus(ctx, settings));
	pi.on("session_before_compact", (event, ctx) => {
		if (!settings.nativeCompaction) {
			return undefined;
		}
		return compactWithOpenAINative(event, ctx);
	});
	// 先重放原生压缩窗口，再叠加 verbosity / priority：选项只改请求字段，不碰 input。
	pi.on("before_provider_request", (event, ctx) => {
		const replay = settings.nativeCompaction ? replayOpenAINative(event.payload, ctx) : declineDisabledReplay(ctx);
		if (replay && !replay.ok && warnedCompactionId !== replay.compactionId) {
			warnedCompactionId = replay.compactionId;
			const message = `pi-openai-native: could not replay the native compaction (${replay.reason}); history before the last compaction is not in context.`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.error(message);
		}
		const payload = replay?.ok ? replay.payload : event.payload;
		const next = isRecord(payload)
			? applyOpenAIOptions(payload, ctx.model, settings, pi.getFlag(VERBOSITY_FLAG))
			: payload;
		return next === event.payload ? undefined : next;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEYS.fast, undefined);
		}
	});
}
