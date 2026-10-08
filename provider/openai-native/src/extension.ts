import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadOpenAINativeSettings,
	togglePriority,
	type OpenAINativeSettings,
} from "./config";
import { msg } from "../../messages.js";
import { compactWithOpenAINative } from "./native-compaction";
import { FAST_STATUS_KEY, fastModeEnabled, supportsFastMode } from "./options";
import { rewriteOpenAIProviderRequest } from "./request-pipeline";

const VERBOSITY_FLAG = "verbosity";

function updateFastStatus(ctx: ExtensionContext, settings: OpenAINativeSettings): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus(
		FAST_STATUS_KEY,
		fastModeEnabled(ctx.model, settings) ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined,
	);
}

function notifyUnsupportedFastMode(ctx: ExtensionContext): void {
	ctx.ui.notify(msg.fastUnsupported, "warning");
}

export default function openAINativeExtension(
	pi: ExtensionAPI,
	configPath: string,
	fastShortcut: string,
): void {
	let loadedSettings = loadOpenAINativeSettings(configPath);
	let settings = loadedSettings.settings;

	function toggleFastMode(ctx: ExtensionContext): void {
		if (!ctx.model) {
			return;
		}
		if (!supportsFastMode(ctx.model)) {
			notifyUnsupportedFastMode(ctx);
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
	pi.on("before_provider_request", (event, ctx) => {
		const nextPayload = rewriteOpenAIProviderRequest(event.payload, ctx, settings, pi.getFlag(VERBOSITY_FLAG));
		return nextPayload === event.payload ? undefined : nextPayload;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
		}
	});
}
