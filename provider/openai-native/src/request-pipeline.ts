import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../../jsonc.js";
import type { OpenAINativeSettings } from "./config";
import { replayOpenAINative } from "./native-compaction";
import { applyOpenAIOptions } from "./options";

export function rewriteOpenAIProviderRequest(
	payload: unknown,
	ctx: ExtensionContext,
	settings: OpenAINativeSettings,
	verbosityOverride: unknown,
): unknown {
	let nextPayload = settings.nativeCompaction ? replayOpenAINative(payload, ctx) ?? payload : payload;
	if (isRecord(nextPayload)) {
		nextPayload = applyOpenAIOptions(nextPayload, ctx.model, settings, verbosityOverride);
	}
	return nextPayload;
}
