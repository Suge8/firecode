import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule, PI_AI_COMPAT_URL, PI_CODING_AGENT_URL } from "./loader.ts";

/**
 * OpenAI 请求层的端到端：真实宿主的 SessionManager 与流，只替换对 OpenAI 的 fetch。
 * 压缩请求与重放的期望值取自宿主自己对同一份会话构造的请求体——对话中途的系统消息、工具与助手阶段稍有出入，
 * 重放就会放弃、原生压缩白做。
 */
const { getModel, getModels, streamSimple } = (await import(PI_AI_COMPAT_URL)) as any;
const { SessionManager, convertToLlm } = (await import(PI_CODING_AGENT_URL)) as any;

// 目录里开启与未开启 supportsMidConvoSystemMessages 的 Responses 模型各取代表；folded：中途系统消息被折进首条提示。
const MODELS = [
	{ provider: "openai", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-6.1-sol", folded: false },
	{ provider: "openai-codex", id: "gpt-5.5", folded: false },
	{ provider: "openai", id: "gpt-5-mini", folded: true },
] as const;
const INSTRUCTIONS = "INSTRUCTIONS";
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

const jwt = (account: string) => {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
	return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: account } })}.sig`;
};
const apiKeyFor = (model: any) => (model.provider === "openai-codex" ? jwt("acct_test") : "sk-test");

/** 宿主对这批消息会发出的请求体：同一份会话交给宿主自己的流，在发出前截下 onPayload 的参数。 */
async function hostPayload(model: any, messages: unknown[], reasoning?: string): Promise<any> {
	let captured: unknown;
	const stream = streamSimple(model, { messages: convertToLlm(messages) }, {
		apiKey: apiKeyFor(model),
		reasoning,
		onPayload: (payload: unknown) => { captured = payload; throw new Error("captured"); },
	});
	for await (const _ of stream);
	return captured;
}

/** Responses 接口对输入条目 id 与 call_id 的格式要求（宿主转换时按同一规则规整）。 */
function malformedIds(items: any[]): string[] {
	return items.flatMap((item) => {
		const problems: string[] = [];
		if (item.call_id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(item.call_id)) problems.push(`call_id ${item.call_id}`);
		if (item.type === "function_call" && item.id !== undefined && !item.id.startsWith("fc_")) problems.push(`function_call id ${item.id}`);
		if (item.type === "custom_tool_call" && item.id !== undefined && !item.id.startsWith("ctc_")) problems.push(`custom_tool_call id ${item.id}`);
		return problems;
	});
}

const firstIndex = (items: any[], needle: string) => items.findIndex((item) => JSON.stringify(item.content ?? "").includes(needle));

type Setup = { model: any; openai?: Record<string, unknown>; hasUI?: boolean; sm?: any; loggedIn?: boolean; baseUrl?: string };

/** 在真实会话上装配扩展（配置文件里只有 openai 节）；返回会话、宿主钩子的调用入口与通知记录。 */
async function harness({ model, openai = { nativeCompaction: true }, hasUI = false, sm = undefined, loggedIn = true, baseUrl = undefined }: Setup) {
	const directory = mkdtempSync(join(tmpdir(), "firecode-openai-native-"));
	directories.push(directory);
	const { registerOpenAINative } = (await loadFirecodeModule("provider/openai-native/index.ts", {
		configJsonc: JSON.stringify({ openai }),
	})) as any;
	const fake = fakePi();
	registerOpenAINative(fake.pi);
	sm ??= SessionManager.inMemory(directory);
	const notices: [string, string][] = [];
	const ctx = (current = model) => ({
		cwd: directory,
		hasUI,
		model: current,
		getSystemPrompt: () => INSTRUCTIONS,
		// 与宿主注册表一致：鉴权由它解析，解析出的 baseUrl 覆盖模型地址；没登录时流以缺凭据报错结束。
		modelRegistry: {
			getApiKeyAndHeaders: async (m: any) => ({ ok: true, apiKey: loggedIn ? apiKeyFor(m) : undefined, baseUrl }),
			streamSimple: (m: any, context: unknown, options: object) =>
				streamSimple(baseUrl ? { ...m, baseUrl } : m, context, { ...options, apiKey: loggedIn ? apiKeyFor(m) : undefined }),
		},
		sessionManager: sm,
		ui: { notify: (message: string, level: string) => notices.push([level, message]), setStatus() {}, theme: { fg: (_: string, value: string) => value } },
	});
	return {
		sm,
		notices,
		/** 宿主的 /compact：以第 firstKept 条起保留；成功时按宿主做法把结果追加成压缩条目。 */
		async compact(firstKeptEntryId: string, options: { current?: any; customInstructions?: string; reason?: string } = {}) {
			const result = await fake.fire("session_before_compact", {
				branchEntries: sm.getBranch(),
				signal: new AbortController().signal,
				customInstructions: options.customInstructions,
				reason: options.reason ?? "manual",
				preparation: { firstKeptEntryId, tokensBefore: 4096 },
			}, ctx(options.current));
			if (result?.compaction) sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details);
			return result;
		},
		/** 宿主下一次请求：payload 是宿主自己的流按会话思考档（reasoning）构造的请求体，result 是扩展改写后的请求体（未改写为 undefined）。 */
		async request(extra: unknown[] = [], current = model, reasoning?: string) {
			const messages = sm.buildSessionContext().messages;
			const payload = await hostPayload(current, messages, reasoning);
			if (extra.length) payload.input.push(...extra);
			return { payload, messages, result: await fake.fire("before_provider_request", { payload }, ctx(current)) };
		},
	};
}

/** 把每次 fetch 的请求体记下来，依次回放给定的响应。 */
function stubFetch(...responses: Array<() => Response>) {
	const calls: { url: string; raw: string; body: any }[] = [];
	globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
		// Codex 的 SSE 请求体按宿主做法 zstd 压缩。
		const body = init?.body;
		const raw = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(Bun.zstdDecompressSync(body)) : "";
		calls.push({ url: String(url), raw, body: raw ? JSON.parse(raw) : undefined });
		return responses[Math.min(calls.length, responses.length) - 1]();
	}) as typeof fetch;
	return calls;
}
const compactionItem = (encrypted: string) => ({ id: `cmp_${encrypted}`, type: "compaction", encrypted_content: encrypted });
/** 压缩请求的真实响应（2026-10 实测）：流里先给出压缩项，随即因输出上限以 response.incomplete 结束。 */
const compacted = (encrypted: string) => () => {
	const item = compactionItem(encrypted);
	const events = [
		{ type: "response.output_item.done", item, output_index: 0 },
		{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item] } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};

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

const SHIM = "[OpenAI native compaction checkpoint]";

for (const { provider, id, folded } of MODELS) {
	const model = getModel(provider, id);

	test(`${provider}/${id}: /compact sends the host's history, the checkpoint is persisted, and replay equals the host body with options applied`, async () => {
		const h = await harness({ model, openai: { nativeCompaction: true, providers: { [provider]: { textVerbosity: "high", priority: true } } } });
		const kept = oldHistory(h.sm, model);
		const calls = stubFetch(compacted("enc-1"));
		const context = h.sm.buildSessionContext().messages;

		const result = await h.compact(kept, { customInstructions: "Keep the release notes." });

		const instructions = `${INSTRUCTIONS}\n\nAdditional user guidance for this manual /compact request:\nKeep the release notes.`;
		const hostRequest = await hostPayload(model, [system({ content: instructions }), ...context.slice(1)]);
		expect(calls).toHaveLength(1);
		// 服务端压缩参数而非 compaction_trigger 输入项：ChatGPT 订阅登录拒收后者。
		expect(calls[0].body.input).toEqual(hostRequest.input);
		expect(calls[0].body.context_management).toEqual([{ type: "compaction", compact_threshold: 1000 }]);
		expect(calls[0].body.instructions).toBe(hostRequest.instructions);
		expect([calls[0].body.instructions, ...calls[0].body.input.filter((item: any) => item.role === "developer").map((item: any) => item.content)]).toContain(instructions);
		expect(result.compaction).toMatchObject({ summary: SHIM, firstKeptEntryId: kept, tokensBefore: 4096 });
		const window = result.compaction.details.compactedWindow;
		// 保留窗口只留各轮用户消息与压缩项：工具往返和系统提示不进窗口（系统提示每次请求自带）。
		expect(window.at(-1)).toEqual(compactionItem("enc-1"));
		expect(window.slice(0, -1).filter((item: any) => item.role === "user").map((item: any) => item.content[0].text)).toEqual(["ancient question", "old question"]);
		expect(window.some((item: any) => item.type === "function_call")).toBe(false);
		expect(JSON.stringify(window)).not.toContain(INSTRUCTIONS);

		newTurns(h.sm, model);
		const { payload, result: rewritten } = await h.request();
		const leading = model.api === "openai-codex-responses" ? 0 : 1;
		expect(rewritten).toEqual({
			...payload,
			input: [...payload.input.slice(0, leading), ...window, ...payload.input.slice(firstIndex(payload.input, "new question"))],
			text: { ...payload.text, verbosity: "high" },
			service_tier: "priority",
		});
		// 不支持中途系统消息的模型：更新已折进首条提示，其后的输入里没有它。
		const replayed = JSON.stringify(rewritten.input.slice(leading));
		for (const dropped of ["ancient answer", "old answer", "Repository contents.", "compacted into the following summary"]) expect(replayed).not.toContain(dropped);
		expect(replayed.includes("NEW PLAN")).toBe(!folded);
		expect(replayed).toContain("Release notes say green.");
	});
}

