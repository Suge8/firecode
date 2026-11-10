import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featuresOnly, loadFirecodeModule } from "./loader.js";
import { fakePi } from "./fake-pi.ts";
import { until } from "./until.ts";

type Module = {
	registerHerdrProjection: (pi: unknown) => void;
};

const cleanups: Array<() => Promise<void>> = [];
let cached: Module | undefined;

const load = async (): Promise<Module> =>
	(cached ??= (await loadFirecodeModule("session/herdr-projection.js")) as unknown as Module);

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假 herdr socket：记录请求与已关闭的连接；failures 让前 N 次请求回错误。 */
async function herdrStub(failures = 0) {
	const directory = await mkdtemp(join(tmpdir(), "firecode-herdr-"));
	const path = join(directory, "herdr.sock");
	const requests: Array<{ method: string; params: any }> = [];
	const stub = { path, requests, closed: 0 };
	let failuresLeft = failures;
	const server = net.createServer((socket) => {
		socket.on("close", () => { stub.closed++; });
		socket.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) {
				const request = JSON.parse(line);
				requests.push(request);
				const reply = failuresLeft-- > 0 ? { error: { code: "busy" } } : { result: { type: "ok" } };
				socket.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return stub;
}

/** 至少收到 count 个请求且每个连接都已由客户端关闭：发送循环已处理完全部应答。 */
const drained = (herdr: Awaited<ReturnType<typeof herdrStub>>, count: number) =>
	until(() => herdr.requests.length >= count && herdr.closed === herdr.requests.length);

async function register(socketPath: string, env: Record<string, string | undefined> = {}) {
	const previous = { ...process.env };
	cleanups.push(async () => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	});
	for (const [key, value] of Object.entries({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:pA", HERDR_SOCKET_PATH: socketPath, ...env })) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const fake = fakePi({ getThinkingLevel: () => "medium" });
	(await load()).registerHerdrProjection(fake.pi);
	return fake;
}

let idle = true;
const context = (
	name: string | undefined,
	{ mode = "tui", file = "/sessions/a.jsonl", model = "anthropic/claude-opus-4-5-20260101" }: { mode?: string; file?: string | null; model?: string } = {},
) => ({
	mode,
	isIdle: () => idle,
	signal: undefined,
	sessionManager: { getSessionName: () => name, getSessionFile: () => file ?? undefined },
	model: { id: model, reasoning: true },
});

/** 上报序列的投影：state 报告记状态，其余记方法名。 */
const trace = (requests: Array<{ method: string; params: any }>) =>
	requests.map(({ method, params }) => (method === "pane.report_agent" ? params.state : method.replace("pane.", "")));

test("session_start 首报：先报状态与恢复命令，再报身份", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("重命名"));
	await drained(herdr, 2);

	expect(trace(herdr.requests)).toEqual(["idle", "report_metadata"]);
	expect(herdr.requests[0].params).toMatchObject({
		pane_id: "w1:pA",
		source: "firecode",
		agent: "pi",
		state: "idle",
		resume_argv: ["pi", "--session", "/sessions/a.jsonl"],
	});
	expect(herdr.requests[1].params).toMatchObject({ source: "firecode", title: "重命名" });
});

test("主回合歇下后子代理或审查仍在进行：保持 working，全部落定才 idle", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	const ctx = context("x");
	await pi.fire("session_start", {}, ctx);
	await drained(herdr, 2);

	idle = false;
	await pi.fire("agent_start", {}, ctx);
	pi.pi.events.emit("firecode:workers", { inFlight: 2 });
	pi.pi.events.emit("firecode:review", { active: true, progress: () => undefined });
	await drained(herdr, 3);
	idle = true;
	await pi.fire("agent_settled", {}, ctx);
	pi.pi.events.emit("firecode:workers", { inFlight: 1 });
	await drained(herdr, 4);
	expect(trace(herdr.requests)).not.toContain("blocked");
	expect(trace(herdr.requests).filter((state) => state === "idle")).toHaveLength(1);

	pi.pi.events.emit("firecode:workers", { inFlight: 0 });
	pi.pi.events.emit("firecode:review", { active: false });
	await until(() => trace(herdr.requests).filter((state) => state === "idle").length === 2 && herdr.closed === herdr.requests.length);
	expect(trace(herdr.requests).filter((state) => state === "idle")).toHaveLength(2);
});

test("quit 清身份并 release；new 不 release", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x"));
	await drained(herdr, 2);
	await pi.fire("session_shutdown", { reason: "new" }, context("x"));

	const next = await register(herdr.path);
	await next.fire("session_start", {}, context("x"));
	await drained(herdr, 4);
	await next.fire("session_shutdown", { reason: "quit" }, context("x"));
	await drained(herdr, 6);
	expect(trace(herdr.requests)).toEqual(["idle", "report_metadata", "idle", "report_metadata", "report_metadata", "release_agent"]);
	expect(herdr.requests[5].params).toMatchObject({ source: "firecode", agent: "pi" });
});

test("herdr 之外、非 TUI 一律静默", async () => {
	const herdr = await herdrStub();
	const outside = await register(herdr.path, { HERDR_ENV: undefined });
	await outside.fire("session_start", {}, context("x"));
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x", { mode: "print" }));
	pi.pi.events.emit("firecode:workers", { inFlight: 1 });
	await pi.fire("session_shutdown", { reason: "quit" }, context("x", { mode: "rpc" }));
	// 之后才启动的 TUI 会话首报：前面若漏出过请求，序列就不止这两条。
	idle = true;
	const tui = await register(herdr.path);
	await tui.fire("session_start", {}, context("x"));
	await drained(herdr, 2);
	expect(trace(herdr.requests)).toEqual(["idle", "report_metadata"]);
});

test("子会话不接管 pane：同一 herdr 环境下主会话投影，子会话不发任何请求", async () => {
	const herdr = await herdrStub();
	await register(herdr.path);
	const { registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: JSON.stringify({ features: await featuresOnly() }) }) as any;
	const start = async (subsession: boolean, file: string) => {
		const fake = fakePi({ registerProvider() {}, getThinkingLevel: () => "medium" });
		registerFirecode(fake.pi, subsession);
		const base = context("x", { file });
		await fake.fire("session_start", {}, { ...base, cwd: "/tmp", hasUI: true, ui: new Proxy({}, { get: () => () => {} }), sessionManager: { ...base.sessionManager, getBranch: () => [], getEntries: () => [], getSessionId: () => "s" } });
	};
	await start(true, "/sessions/sub.jsonl");
	await start(false, "/sessions/main.jsonl");
	// 主会话的请求一到，同一时间窗里子会话若会发请求也早已到了。
	await until(() => herdr.requests.some((request) => request.params.resume_argv));
	expect(herdr.requests.map((request) => request.params.resume_argv?.[2]).filter(Boolean)).toEqual(["/sessions/main.jsonl"]);
});
