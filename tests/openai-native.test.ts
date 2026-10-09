import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule, PI_AI_COMPAT_URL, PI_CODING_AGENT_URL, PI_PACKAGES } from "./loader.ts";

/**
 * OpenAI 原生压缩的端到端：真实宿主的 SessionManager 与 Responses 转换器，只替换对 OpenAI 的 fetch。
 * 重放与压缩请求的期望值一律取自宿主自己的转换结果——对话中途的系统消息、工具与助手阶段稍有出入，
 * 重放比对就会失败、原生压缩白做。
 */
const { getModel, getModels } = (await import(PI_AI_COMPAT_URL)) as any;
const { SessionManager, convertToLlm } = (await import(PI_CODING_AGENT_URL)) as any;
const { convertResponsesMessages } = (await import(
	pathToFileURL(join(PI_PACKAGES, "ai/src/api/openai-responses-shared.ts")).href
)) as any;
const { default: openAINativeExtension } = (await loadFirecodeModule("provider/openai-native/src/extension.ts")) as any;

// 目录里开启与未开启 supportsMidConvoSystemMessages 的 Responses 模型各取代表；folded：中途系统消息被折进首条提示。
const MODELS = [
	{ provider: "openai", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-5.5", folded: false },
	{ provider: "openai", id: "gpt-5-mini", folded: true },
] as const;
const SHIM = "[OpenAI native compaction checkpoint]";
const directories: string[] = [];
const savedFetch = globalThis.fetch;
let clock = 0;

afterEach(() => {
	globalThis.fetch = savedFetch;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tick = () => ++clock;
const text = (value: string) => [{ type: "text", text: value }];
const user = (value: string) => ({ role: "user", content: text(value), timestamp: tick() });
const system = (fields: Record<string, unknown>) => ({ role: "system", content: "", timestamp: tick(), ...fields });
const toolResult = (id: string, value: string) => ({
	role: "toolResult", toolCallId: id, toolName: "read", content: text(value), isError: false, timestamp: tick(),
});
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (model: any, content: unknown[], stopReason = "stop") => ({
	role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason, usage, content, timestamp: tick(),
});
const answer = (value: string, id: string, phase = "final_answer") => ({
	type: "text", text: value, textSignature: JSON.stringify({ v: 1, id, phase }),
});
const readCall = (id: string) => ({ type: "toolCall", id: `${id}|fc_${id}`, name: "read", arguments: { path: "README.md" } });

/** 宿主发给模型的请求体 input：先 convertToLlm 再转 Responses；压缩请求不带系统提示，普通请求在 openai 上带、在 codex 上走 instructions。 */
function hostInput(model: any, messages: unknown[], leadingInPayload: boolean): unknown[] {
	const compat = model.compat ?? {};
	const codex = model.api === "openai-codex-responses";
	return convertResponsesMessages(model, { messages: convertToLlm(messages) }, new Set([model.provider]), {
		includeSystemPrompt: leadingInPayload && !codex,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools: compat.supportsAdditionalTools ?? false,
		supportsToolSearch: compat.supportsToolSearch ?? false,
		toolOptions: codex
			? { strict: null, supportsStrictMode: compat.supportsStrictMode ?? true, supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false }
			: { supportsStrictMode: compat.supportsStrictMode ?? false, supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false },
	});
}

type Setup = { model: any; openai?: Record<string, unknown>; systemPrompt?: string; hasUI?: boolean; sm?: any };

/** 在真实会话上装配扩展；返回会话、两个宿主钩子的调用入口与通知记录。 */
function harness({ model, openai = { nativeCompaction: true }, systemPrompt = "INSTRUCTIONS", hasUI = false, sm = undefined }: Setup) {
	const directory = mkdtempSync(join(tmpdir(), "firecode-openai-native-"));
	directories.push(directory);
	const configPath = join(directory, "config.jsonc");
	writeFileSync(configPath, JSON.stringify({ openai }));
	const fake = fakePi();
	openAINativeExtension(fake.pi, configPath, "ctrl+shift+s");
	sm ??= SessionManager.inMemory(directory);
	const notices: [string, string][] = [];
	const ctx = (current = model) => ({
		cwd: directory,
		hasUI,
		model: current,
		getSystemPrompt: () => systemPrompt,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }) },
		sessionManager: sm,
		ui: { notify: (message: string, level: string) => notices.push([level, message]), setStatus() {}, theme: { fg: (_: string, value: string) => value } },
	});
	return {
		sm,
		notices,
		/** 宿主的 /compact：以第 firstKept 条起保留；成功时按宿主做法把结果追加成压缩条目。 */
		async compact(firstKeptEntryId: string, options: { current?: any; customInstructions?: string; signal?: AbortSignal } = {}) {
			const result = await fake.fire("session_before_compact", {
				branchEntries: sm.getBranch(),
				signal: options.signal ?? new AbortController().signal,
				customInstructions: options.customInstructions,
				preparation: { firstKeptEntryId, tokensBefore: 4096 },
			}, ctx(options.current));
			if (result?.compaction) sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details);
			return result;
		},
		/** 宿主下一次请求：payload 是宿主自己的转换结果，返回扩展改写后的请求体（未改写为 undefined）。 */
		async request(extra: unknown[] = [], current = model) {
			const messages = sm.buildSessionContext().messages;
			const payload = { model: current.id, instructions: systemPrompt, input: [...hostInput(current, messages, true), ...extra] };
			return { payload, messages, result: await fake.fire("before_provider_request", { payload }, ctx(current)) };
		},
	};
}