test("tools added mid-conversation are replayed as the host sent them", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model, hasUI: true });
	const kept = oldHistory(h.sm, model);
	stubFetch(compacted("enc"));
	await h.compact(kept);
	h.sm.appendMessage(user("new question"));
	h.sm.appendMessage(system({ toolsAdded: [{ name: "tool_b", description: "b", parameters: { type: "object", properties: {} } }] }));
	h.sm.appendMessage(user("use the new tool"));

	const { payload, result } = await h.request();

	expect(h.notices).toEqual([]);
	expect(JSON.stringify(result.input)).toContain("enc");
	expect(JSON.stringify(result.input)).toContain("tool_b");
	expect(result.input.slice(-(payload.input.length - firstIndex(payload.input, "new question")))).toEqual(payload.input.slice(firstIndex(payload.input, "new question")));
});

test("a native compaction keeps replaying when assistant text carries no phase", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model, hasUI: true });
	const kept = oldHistory(h.sm, model);
	stubFetch(compacted("enc"));
	await h.compact(kept);
	h.sm.appendMessage(user("new question"));
	h.sm.appendMessage(assistant(model, [{ type: "text", text: "No phase here.", textSignature: JSON.stringify({ v: 1, id: "msg_nophase" }) }]));
	h.sm.appendMessage(user("follow up"));

	const { result } = await h.request();

	expect(h.notices).toEqual([]);
	expect(JSON.stringify(result.input)).toContain("enc");
	expect(JSON.stringify(result.input)).toContain("No phase here.");
});

