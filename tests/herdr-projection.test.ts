import { afterAll, afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.js";
import { fakePi } from "./fake-pi.ts";

type Module = {
	registerHerdrProjection: (pi: unknown, subsession?: boolean) => () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];
let cached: Module | undefined;

const load = async (): Promise<Module> =>
	(cached ??= (await loadFirecodeModule("session/herdr-projection.js")) as unknown as Module);

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
	cached = undefined;
	await cleanupFirecodeModules();
});

/** 假 herdr socket：记录请求；failures 让前 N 次请求回错误。 */
async function herdrStub(failures = 0) {
	const directory = await mkdtemp(join(tmpdir(), "firecode-herdr-"));
	const path = join(directory, "herdr.sock");
	const requests: Array<{ method: string; params: any }> = [];
	let failuresLeft = failures;
	const server = net.createServer((socket) => {
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
	return { path, requests };
}

async function register(socketPath: string, env: Record<string, string | undefined> = {}, subsession = false) {
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
	const settled = (await load()).registerHerdrProjection(fake.pi, subsession);
	return Object.assign(fake, { settled });
}

let idle = true;
const context = (name: string | undefined, { mode = "tui", file = "/sessions/a.jsonl" }: { mode?: string; file?: string | undefined } = {}) => ({
	mode,
	isIdle: () => idle,
	signal: undefined,
	sessionManager: { getSessionName: () => name, getSessionFile: () => file },
	model: { id: "anthropic/claude-opus-4-5-20260101", reasoning: true },
});

/** 上报序列的投影：state 报告记状态，其余记方法名。 */
const trace = (requests: Array<{ method: string; params: any }>) =>
	requests.map(({ method, params }) => (method === "pane.report_agent" ? params.state : method.replace("pane.", "")));

test("session_start 首报：先报状态与恢复命令，再报身份；不动持久 pane/tab 名", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("重命名"));
	await pi.fire("session_info_changed", {}, context("重命名"));
	await pi.settled();

	expect(trace(herdr.requests)).toEqual(["idle", "report_metadata"]);
	expect(herdr.requests[0].params).toMatchObject({
		pane_id: "w1:pA",
		source: "firecode",
		agent: "pi",
		state: "idle",
		resume_argv: ["pi", "--session", "/sessions/a.jsonl"],
	});
	expect(herdr.requests[1].params).toMatchObject({
		source: "firecode",
		display_agent: "pi·claude-opus-4-5/medium",
		title: "重命名",
		tokens: { session: "重命名" },
		clear_state_labels: true,
	});
	expect(herdr.requests[1].params.seq).toBeGreaterThan(herdr.requests[0].params.seq);
});

test("会话文件路径含撇号（herdr 会拒收）或没有会话文件时不附恢复命令", async () => {
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x", { file: "/Users/o'neil/a.jsonl" }));
	await pi.settled();
	expect(herdr.requests[0].params).not.toHaveProperty("resume_argv");
});

test("reload 时回合仍在跑：session_start 首报即 working", async () => {
	idle = false;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x"));
	await pi.settled();
	expect(trace(herdr.requests)).toEqual(["working", "report_metadata"]);
	// 回合落定后回到 idle。
	idle = true;
	await pi.fire("agent_settled", {}, context("x"));
	await pi.settled();
	expect(trace(herdr.requests)).toEqual(["working", "report_metadata", "idle"]);
});

test("主回合歇下后子代理仍在飞：保持 working，全部落定才 idle", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	const ctx = context("x");
	await pi.fire("session_start", {}, ctx);
	await pi.settled();
	herdr.requests.length = 0;

	idle = false;
	await pi.fire("agent_start", {}, ctx);
	pi.pi.events.emit("firecode:workers", { inFlight: 2 });
	await pi.settled();
	idle = true;
	await pi.fire("agent_settled", {}, ctx);
	await pi.settled();
	pi.pi.events.emit("firecode:workers", { inFlight: 1 });
	await pi.settled();
	// 主回合已歇下，仍有子代理在飞：不出现 idle 报告，侧边栏标签说明原因。
	expect(herdr.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state)).toEqual(["working"]);
	const labels = herdr.requests.filter((request) => request.method === "pane.report_metadata").map((request) => request.params.state_labels ?? null);
	expect(labels.at(-1)).toEqual({ working: "子代理进行中" });

	pi.pi.events.emit("firecode:workers", { inFlight: 0 });
	await pi.settled();
	expect(herdr.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state)).toEqual(["working", "idle"]);
	expect(herdr.requests.at(-1)!.params.clear_state_labels).toBe(true);
});

