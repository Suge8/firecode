import type { Api, Model } from "@earendil-works/pi-ai";
import { isTextVerbosity, type OpenAISettings, type ServiceTier, type TextVerbosity } from "../../../config.js";
import { isRecord } from "../../../jsonc.js";
import { isOpenAIResponsesApi } from "./native-details.js";
import { WIRE_TIER } from "./tiers.js";

function resolveTextVerbosity(
	model: Model<Api>,
	settings: OpenAISettings,
	verbosityOverride: unknown,
): TextVerbosity | undefined {
	if (verbosityOverride !== undefined) {
		return isTextVerbosity(verbosityOverride) ? verbosityOverride : undefined;
	}
	return settings.providers[model.provider]?.textVerbosity;
}

/** tier 由 tiers.ts 按当前模型提供的档位定好；undefined 时不动请求里原有的 service_tier。 */
export function applyOpenAIOptions(
	payload: Record<string, unknown>,
	model: Model<Api> | undefined,
	settings: OpenAISettings,
	verbosityOverride: unknown,
	tier: ServiceTier | undefined,
): Record<string, unknown> {
	let nextPayload = payload;

	// verbosity 只属于 OpenAI Responses；xAI Completions 没有这个字段。
	if (model && isOpenAIResponsesApi(model.api)) {
		const textVerbosity = resolveTextVerbosity(model, settings, verbosityOverride);
		if (textVerbosity && (!isRecord(payload.text) || payload.text.verbosity !== textVerbosity)) {
			nextPayload = {
				...nextPayload,
				text: {
					...(isRecord(nextPayload.text) ? nextPayload.text : {}),
					verbosity: textVerbosity,
				},
			};
		}
	}

	if (tier && payload.service_tier !== WIRE_TIER[tier]) {
		nextPayload = nextPayload === payload ? { ...nextPayload } : nextPayload;
		nextPayload.service_tier = WIRE_TIER[tier];
	}

	return nextPayload;
}