test("on OpenAI GPT-6 with an API key and a thinking level, the host's thinking-level markers do not stop the replay", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model, hasUI: true });
	// 宿主为这类模型在每条回复上记下当时的思考档，之后的请求把它写成回复前的一条 configuration_update。
	const thought = (message: object) => ({ ...message, providerThinkingLevel: "high" });
	h.sm.appendMessage(system({ content: "Base prompt" }));
	h.sm.appendMessage(user("ancient question"));
	h.sm.appendMessage(thought(assistant(model, [answer("ancient answer", "msg_ancient")])));
	const kept = h.sm.appendMessage(user("old question"));
	h.sm.appendMessage(thought(assistant(model, [answer("Reading.", "msg_read", "commentary"), readCall("call_old")], "toolUse")));
	h.sm.appendMessage(toolResult("call_old|fc_call_old", "Repository contents."));
	h.sm.appendMessage(thought(assistant(model, [answer("old answer", "msg_old")])));
	stubFetch(compacted("enc"));
	const result = await h.compact(kept);
	h.sm.appendMessage(user("new question"));
	h.sm.appendMessage(thought(assistant(model, [answer("It is green.", "msg_green")])));
	h.sm.appendMessage(user("follow up"));

	const { payload, result: rewritten } = await h.request([], model, "high");

	const tail = firstIndex(payload.input, "new question");
	expect(payload.input.slice(0, tail).some((item: any) => item.type === "configuration_update")).toBe(true);
	expect(h.notices).toEqual([]);
	expect(rewritten.input).toEqual([payload.input[0], ...result.compaction.details.compactedWindow, ...payload.input.slice(tail)]);
});

