import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featuresOnly, loadFirecodeModule, PI_CODING_AGENT_URL } from "./loader.ts";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(PI_CODING_AGENT_URL) as any;
const savedFetch = globalThis.fetch;
const directories: string[] = [];
const sessions = new Set<any>();
const requests: any[] = [];
let failHelper = false;
let incompleteHelper = false;
let multipleCompactions = false;

afterEach(async () => {
	for (const session of sessions) await close(session);
	globalThis.fetch = savedFetch;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	requests.length = 0;
	failHelper = false;
	incompleteHelper = false;
	multipleCompactions = false;
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function append(session: any, role: string, text: string) {
	return session.sessionManager.appendMessage({
		role, content: role === "user" ? text : [{ type: "text", text }], timestamp: Date.now(),
		...(role === "assistant" ? { api: session.model.api, provider: session.model.provider, model: session.model.id, stopReason: "stop", usage } : {}),
	});
}

function service() {
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(Bun.zstdDecompressSync(init.body as Uint8Array)));
		requests.push(body);
		if (body.context_management && failHelper) throw new TypeError("fixture network outage");
		const id = `msg_${requests.length}`;
		const output = body.context_management
			? [{ type: "compaction", id: `cmp_${requests.length}`, encrypted_content: `window-${requests.length}` }]
			: [{ type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }];
		if (body.context_management && multipleCompactions) output.unshift({ type: "compaction", id: "cmp_superseded", encrypted_content: "superseded-window" });
		const incomplete = incompleteHelper && body.context_management;
		const response = {
			id: `resp_${requests.length}`, status: incomplete ? "incomplete" : "completed", output,
			...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
			usage: { input_tokens: 1200, output_tokens: 1, total_tokens: 1201 },
		};
		const events: any[] = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
		output.forEach((item, index) => {
			events.push({ type: "response.output_item.added", output_index: index, item: item.type === "message" ? { ...item, content: [] } : item });
			if (item.type === "message") {
				events.push({ type: "response.content_part.added", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
				events.push({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: 0, delta: "OK" });
			}
			events.push({ type: "response.output_item.done", output_index: index, item });
		});
		events.push({ type: incomplete ? "response.incomplete" : "response.completed", response });
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
}

async function fixture(provider = "openai", model = "gpt-6.1-terra") {
	const directory = mkdtempSync(join(tmpdir(), "firecode-native-e2e-"));
	directories.push(directory);
	const agentDir = join(directory, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 16384 }, retry: { enabled: false }, cacheWarming: "off" }));
	const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url");
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [provider]: provider === "openai-codex"
		? { type: "oauth", access: `header.${account}.signature`, refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }
		: { type: "api_key", key: "fixture-key" } }));
	service();
	return { directory, agentDir, provider, model };
}

async function open(f: Awaited<ReturnType<typeof fixture>>, path?: string, options: { native?: boolean; enabled?: boolean } = {}) {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly(...(options.enabled === false ? [] : ["openaiNative"])), openai: { nativeCompaction: options.native !== false, providers: { [f.provider]: { textVerbosity: "low", priority: true } } } }),
	}) as any;
	const settingsManager = SettingsManager.create(f.directory, f.agentDir, { projectTrusted: false });
	const compactEvents: any[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: f.directory, agentDir: f.agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		systemPrompt: "Keep the archive memory.",
		extensionFactories: [{ name: "native", factory: (pi: any) => {
			registerFirecode(pi);
			pi.on("session_compact", (event: any) => compactEvents.push(event.compactionEntry));
		} }],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const modelRuntime = await ModelRuntime.create({ authPath: join(f.agentDir, "auth.json"), modelsPath: join(f.agentDir, "models.json") });
	const model = modelRuntime.getModel(f.provider, f.model);
	const sessionManager = path ? SessionManager.open(path, f.directory, f.directory) : SessionManager.create(f.directory, f.directory);
	const { session } = await createAgentSession({ cwd: f.directory, agentDir: f.agentDir, resourceLoader, settingsManager, sessionManager, modelRuntime, model, tools: [] });
	sessions.add(session);
	await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(error.error); } });
	return { session, compactEvents };
}

async function close(session: any) {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	sessions.delete(session);
}

function seed(session: any) {
	append(session, "user", "Remember the following assistant archive.");
	append(session, "assistant", "Archive secret: LANTERN-5849. " + "Old history. ".repeat(400));
	append(session, "user", "Recent tail. " + "Keep recent. ".repeat(40));
	append(session, "assistant", "Ready.");
}

const wire = (request: any) => JSON.stringify(request.input);

