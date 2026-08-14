import { afterAll, afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.js";

const SOURCE_LABEL = "firecode";

type Handler = (event: any, ctx: any) => unknown;
type Module = {
	projectSlots: (name?: string, model?: string, thinking?: string) => unknown;
	registerHerdrDisplay: (pi: unknown) => void;
};

const cleanups: Array<() => Promise<void>> = [];
let cached: Module | undefined;

const load = async (): Promise<Module> =>
	(cached ??= (await loadFirecodeModule("session/herdr-display.js")) as unknown as Module);

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

afterAll(async () => {
	cached = undefined;
	await cleanupFirecodeModules();
});

/** 假 herdr：按 method 回放响应，`paneCount` 控制 tab 是否被本 pane 独占。 */
async function herdrStub(options: { paneCount?: number; failFirst?: boolean } = {}) {
	const state = { paneCount: options.paneCount ?? 1 };
	const directory = await mkdtemp(join(tmpdir(), "firecode-herdr-"));
	const path = join(directory, "herdr.sock");
	const requests: Array<{ method: string; params: any }> = [];
	let failuresLeft = options.failFirst ? 1 : 0;
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) {
				const request = JSON.parse(line);
				requests.push(request);
				if (failuresLeft > 0) {
					failuresLeft -= 1;
					socket.write(`${JSON.stringify({ error: { code: "busy" } })}\n`);
					continue;
				}
				socket.write(`${JSON.stringify({ result: reply(request.method, state) })}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return { path, requests, state, methods: () => requests.map((request) => request.method) };
}

function reply(method: string, state: { paneCount: number }): Record<string, unknown> {
	if (method === "pane.get") return { pane: { tab_id: "w1:t1" } };
	if (method === "tab.get") return { tab: { pane_count: state.paneCount } };
	return { type: "ok" };
}

async function register(socketPath: string, env: Record<string, string | undefined> = {}) {
	const handlers = new Map<string, Handler>();
	const previous = { ...process.env };
	cleanups.push(async () => {
		process.env = previous;
	});
	Object.assign(process.env, {
		HERDR_ENV: "1",
		HERDR_PANE_ID: "w1:pA",
		HERDR_SOCKET_PATH: socketPath,
		FIRECODE_MASTER_WORKER: undefined,
		...env,
	});
	(await load()).registerHerdrDisplay({
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel: () => "medium",
	} as never);
	return handlers;
}

const context = (name: string | undefined, mode = "tui") => ({
	mode,
	sessionManager: { getSessionName: () => name },
	model: { id: "anthropic/claude-opus-4-5-20260101", reasoning: true },
});

test("projects session name to tab and model identity to the agent subtitle", async () => {
	const { projectSlots } = await load();
	expect(projectSlots("重命名", "anthropic/claude-opus-4-5", "medium")).toEqual({
		tab: "重命名",
		agent: "pi·claude-opus-4-5/medium",
	});
	expect(projectSlots(undefined, "openai/gpt-5", undefined)).toEqual({
		tab: "",
		agent: "pi·gpt-5",
	});
});

test("renames the tab only when this pane owns it and the session has a name", async () => {
	const herdr = await herdrStub();
	const handlers = await register(herdr.path);

	await handlers.get("session_start")?.({}, context("重命名"));
	await handlers.get("session_info_changed")?.({}, context("重命名"));

	expect(herdr.methods()).toEqual(["pane.report_metadata", "pane.get", "tab.get", "tab.rename"]);
	expect(herdr.requests[0].params).toMatchObject({
		pane_id: "w1:pA",
		source: SOURCE_LABEL,
		display_agent: "pi·claude-opus-4-5/medium",
		title: "重命名",
		clear_title: false,
	});
	expect(herdr.requests[3].params).toEqual({ tab_id: "w1:t1", label: "重命名" });
});

test("never writes an empty tab label: unnamed sessions and quit only clear the subtitle", async () => {
	const herdr = await herdrStub();
	const handlers = await register(herdr.path);

	await handlers.get("session_start")?.({}, context(undefined));
	await handlers.get("session_shutdown")?.({ reason: "new" }, context("重命名"));
	await handlers.get("session_shutdown")?.({ reason: "quit" }, context("重命名"));

	expect(herdr.methods()).toEqual(["pane.report_metadata", "pane.report_metadata"]);
	expect(herdr.requests[0].params).toMatchObject({
		clear_display_agent: false,
		clear_title: true,
	});
	expect(herdr.requests[1].params).toMatchObject({
		clear_display_agent: true,
		clear_title: true,
	});
	expect(herdr.requests[1].params.seq).toBeGreaterThan(herdr.requests[0].params.seq);
});

test("leaves shared tabs alone and retries after a failed delivery", async () => {
	const shared = await herdrStub({ paneCount: 2 });
	const sharedHandlers = await register(shared.path);
	await sharedHandlers.get("session_start")?.({}, context("重命名"));
	expect(shared.methods()).toEqual(["pane.report_metadata", "pane.get", "tab.get"]);
	// 共享 tab 未完成投影，退回独占后下一个事件必须补写同一个身份。
	shared.state.paneCount = 1;
	await sharedHandlers.get("model_select")?.({}, context("重命名"));
	expect(shared.methods().at(-1)).toBe("tab.rename");

	const flaky = await herdrStub({ failFirst: true });
	const handlers = await register(flaky.path);
	await handlers.get("session_start")?.({}, context("重命名"));
	await handlers.get("session_info_changed")?.({}, context("重命名"));
	expect(flaky.methods()).toEqual([
		"pane.report_metadata",
		"pane.report_metadata",
		"pane.get",
		"tab.get",
		"tab.rename",
	]);
});

test("stays silent outside TUI, inside Master Workers and outside herdr", async () => {
	const herdr = await herdrStub();
	const handlers = await register(herdr.path);
	await handlers.get("session_start")?.({}, context("重命名", "print"));
	await handlers.get("session_shutdown")?.({ reason: "quit" }, context("重命名", "rpc"));
	expect(herdr.requests).toHaveLength(0);

	expect((await register(herdr.path, { FIRECODE_MASTER_WORKER: "1" })).size).toBe(0);
	expect((await register(herdr.path, { HERDR_ENV: undefined })).size).toBe(0);
	expect(herdr.requests).toHaveLength(0);
});