/** 把每次 fetch 的请求体记下来，依次回放给定的响应。 */
function stubFetch(...responses: Array<() => Response>) {
	const calls: { url: string; raw: string; body: any }[] = [];
	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		const raw = String(init?.body);
		calls.push({ url: String(url), raw, body: JSON.parse(raw) });
		return responses[Math.min(calls.length, responses.length) - 1]();
	}) as typeof fetch;
	return calls;
}
const compacted = (encrypted: string) => () =>
	Response.json({ created_at: "2026-04-12T00:00:00.000Z", output: [{ type: "message", role: "assistant", content: [] }, { type: "compaction", encrypted_content: encrypted }] });

/** 压缩前的会话：被总结的旧轮次与保留窗口。返回保留窗口的首条 id。 */
function oldHistory(sm: any, model: any): string {
	sm.appendMessage(system({ content: "Base prompt" }));
	sm.appendMessage(user("ancient question"));
	sm.appendMessage(assistant(model, [answer("ancient answer", "msg_ancient")]));
	const kept = sm.appendMessage(user("old question"));
	sm.appendMessage(assistant(model, [answer("Reading.", "msg_read", "commentary"), readCall("call_old")], "toolUse"));
	sm.appendMessage(toolResult("call_old|fc_call_old", "Repository contents."));
	sm.appendMessage(assistant(model, [answer("old answer", "msg_old")]));
	return kept;
}

/** 压缩之后的新轮次：带工具调用的回合、一条中途系统更新、追问。 */
function newTurns(sm: any, model: any) {
	sm.appendMessage(user("new question"));
	sm.appendMessage(assistant(model, [answer("Checking.", "msg_check", "commentary"), readCall("call_new")], "toolUse"));
	sm.appendMessage(toolResult("call_new|fc_call_new", "Release notes say green."));
	sm.appendMessage(assistant(model, [answer("It is green.", "msg_green")]));
	sm.appendMessage(system({ sections: { plan: "NEW PLAN" } }));
	sm.appendMessage(user("follow up"));
}