test.each([["openai", "gpt-6.1-terra"], ["openai-codex", "gpt-6.1-sol"]])("%s: edits/deletions stay projected through compaction, reopen and a second checkpoint", async (provider, model) => {
	const f = await fixture(provider, model);
	let { session, compactEvents } = await open(f);
	seed(session);
	const erased = append(session, "user", "ERASE-317 " + "discarded. ".repeat(400));
	session.sessionManager.appendContextEdit(erased, null);
	const edited = append(session, "user", "STALE-218 " + "outdated. ".repeat(400));
	session.sessionManager.appendContextEdit(edited, { content: "EDITED-629 " + "corrected. ".repeat(400) });
	const retained = append(session, "user", "Retained question. " + "Recent. ".repeat(40));
	append(session, "assistant", "Ready.");
	const first = await session.compact();
	const firstHelper = requests.at(-1);
	expect(wire(firstHelper)).toContain("EDITED-629");
	expect(wire(firstHelper)).not.toContain("ERASE-317");
	expect(wire(firstHelper)).not.toContain("STALE-218");
	// 服务端窗口已覆盖前文，不再保留一套用户消息或本地 token 预算。
	expect(first.details.compactedWindow.map((item: any) => item.type)).toEqual(["compaction"]);
	expect(compactEvents.at(-1).id).toBe(session.sessionManager.getBranch().findLast((entry: any) => entry.type === "compaction").id);
	session.sessionManager.appendContextEdit(retained, { content: "TAIL-EDIT-731" });
	const path = session.sessionManager.getSessionFile();
	await close(session);
	({ session, compactEvents } = await open(f, path));
	await session.prompt("Continue.");
	expect(wire(requests.at(-1))).toContain("TAIL-EDIT-731");
	expect(wire(requests.at(-1))).toContain("window-1");
	expect(wire(requests.at(-1))).not.toContain("checkpoint");
	expect(requests.at(-1).text).toEqual({ verbosity: "low" });
	expect(requests.at(-1).service_tier).toBe("priority");
	append(session, "user", "Intermediate. " + "Padding. ".repeat(500));
	append(session, "assistant", "Intermediate answer.");
	const dropped = append(session, "user", "DELETE-AFTER-REOPEN " + "drop. ".repeat(500));
	session.sessionManager.appendContextEdit(dropped, null);
	const latestKept = append(session, "user", "Latest kept. " + "Recent. ".repeat(40));
	append(session, "assistant", "Ready.");
	multipleCompactions = true;
	const second = await session.compact();
	expect(JSON.stringify(second.details.compactedWindow)).not.toContain("superseded-window");
	expect(wire(requests.at(-1))).toContain("window-1");
	expect(wire(requests.at(-1))).toContain("TAIL-EDIT-731");
	expect(wire(requests.at(-1))).not.toContain("DELETE-AFTER-REOPEN");
	const latest = session.sessionManager.getBranch().findLast((entry: any) => entry.type === "compaction");
	expect(compactEvents.at(-1).id).toBe(latest.id);
	expect(second.summary).not.toBe(first.summary);
	session.sessionManager.appendContextEdit(latestKept, null);
	await close(session);
	({ session } = await open(f, path));
	await session.prompt("Continue after deletion.");
	const request = wire(requests.at(-1));
	expect(request).toContain(second.details.compactedWindow[0].encrypted_content);
	expect(request).not.toContain("Latest kept.");
	expect(request).not.toContain("checkpoint");
}, 20_000);

test("native failure after a checkpoint preserves history for manual and automatic retry", async () => {
	const f = await fixture();
	let { session } = await open(f);
	seed(session);
	const first = await session.compact();
	const path = session.sessionManager.getSessionFile();
	append(session, "user", "Pending history. " + "Padding. ".repeat(400));
	append(session, "assistant", "Ready.");
	failHelper = true;
	await expect(session.compact()).rejects.toThrow("cancelled");
	expect(session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
	session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 32, reserveTokens: session.model.contextWindow - 64 } });
	await session.prompt("Trigger automatic compaction.");
	expect(session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
	const helpers = requests.filter((request) => request.context_management);
	expect(helpers.length).toBeGreaterThan(2);
	expect(requests.every((request) => !wire(request).includes("checkpoint"))).toBe(true);
	failHelper = false;
	await close(session);
	({ session } = await open(f, path));
	await session.prompt("Recover after the network returns.");
	expect(wire(requests.at(-1))).toContain(first.details.compactedWindow[0].encrypted_content);
	expect(wire(requests.at(-1))).toContain("Pending history.");
	await session.compact();
	expect(session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(2);
}, 20_000);

test("a truncated native summary is rejected; a first automatic failure can still summarize the complete original text", async () => {
	const f = await fixture();
	const { session } = await open(f);
	seed(session);
	incompleteHelper = true;
	await expect(session.compact()).rejects.toThrow("cancelled");
	expect(session.sessionManager.getBranch().some((entry: any) => entry.type === "compaction")).toBe(false);
	session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 32, reserveTokens: session.model.contextWindow - 64 } });
	await session.prompt("Trigger compaction.");
	const ordinary = requests.find((request) => !request.context_management);
	expect(wire(ordinary)).toContain("LANTERN-5849");
	expect(wire(ordinary)).not.toContain("checkpoint");
	expect(session.sessionManager.getBranch().find((entry: any) => entry.type === "compaction")?.details?.strategy).not.toBe("openai-native-compact");
}, 20_000);

test.each(["model", "native", "feature", "old-format"])("%s cannot silently replace a native window with placeholder history", async (mode) => {
	const f = await fixture();
	let { session } = await open(f);
	seed(session);
	await session.compact();
	const path = session.sessionManager.getSessionFile();
	if (mode === "old-format") {
		const checkpoint = session.sessionManager.getBranch().findLast((entry: any) => entry.type === "compaction");
		session.sessionManager.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, 1000, { ...checkpoint.details, version: undefined });
	}
	await close(session);
	({ session } = await open(f, path, { native: mode !== "native", enabled: mode !== "feature" }));
	if (mode === "model") await session.setModel(session.modelRuntime.getModel("openai", "gpt-5-mini"));
	const before = requests.length;
	await session.prompt("Do not lose the archive.");
	expect(requests.length).toBe(before);
	expect(session.messages.findLast((message: any) => message.role === "assistant").stopReason).toBe("aborted");
	await expect(session.compact()).rejects.toThrow("cancelled");
	expect(requests.length).toBe(before);
}, 20_000);
