/** OpenAI / Codex 请求层：verbosity、Fast（priority）、可选原生压缩。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH } from "../../config-file.js";
import { loadConfig } from "../../config.js";
import { isRecord } from "../../jsonc.js";
import { STATUS_KEYS } from "../../status-keys.js";
import { msg } from "../messages.js";
import { loadOpenAINativeSettings, type OpenAINativeSettings, togglePriority } from "./src/config.js";
import { compactWithOpenAINative, declineDisabledReplay, notify, replayOpenAINative } from "./src/native-compaction.js";
import { applyOpenAIOptions, fastModeEnabled, supportsFastMode } from "./src/options.js";

const VERBOSITY_FLAG = "verbosity";

function updateFastStatus(ctx: ExtensionContext, settings: OpenAINativeSettings): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEYS.fast, fastModeEnabled(ctx.model, settings) ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined);
}

export function registerOpenAINative(pi: ExtensionAPI): void {
	let loaded = loadOpenAINativeSettings(CONFIG_PATH);
	// 同一次压缩只提醒一次，免得每个请求都弹。
	let warnedCompactionId: string | undefined;

	function toggleFastMode(ctx: ExtensionContext): void {
		if (!ctx.model) return;
		if (!supportsFastMode(ctx.model)) {
			ctx.ui.notify(msg.fastUnsupported, "warning");
			return;
		}
		try {
			const result = togglePriority(ctx.model.provider, CONFIG_PATH);
			loaded = result.loaded;
			updateFastStatus(ctx, loaded.settings);
			ctx.ui.notify(msg.fastToggled(result.enabled), "info");
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

	pi.on("session_start", (_event, ctx) => {
		if (loaded.warnings.length > 0 && ctx.hasUI) ctx.ui.notify(msg.configWarning(loaded.warnings[0]), "warning");
		updateFastStatus(ctx, loaded.settings);
	});
	pi.on("model_select", (_event, ctx) => updateFastStatus(ctx, loaded.settings));
	pi.on("session_before_compact", (event, ctx) => (loaded.settings.nativeCompaction ? compactWithOpenAINative(event, ctx) : undefined));
	// 先重放原生压缩窗口，再叠加 verbosity / priority：选项只改请求字段，不碰 input。
	pi.on("before_provider_request", async (event, ctx) => {
		const { settings } = loaded;
		const replay = settings.nativeCompaction ? await replayOpenAINative(event.payload, ctx) : declineDisabledReplay(ctx);
		if (replay && !replay.ok && warnedCompactionId !== replay.compactionId) {
			warnedCompactionId = replay.compactionId;
			notify(ctx, msg.compaction.replayDeclined(replay), "warning");
		}
		const payload = replay?.ok ? replay.payload : event.payload;
		const next = isRecord(payload) ? applyOpenAIOptions(payload, ctx.model, settings, pi.getFlag(VERBOSITY_FLAG)) : payload;
		return next === event.payload ? undefined : next;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEYS.fast, undefined);
	});
}