for (const { provider, id, folded } of MODELS) {
	const model = getModel(provider, id);

	test(`${provider}/${id}: /compact sends the host's history, the shim is persisted, and replay equals the host body with options applied`, async () => {
		const h = harness({ model, openai: { nativeCompaction: true, providers: { [provider]: { textVerbosity: "high", priority: true } } } });
		const kept = oldHistory(h.sm, model);
		const calls = stubFetch(compacted("enc-1"));
		const context = h.sm.buildSessionContext().messages;

		const result = await h.compact(kept, { customInstructions: "Keep the release notes." });

		expect(calls).toHaveLength(1);
		expect(calls[0].body.input).toEqual([...hostInput(model, context, false), { type: "compaction_trigger" }]);
		expect(calls[0].body.instructions).toBe("INSTRUCTIONS\n\nAdditional user guidance for this manual /compact request:\nKeep the release notes.");
		expect(result.compaction).toMatchObject({ summary: SHIM, firstKeptEntryId: kept, tokensBefore: 4096 });
		const window = result.compaction.details.compactedWindow;
		// 保留窗口只留各轮用户消息；中途系统更新在支持时也留（以 developer 角色）。
		expect(window.at(-1)).toEqual({ type: "compaction", encrypted_content: "enc-1" });
		expect(window.slice(0, -1).filter((item: any) => item.role === "user").map((item: any) => item.content[0].text)).toEqual(["ancient question", "old question"]);
		expect(window.some((item: any) => item.type === "function_call")).toBe(false);

		newTurns(h.sm, model);
		const { payload, messages, result: rewritten } = await h.request();
		const leading = model.api === "openai-codex-responses" ? 0 : 1;
		const keptLength = hostInput(model, messages.slice(0, messages.findIndex((message: any) => message.content?.[0]?.text === "new question")), true).length;
		expect(rewritten).toEqual({
			...payload,
			input: [...payload.input.slice(0, leading), ...window, ...payload.input.slice(keptLength)],
			text: { verbosity: "high" },
			service_tier: "priority",
		});
		// 不支持中途系统消息的模型：更新已折进首条提示，其后的输入里没有它。
		const replayed = JSON.stringify(rewritten.input.slice(leading));
		for (const dropped of ["ancient answer", "old answer", "Repository contents.", "compacted into the following summary"]) expect(replayed).not.toContain(dropped);
		expect(replayed.includes("NEW PLAN")).toBe(!folded);
		expect(replayed).toContain("Release notes say green.");
	});

	test(`${provider}/${id}: tools added mid-conversation ${folded ? "are folded into the prompt" : "cannot be replayed, so the request is left to the host"}`, async () => {
		const h = harness({ model, hasUI: true });
		const kept = oldHistory(h.sm, model);
		stubFetch(compacted("enc"));
		await h.compact(kept);
		h.sm.appendMessage(user("new question"));
		h.sm.appendMessage(system({ toolsAdded: [{ name: "tool_b", description: "b", parameters: { type: "object", properties: {} } }] }));
		h.sm.appendMessage(user("use the new tool"));

		const { result } = await h.request();
		await h.request();

		expect(result === undefined).toBe(!folded);
		// 放弃重放时旧历史不在上下文里：提醒用户，且同一次压缩只提醒一次。
		expect(h.notices).toEqual(folded ? [] : [["warning", expect.stringContaining("unsupported-tool-additions")]]);
	});
}

test("a kept window holding another provider's messages still replays, ids notwithstanding", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = harness({ model, hasUI: true });
	h.sm.appendMessage(system({ content: "Base prompt" }));
	const kept = h.sm.appendMessage(user("old question"));
	h.sm.appendMessage(assistant({ provider: "xai", api: "openai-completions", id: "grok-4.6" }, [
		{ type: "thinking", thinking: "Foreign reasoning summary.", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_xai", summary: [], encrypted_content: "xai-encrypted" }) },
		{ type: "text", text: "Reading the repository." },
		{ type: "toolCall", id: "toolu_01.weird:id", name: "read", arguments: { path: "README.md" } },
	], "toolUse"));
	h.sm.appendMessage(toolResult("toolu_01.weird:id", "Repository contents."));
	h.sm.appendMessage(assistant({ provider: "anthropic", api: "anthropic-messages", id: "claude" }, [{ type: "text", text: "Unsigned answer." }]));
	const calls = stubFetch(compacted("enc"));
	const result = await h.compact(kept);
	newTurns(h.sm, model);

	const { payload, messages, result: rewritten } = await h.request();

	const keptLength = hostInput(model, messages.slice(0, messages.findIndex((message: any) => message.content?.[0]?.text === "new question")), true).length;
	expect(calls).toHaveLength(1);
	expect(h.notices).toEqual([]);
	expect(rewritten.input).toEqual([payload.input[0], ...result.compaction.details.compactedWindow, ...payload.input.slice(keptLength)]);
	expect(JSON.stringify(rewritten.input)).not.toContain("Unsigned answer.");
});

