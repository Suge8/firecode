import { afterAll, afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.js";

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

async function herdrStub() {
	const directory = await mkdtemp(join(tmpdir(), "firecode-herdr-"));
	const path = join(directory, "herdr.sock");
	const requests: Array<{ method: string; params: any }> = [];
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) {
				requests.push(JSON.parse(line));
			}
			socket.write(`${JSON.stringify({ result: { type: "ok" } })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return { path, requests };
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
		HERDR_TAB_ID: "w1:t1",
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

const context = (name: string | undefined) => ({
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

test("publishes once per distinct identity and clears only on quit", async () => {
	const herdr = await herdrStub();
	const handlers = await register(herdr.path);

	await handlers.get("session_start")?.({}, context("重命名"));
	await handlers.get("session_info_changed")?.({}, context("重命名"));
	await handlers.get("session_shutdown")?.({ reason: "new" }, context("重命名"));
	await handlers.get("session_shutdown")?.({ reason: "quit" }, context("重命名"));

	expect(herdr.requests.map((request) => request.method)).toEqual([
		"pane.report_metadata",
		"tab.rename",
		"pane.report_metadata",
		"tab.rename",
	]);
	expect(herdr.requests[0].params).toMatchObject({
		pane_id: "w1:pA",
		source: "firecode",
		display_agent: "pi·claude-opus-4-5/medium",
		title: "重命名",
		clear_title: false,
	});
	expect(herdr.requests[1].params).toEqual({ tab_id: "w1:t1", label: "重命名" });
	expect(herdr.requests[2].params).toMatchObject({
		clear_display_agent: true,
		clear_title: true,
	});
	expect(herdr.requests[2].params.seq).toBeGreaterThan(herdr.requests[0].params.seq);
	expect(herdr.requests[3].params).toEqual({ tab_id: "w1:t1", label: "" });
});

test("stays silent inside Master Workers and outside herdr", async () => {
	const herdr = await herdrStub();
	expect((await register(herdr.path, { FIRECODE_MASTER_WORKER: "1" })).size).toBe(0);
	expect((await register(herdr.path, { HERDR_ENV: undefined })).size).toBe(0);
	expect(herdr.requests).toHaveLength(0);
});