const GRAMMAR_TOOL = {
	name: "codemode",
	description: "Run code",
	parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
	constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } },
};
const codeCall = (id: string) => ({ type: "toolCall", id: `${id}|ctc_${id}`, name: "codemode", arguments: { code: "1 + 1" } });

for (const { provider, id } of [MODELS[0], MODELS[1]]) {
	test(`${provider}/${id}: grammar-constrained tool calls are compacted and replayed`, async () => {
		const model = getModel(provider, id);
		const h = await harness({ model, hasUI: true });
		h.sm.appendMessage(system({ content: "Base prompt", toolsAdded: [GRAMMAR_TOOL] }));
		h.sm.appendMessage(user("ancient question"));
		const kept = h.sm.appendMessage(user("old question"));
		h.sm.appendMessage(assistant(model, [codeCall("call_old")], "toolUse"));
		h.sm.appendMessage(toolResult("call_old|ctc_call_old", "2"));
		h.sm.appendMessage(assistant(model, [answer("old answer", "msg_old")]));
		const calls = stubFetch(compacted("enc"));
		await h.compact(kept);
		h.sm.appendMessage(user("new question"));
		h.sm.appendMessage(assistant(model, [codeCall("call_new")], "toolUse"));
		h.sm.appendMessage(toolResult("call_new|ctc_call_new", "2"));
		h.sm.appendMessage(user("follow up"));

		const { result } = await h.request();

		expect(malformedIds(calls[0].body.input)).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(JSON.stringify(result.input)).toContain("enc");
		expect(result.input.some((item: any) => item.type === "custom_tool_call" && item.call_id === "call_new")).toBe(true);
	});
}

test("tool call ids from another provider reach the compaction request in a form the Responses API accepts", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model });
	h.sm.appendMessage(system({ content: "Base prompt" }));
	const kept = h.sm.appendMessage(user("old question"));
	const longId = `toolu_${"x".repeat(70)}.y`;
	h.sm.appendMessage(assistant({ provider: "anthropic", api: "anthropic-messages", id: "claude" }, [
		{ type: "toolCall", id: "toolu_01.weird:id", name: "read", arguments: { path: "a" } },
		{ type: "toolCall", id: longId, name: "read", arguments: { path: "b" } },
	], "toolUse"));
	h.sm.appendMessage(toolResult("toolu_01.weird:id", "A"));
	h.sm.appendMessage(toolResult(longId, "B"));
	const calls = stubFetch(compacted("enc"));

	await h.compact(kept);

	expect(calls[0].body.input.some((item: any) => item.type === "function_call")).toBe(true);
	expect(malformedIds(calls[0].body.input)).toEqual([]);
});

test("a kept window holding another provider's messages still replays", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model, hasUI: true });
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

	const { payload, result: rewritten } = await h.request();

	expect(calls).toHaveLength(1);
	// 别家的不透明推理不发往 OpenAI，可见文字照发。
	expect(calls[0].raw).not.toContain("xai-encrypted");
	expect(calls[0].raw).toContain("Reading the repository.");
	expect(h.notices).toEqual([]);
	expect(rewritten.input).toEqual([payload.input[0], ...result.compaction.details.compactedWindow, ...payload.input.slice(firstIndex(payload.input, "new question"))]);
	expect(JSON.stringify(rewritten.input)).not.toContain("Unsigned answer.");
});

test("repeated /compact reuses the latest stored window plus the live tail, and replay uses only the latest window", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = await harness({ model });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(compacted("enc-1"), compacted("enc-2"));
	await h.compact(kept);
	newTurns(h.sm, model);
	const tailStart = h.sm.getEntries().findIndex((entry: any) => entry.message?.content?.[0]?.text === "new question");
	const firstWindow = h.sm.getEntries().find((entry: any) => entry.type === "compaction").details.compactedWindow;

	await h.compact(h.sm.getEntries()[tailStart + 3].id);

	const input = calls[1].body.input;
	const windowStart = input.findIndex((item: any) => item.type === "compaction");
	// 系统提示之后依次是上次的窗口、压缩之后的对话；上次的窗口不重复前面的历史。
	expect(input.slice(windowStart - (firstWindow.length - 1), windowStart + 1)).toEqual(firstWindow);
	expect(calls[1].raw).toContain("Release notes say green.");
	expect(calls[1].raw).not.toContain("compacted into the following summary");
	expect(calls[1].raw).not.toContain("ancient answer");
	h.sm.appendMessage(user("after second"));
	const { result } = await h.request();
	const replayed = JSON.stringify(result.input);
	expect(replayed).toContain("enc-2");
	expect(replayed).not.toContain("enc-1");
	expect(replayed).toContain("after second");
});