test("another provider's opaque reasoning never reaches the compaction request, its visible text does", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = harness({ model });
	h.sm.appendMessage(system({ content: "Base prompt" }));
	const kept = h.sm.appendMessage(user("Inspect the repository."));
	h.sm.appendMessage(assistant({ provider: "xai", api: "openai-completions", id: "grok-4.6" }, [
		{ type: "thinking", thinking: "Foreign reasoning summary.", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_xai", summary: [], encrypted_content: "xai-encrypted" }) },
		{ type: "text", text: "Reading the repository." },
	]));
	h.sm.appendMessage(assistant(model, [
		{ type: "thinking", thinking: "Own reasoning.", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_own", summary: [], encrypted_content: "own-encrypted" }) },
		answer("Done.", "msg_done"),
	]));
	const calls = stubFetch(compacted("enc"));

	await h.compact(kept);

	expect(calls[0].raw).not.toContain("xai-encrypted");
	expect(calls[0].raw).toContain("own-encrypted");
	expect(calls[0].raw).toContain("Foreign reasoning summary.");
	expect(calls[0].raw).toContain("Reading the repository.");
});

test("repeated /compact reuses the latest stored window plus the live tail, and replay uses only the latest window", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = harness({ model });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(compacted("enc-1"), compacted("enc-2"));
	await h.compact(kept);
	newTurns(h.sm, model);
	const tailStart = h.sm.getEntries().findIndex((entry: any) => entry.message?.content?.[0]?.text === "new question");
	const tail = h.sm.getEntries().slice(tailStart).map((entry: any) => entry.message);
	const firstWindow = h.sm.getEntries().find((entry: any) => entry.type === "compaction").details.compactedWindow;

	await h.compact(h.sm.getEntries()[tailStart + 3].id);

	expect(calls[1].body.input).toEqual([...firstWindow, ...hostInput(model, tail.filter((message: any) => message.role !== "system"), false), { type: "compaction_trigger" }]);
	expect(calls[1].raw).not.toContain("compacted into the following summary");
	h.sm.appendMessage(user("after second"));
	const { result } = await h.request();
	const replayed = JSON.stringify(result.input);
	expect(replayed).toContain("enc-2");
	expect(replayed).not.toContain("enc-1");
	expect(replayed).toContain("after second");
});

test("a trailing provider-authored developer prompt keeps its place at the end of the replayed request", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = harness({ model });
	const kept = oldHistory(h.sm, model);
	stubFetch(compacted("enc"));
	await h.compact(kept);
	newTurns(h.sm, model);
	const hint = { role: "developer", content: [{ type: "input_text", text: "# Juice: 0 !important" }] };

	const { result } = await h.request([hint]);

	expect(result.input.at(-1)).toEqual(hint);
	expect(JSON.stringify(result.input)).toContain("enc");
});

test("lone surrogates never reach the compaction request", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = harness({ model, systemPrompt: "Prefix \ud800" });
	h.sm.appendMessage(system({ content: "Base prompt" }));
	const kept = h.sm.appendMessage(user("Hello \udc00"));
	h.sm.appendMessage(assistant(model, [answer("Hi \ud800", "msg_1")]));
	const calls = stubFetch(compacted("enc"));

	await h.compact(kept);

	expect(calls[0].raw).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/iu);
});

