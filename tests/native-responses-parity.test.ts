import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFirecodeModule, PI_AI_COMPAT_URL, PI_CODING_AGENT_URL, PI_PACKAGES } from "./loader.ts";

/**
 * 原生压缩把会话重放成 Responses 输入：对话中途的系统消息必须与宿主的转换器逐项一致，
 * 否则重放比对失败、原生压缩白做。这里用真实模型目录里的模型，以宿主自己的 convertResponsesMessages 为准。
 */
const { getModel } = (await import(PI_AI_COMPAT_URL)) as any;
const { convertToLlm } = (await import(PI_CODING_AGENT_URL)) as any;
const { convertResponsesMessages } = (await import(
	pathToFileURL(join(PI_PACKAGES, "ai/src/api/openai-responses-shared.ts")).href
)) as any;
const { rewriteNativeResponsesPayload } = (await loadFirecodeModule("provider/openai-native/src/native-replay.ts")) as any;
const { serializeMessagesToCompactRequest } = (await loadFirecodeModule("provider/openai-native/src/responses-input.ts")) as any;
const { createNativeCompactionDetails } = (await loadFirecodeModule("provider/openai-native/src/native-details.ts")) as any;

// 目录里开启与未开启 supportsMidConvoSystemMessages 的 Responses 模型各取代表。
const MODELS = [
	{ provider: "openai", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-5.5", folded: false },
	{ provider: "openai", id: "gpt-5-mini", folded: true },
] as const;

const TOOL_B = { name: "tool_b", description: "b", parameters: { type: "object", properties: {} } };
const text = (value: string) => [{ type: "text", text: value }];
let clock = 0;
const nextTime = () => ++clock;

function hostInput(model: any, messages: unknown[], leadingInPayload: boolean): unknown[] {
	const compat = model.compat ?? {};
	const codex = model.api === "openai-codex-responses";
	return convertResponsesMessages(model, { messages }, new Set([model.provider]), {
		includeSystemPrompt: leadingInPayload && !codex,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools: compat.supportsAdditionalTools ?? false,
		supportsToolSearch: compat.supportsToolSearch ?? false,
		toolOptions: codex
			? { strict: null, supportsStrictMode: compat.supportsStrictMode ?? true, supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false }
			: { supportsStrictMode: compat.supportsStrictMode ?? false, supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false },
	});
}

function messageEntry(id: string, message: unknown) {
	return { type: "message", id, parentId: null, timestamp: new Date(1_700_000_000_000 + nextTime() * 1000).toISOString(), message };
}

function scenario(model: any, update: Record<string, unknown>) {
	const user = (value: string) => ({ role: "user", content: text(value), timestamp: nextTime() });
	const system = (fields: Record<string, unknown>) => ({ role: "system", content: "", timestamp: nextTime(), ...fields });
	const assistant = {
		role: "assistant",
		provider: model.provider,
		api: model.api,
		model: model.id,
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "text", text: "answer", textSignature: JSON.stringify({ v: 1, id: "msg_answer", phase: "final_answer" }) }],
		timestamp: nextTime(),
	};
	const lead = system({ content: "Base prompt", toolsAdded: [{ ...TOOL_B, name: "tool_a" }] });
	const kept = user("old question");
	const staleUpdate = system({ content: "STALE UPDATE" });
	const compactedWindow = [{ type: "compaction", encrypted_content: "opaque" }];
	const compaction = {
		type: "compaction",
		id: "compaction",
		parentId: null,
		timestamp: new Date(1_700_000_100_000).toISOString(),
		summary: "shim",
		firstKeptEntryId: "kept",
		tokensBefore: 1,
		systemMessage: lead,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow,
		}),
	};
	const postUpdate = system(update);
	const finalUpdate = system({ content: "FINAL UPDATE" });
	const branchEntries = [
		messageEntry("kept", kept),
		messageEntry("stale", staleUpdate),
		compaction,
		messageEntry("p1", user("new question")),
		messageEntry("p2", assistant),
		messageEntry("p3", postUpdate),
		messageEntry("p4", user("follow up")),
		messageEntry("p5", finalUpdate),
	];
	const summary = convertToLlm([{ role: "compactionSummary", summary: "shim", tokensBefore: 1, timestamp: 0 }])[0];
	const context = [lead, summary, kept, ...branchEntries.slice(3).map((entry: any) => entry.message)];
	return { branchEntries, compaction, compactedWindow, lead, summary, kept, context };
}

for (const { provider, id, folded } of MODELS) {
	const model = getModel(provider, id);
	const label = `${provider}/${id}`;

	test(`${label}: native replay equals the host's request body, mid-conversation updates included`, () => {
		const { branchEntries, compaction, compactedWindow, lead, summary, kept, context } = scenario(model, {
			sections: { plan: "NEW PLAN" },
		});
		const input = hostInput(model, context, true);
		const result = rewriteNativeResponsesPayload({
			model,
			payload: { model: model.id, instructions: "current instructions", input },
			branchEntries,
			compactionEntry: compaction,
		});

		const leading = model.api === "openai-codex-responses" ? 0 : 1;
		const keptLength = hostInput(model, [lead, summary, kept], true).length;
		expect(result).toMatchObject({ ok: true });
		expect(result.payload.input).toEqual([...input.slice(0, leading), ...compactedWindow, ...input.slice(keptLength)]);
		const replayed = JSON.stringify(result.payload.input.slice(leading));
		expect(replayed).not.toContain("STALE UPDATE");
		expect(replayed.includes("NEW PLAN")).toBe(!folded);
		expect(replayed.includes("FINAL UPDATE")).toBe(!folded);
	});

	test(`${label}: the compaction request carries the same history as the host, minus the system prompt`, () => {
		const { context } = scenario(model, { sections: { plan: "NEW PLAN" } });
		const request = serializeMessagesToCompactRequest({ model, messages: context, instructions: "i" });
		expect(request.input).toEqual(hostInput(model, context, false));
	});

	test(`${label}: tools added mid-conversation ${folded ? "are folded into the prompt" : "cannot be replayed, so replay is declined by name"}`, () => {
		const { branchEntries, compaction, context } = scenario(model, { toolsAdded: [TOOL_B] });
		const result = rewriteNativeResponsesPayload({
			model,
			payload: { model: model.id, instructions: "i", input: hostInput(model, context, true) },
			branchEntries,
			compactionEntry: compaction,
		});
		if (folded) expect(result).toMatchObject({ ok: true });
		else expect(result).toEqual({ ok: false, reason: "unsupported-tool-additions" });
	});
}