test("审查进行中报 working（不是 blocked：没有等用户决定），带审查标签；结束回 idle", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x"));
	await pi.settled();
	herdr.requests.length = 0;

	pi.pi.events.emit("firecode:review", { active: true, progress: () => undefined });
	await pi.settled();
	expect(herdr.requests.map((request) => request.method)).toEqual(["pane.report_agent", "pane.report_metadata"]);
	expect(herdr.requests[0].params.state).toBe("working");
	expect(herdr.requests[1].params.state_labels).toEqual({ working: "对抗审查进行中" });

	pi.pi.events.emit("firecode:review", { active: false });
	await pi.settled();
	expect(herdr.requests.slice(2).map((request) => request.params.state ?? "meta")).toEqual(["idle", "meta"]);
	expect(herdr.requests.some((request) => request.params.state === "blocked")).toBe(false);
});

test("上报在途时状态连续翻转：只送最新值", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	const ctx = context("x");
	const started = pi.fire("session_start", {}, ctx);
	idle = false;
	await pi.fire("agent_start", {}, ctx);
	idle = true;
	await pi.fire("agent_settled", {}, ctx);
	await pi.fire("agent_start", {}, ctx);
	await started;
	await pi.settled();
	const states = herdr.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state);
	expect(states.at(-1)).toBe("working");
	expect(states.length).toBeLessThanOrEqual(2);
});

test("身份：改名、换模型各自重报，同一身份不重发", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	for (const name of ["身份-A", "身份-B", "身份-B", "身份-A"]) {
		await pi.fire(name === "身份-A" && !herdr.requests.length ? "session_start" : "session_info_changed", {}, context(name));
		await pi.settled();
	}
	expect(herdr.requests.filter((request) => request.method === "pane.report_metadata").map((request) => request.params.title)).toEqual(["身份-A", "身份-B", "身份-A"]);
});

test("送达失败重试一次；其后的事件继续补发", async () => {
	idle = true;
	const herdr = await herdrStub(1);
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x"));
	await pi.settled();
	expect(trace(herdr.requests)).toEqual(["idle", "idle", "report_metadata"]);
});

test("连续两次送达失败后停手；下一个事件继续补发", async () => {
	idle = true;
	const herdr = await herdrStub(2);
	const pi = await register(herdr.path);
	const ctx = context("x");
	await pi.fire("session_start", {}, ctx);
	await pi.settled();
	expect(trace(herdr.requests)).toEqual(["idle", "idle"]);
	await pi.fire("session_info_changed", {}, context("改名"));
	await pi.settled();
	expect(trace(herdr.requests)).toEqual(["idle", "idle", "idle", "report_metadata"]);
});

test("quit 清身份并 release；reload/new/resume/fork 不 release", async () => {
	idle = true;
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x"));
	await pi.settled();
	await pi.fire("session_shutdown", { reason: "new" }, context("x"));
	expect(trace(herdr.requests)).toEqual(["idle", "report_metadata"]);
	herdr.requests.length = 0;

	const next = await register(herdr.path);
	await next.fire("session_start", {}, context("x"));
	await next.settled();
	herdr.requests.length = 0;
	await next.fire("session_shutdown", { reason: "quit" }, context("x"));
	expect(trace(herdr.requests)).toEqual(["report_metadata", "release_agent"]);
	expect(herdr.requests[0].params).toMatchObject({ clear_display_agent: true, clear_title: true, tokens: { session: null }, clear_state_labels: true });
	expect(herdr.requests[1].params).toMatchObject({ source: "firecode", agent: "pi" });
	expect(herdr.requests[1].params.seq).toBeGreaterThan(herdr.requests[0].params.seq);
});

test("非 TUI、Master 子会话、herdr 之外一律静默", async () => {
	const herdr = await herdrStub();
	const pi = await register(herdr.path);
	await pi.fire("session_start", {}, context("x", { mode: "print" }));
	pi.pi.events.emit("firecode:workers", { inFlight: 1 });
	await pi.fire("session_shutdown", { reason: "quit" }, context("x", { mode: "rpc" }));
	await pi.settled();
	expect(herdr.requests).toHaveLength(0);

	expect((await register(herdr.path, {}, true)).handlers.size).toBe(0);
	expect((await register(herdr.path, { HERDR_ENV: undefined })).handlers.size).toBe(0);
});