test("fails open: the request goes out as Pi built it, and the user is told whenever a native compaction's history is left out", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const other = getModel("openai", "gpt-5.5");
	const anthropic = getModels("anthropic")[0];
	const calls = stubFetch(compacted("enc"));

	const legacy = harness({ model, hasUI: true });
	const legacyKept = oldHistory(legacy.sm, model);
	legacy.sm.appendCompaction("Legacy Pi summary", legacyKept, 100);
	legacy.sm.appendMessage(user("after legacy"));
	expect(await legacy.compact(legacyKept)).toBeUndefined();
	expect((await legacy.request()).result).toBeUndefined();

	const native = harness({ model, hasUI: true });
	const nativeKept = oldHistory(native.sm, model);
	await native.compact(nativeKept);
	expect(calls).toHaveLength(1);
	native.sm.appendMessage(user("after native"));
	expect((await native.request()).result).toBeDefined();
	expect((await native.request([], other)).result).toBeUndefined();
	expect(native.notices).toEqual([["warning", expect.stringContaining("latest-native-compaction-mismatch")]]);
	expect((await native.request([], other)).result).toBeUndefined();
	expect(native.notices).toHaveLength(1);

	// 换到不支持原生压缩的供应商：旧历史同样不在上下文里，同样提醒；同一次压缩只提醒一次。
	const switched = harness({ model, hasUI: true });
	await switched.compact(oldHistory(switched.sm, model));
	switched.sm.appendMessage(user("after switching"));
	expect((await switched.request([], anthropic)).result).toBeUndefined();
	expect((await switched.request([], anthropic)).result).toBeUndefined();
	expect(switched.notices).toEqual([["warning", expect.stringContaining("unsupported-provider")]]);
	expect(calls).toHaveLength(2);

	// 压缩不是原生的：没有原生历史可丢，不提醒。
	expect(legacy.notices).toEqual([]);
	expect(await native.compact(nativeKept, { current: other })).toBeUndefined();
	expect(await native.compact(nativeKept, { current: anthropic })).toBeUndefined();

	// 开关关着：不压缩、不改写，没有压缩过也不提醒；
	const off = harness({ model, openai: { nativeCompaction: false }, hasUI: true });
	expect(await off.compact(oldHistory(off.sm, model))).toBeUndefined();
	expect(calls).toHaveLength(2);
	expect((await off.request()).result).toBeUndefined();
	expect(off.notices).toEqual([]);

	// 但会话里已有原生压缩（之后才关的开关）时，旧历史不在上下文里，同样提醒一次。
	const disabled = harness({ model, openai: { nativeCompaction: false }, hasUI: true, sm: native.sm });
	expect((await disabled.request()).result).toBeUndefined();
	expect((await disabled.request()).result).toBeUndefined();
	expect(disabled.notices).toEqual([["warning", expect.stringContaining("nativeCompaction-disabled")]]);
});

test.each([
	["over the context window", () => new Response(
		`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Too long." } } })}\n\ndata: [DONE]\n`,
		{ status: 200 },
	), 'native compaction failed: input-too-large (HTTP 200): {"code":"context_length_exceeded","message":"Too long."}.'],
	["rejected by the API", () => Response.json({ error: { message: "Invalid input type 'compaction_trigger'." } }, { status: 400 }),
		"native compaction failed: non-2xx (HTTP 400): Invalid input type 'compaction_trigger'."],
])("a native compaction %s cancels /compact with the full reason instead of falling back", async (_name, response, reason) => {
	const model = getModel("openai", "gpt-5-mini");
	const h = harness({ model, hasUI: true });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(response);

	expect(await h.compact(kept)).toEqual({ cancel: true });

	expect(calls).toHaveLength(1);
	expect(h.notices).toEqual([["error", `pi-openai-native: ${reason}`]]);
	expect(h.sm.getEntries().some((entry: any) => entry.type === "compaction")).toBe(false);
});