test("a trailing provider-authored developer prompt keeps its place at the end of the replayed request", async () => {
	const model = getModel("openai", "gpt-6.1-sol");
	const h = await harness({ model });
	const kept = oldHistory(h.sm, model);
	stubFetch(compacted("enc"));
	await h.compact(kept);
	newTurns(h.sm, model);
	const hint = { role: "developer", content: [{ type: "input_text", text: "# Juice: 0 !important" }] };

	const { result } = await h.request([hint]);

	expect(result.input.at(-1)).toEqual(hint);
	expect(JSON.stringify(result.input)).toContain("enc");
});

// 原生压缩没有可用窗口时请求照宿主原样发出；旧历史不在上下文里，用户要知道，但同一次压缩只提醒一次。
test("switching away from the model that made a native compaction: requests go out as the host built them, with one warning", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = await harness({ model, hasUI: true });
	const calls = stubFetch(compacted("enc"));
	await h.compact(oldHistory(h.sm, model));
	h.sm.appendMessage(user("after native"));

	expect((await h.request([], getModel("openai", "gpt-5.5"))).result).toBeUndefined();
	expect((await h.request([], getModel("openai", "gpt-5.5"))).result).toBeUndefined();
	expect((await h.request([], getModels("anthropic")[0])).result).toBeUndefined();

	expect(h.notices).toEqual([["warning", expect.stringContaining("openai/gpt-5-mini")]]);
	expect(calls).toHaveLength(1);
});

test("/compact after switching away from a native compaction: manual is cancelled, automatic falls back to the host summary with a warning", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const other = getModel("openai", "gpt-5.5");
	const h = await harness({ model, hasUI: true });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(compacted("enc"));
	await h.compact(kept);
	h.notices.length = 0;

	expect(await h.compact(kept, { current: other })).toEqual({ cancel: true });
	expect(h.notices).toEqual([["error", expect.stringContaining("openai/gpt-5-mini")]]);

	h.notices.length = 0;
	expect(await h.compact(kept, { current: other, reason: "threshold" })).toBeUndefined();
	expect(h.notices).toEqual([["warning", expect.stringContaining("openai/gpt-5-mini")]]);
	expect(calls).toHaveLength(1);
});

test("without a native compaction nothing is sent or warned: legacy summaries, other providers, proxies, switch off", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const proxy = { ...model, provider: "custom-litellm", baseUrl: "https://proxy.example.com/v1" };
	const calls = stubFetch(compacted("enc"));

	const legacy = await harness({ model, hasUI: true });
	const legacyKept = oldHistory(legacy.sm, model);
	legacy.sm.appendCompaction("Legacy Pi summary", legacyKept, 100);
	legacy.sm.appendMessage(user("after legacy"));
	expect(await legacy.compact(legacyKept)).toBeUndefined();
	expect((await legacy.request()).result).toBeUndefined();
	expect(legacy.notices).toEqual([]);

	const other = await harness({ model, hasUI: true });
	const otherKept = oldHistory(other.sm, model);
	expect(await other.compact(otherKept, { current: getModels("anthropic")[0] })).toBeUndefined();
	expect(await other.compact(otherKept, { current: proxy })).toBeUndefined();

	const off = await harness({ model, openai: { nativeCompaction: false }, hasUI: true });
	expect(await off.compact(oldHistory(off.sm, model))).toBeUndefined();
	expect((await off.request()).result).toBeUndefined();
	expect(off.notices).toEqual([]);
	expect(calls).toHaveLength(0);
});

test("turning nativeCompaction off after a native compaction warns once that the old history is out of context", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const on = await harness({ model });
	stubFetch(compacted("enc"));
	await on.compact(oldHistory(on.sm, model));
	on.sm.appendMessage(user("after native"));

	const off = await harness({ model, openai: { nativeCompaction: false }, hasUI: true, sm: on.sm });

	expect((await off.request()).result).toBeUndefined();
	expect((await off.request()).result).toBeUndefined();
	expect(off.notices).toEqual([["warning", expect.stringContaining("openai.nativeCompaction")]]);
});

test("a manual /compact without login credentials is cancelled and says why", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = await harness({ model, hasUI: true, loggedIn: false });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(compacted("enc"));

	expect(await h.compact(kept)).toEqual({ cancel: true });

	expect(calls).toHaveLength(0);
	expect(h.notices).toEqual([["error", expect.stringContaining("/compact 已取消")]]);
});

test("the compaction request goes to the baseUrl the credentials resolve to", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const h = await harness({ model, baseUrl: "https://proxy.example/v1" });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(compacted("enc"));

	await h.compact(kept);

	expect(calls.map((call) => call.url)).toEqual(["https://proxy.example/v1/responses"]);
});

test.each([
	["the conversation is over the context window", () => new Response(
		`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Too long." } } })}\n\ndata: [DONE]\n`,
		{ status: 200 },
	), ["超出了模型的上下文窗口", "Too long."]],
	["the API rejects the request", () => Response.json({ error: { message: "Unsupported input item." } }, { status: 400 }),
		["接口拒绝了请求", "HTTP 400", "Unsupported input item."]],
	["the response fails for another reason", () => Response.json({ status: "failed", error: { code: "server_error", message: "The response failed." } }),
		["接口报告压缩失败", "server_error"]],
	["the response holds no compaction item", () => Response.json({ output: [{ type: "message", role: "assistant", content: [] }] }),
		["接口没有返回压缩结果"]],
])("when %s, a manual /compact is cancelled with the reason and an automatic compaction falls back to the summary with it", async (_name, response, phrases) => {
	const model = getModel("openai", "gpt-5-mini");
	const h = await harness({ model, hasUI: true });
	const kept = oldHistory(h.sm, model);
	const calls = stubFetch(response);

	expect(await h.compact(kept)).toEqual({ cancel: true });
	// 自动压缩不取消：取消的话每轮重试都失败，上下文满了连溢出补救也被取消，会话卡死。
	expect(await h.compact(kept, { reason: "threshold" })).toBeUndefined();

	expect(calls).toHaveLength(2);
	expect(h.notices.map(([level]) => level)).toEqual(["error", "warning"]);
	for (const phrase of phrases) for (const [, notice] of h.notices) expect(notice).toContain(phrase);
	expect(h.notices[0][1]).toContain("/compact 已取消");
	expect(h.notices[1][1]).toContain("普通摘要");
	expect(h.sm.getEntries().some((entry: any) => entry.type === "compaction")).toBe(false);
});

// verbosity 与 priority 作用于请求体：OpenAI Responses 带 verbosity，xAI 只带 priority，命令行参数覆盖配置。
test.each([
	["openai-codex Responses: configured verbosity and priority", getModel("openai-codex", "gpt-6.1-sol"), undefined, { text: { verbosity: "low" }, service_tier: "priority" }],
	["a command-line verbosity overrides the config", getModel("openai-codex", "gpt-6.1-sol"), "high", { text: { verbosity: "high" }, service_tier: "priority" }],
	["an invalid command-line verbosity drops only verbosity", getModel("openai-codex", "gpt-6.1-sol"), "invalid", { service_tier: "priority" }],
	["another Responses provider gets verbosity without priority", { ...getModel("openai", "gpt-5.5"), provider: "rc" }, undefined, { text: { verbosity: "high" } }],
	["xAI Completions gets priority without verbosity", { provider: "xai", api: "openai-completions", id: "grok-4.6" }, undefined, { service_tier: "priority" }],
])("%s", async (_name, model, flag, added) => {
	const settings = { nativeCompaction: true, providers: { "openai-codex": { textVerbosity: "low", priority: true }, rc: { textVerbosity: "high" }, xai: { priority: true } } };
	const h = await harness({ model, openai: settings });
	const fake = fakePi({ getFlag: () => flag });
	const { registerOpenAINative } = (await loadFirecodeModule("provider/openai-native/index.ts", { configJsonc: JSON.stringify({ openai: settings }) })) as any;
	registerOpenAINative(fake.pi);
	const payload = { model: model.id, input: [] };

	const rewritten = await fake.fire("before_provider_request", { payload }, {
		model,
		hasUI: false,
		sessionManager: h.sm,
	});

	expect(rewritten).toEqual({ ...payload, ...added });
});

