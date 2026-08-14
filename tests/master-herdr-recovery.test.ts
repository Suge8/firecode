import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrWorkers } from "../master/herdr.js";
import { MasterStore, type WorkerRef } from "../master/state.js";

const savedShell = process.env.SHELL;
const statePaths: string[] = [];
afterEach(async () => {
	if (savedShell === undefined) delete process.env.SHELL;
	else process.env.SHELL = savedShell;
	for (const path of statePaths.splice(0)) await rm(path, { force: true });
});

function createStore(): MasterStore {
	const path = join(tmpdir(), `firecode-master-test-${crypto.randomUUID()}.json`);
	statePaths.push(path);
	return new MasterStore(path);
}

function worker(status: WorkerRef["status"] = "working"): WorkerRef {
	return {
		name: "worker-1",
		paneId: "w1:p2",
		tabId: "w1:t2",
		sessionPath: "/tmp/worker.jsonl",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "medium",
		status,
	};
}

function response(value: unknown) {
	return { code: 0, stdout: JSON.stringify(value), stderr: "", killed: false };
}

function missingAgent() {
	return {
		code: 1,
		stdout: "",
		stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
		killed: false,
	};
}

test("a missing live process becomes a resumable Dormant Worker", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async () => missingAgent() } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (content) => notices.push(content),
	});
	await pool.resume();
	expect(store.state.workers[0]).toMatchObject({
		name: "worker-1",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	});
	expect(notices.join()).toContain("进程已不存在");
});

test("recovery cleans a missing split startup without closing its shared tab", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		...worker("starting"),
		name: "worker-2",
		paneId: "w1:p3",
		sessionPath: undefined,
	} });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			if (args[0] === "tab" && args[1] === "list") return response({ result: { tabs: [] } });
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	expect(calls).toContainEqual(["pane", "close", "w1:p3"]);
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(false);
	expect(store.state.workers.map((item) => item.name)).toEqual(["worker-1"]);
});

test("a live working Worker keeps being watched after reload", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args);
				if (args[0] === "agent" && args[1] === "get") return liveAgent();
				if (args[0] === "agent" && args[1] === "wait")
					return new Promise((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }),
					);
				return response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	expect(store.state.workers[0]?.status).toBe("working");
	expect(calls.some((args) => args[0] === "agent" && args[1] === "wait")).toBe(true);
	pool.shutdown();
});

test("start can resume a Dormant Worker with its exact Pi session", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: {
			name: "worker-1",
			model: "openai-codex/gpt-5.6-sol",
			thinking: "high",
			status: "dormant",
			sessionPath: "/tmp/worker.jsonl",
		},
	});
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "create")
					return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
				if (args[0] === "pane" && args[1] === "wait-output") return response({});
				if (args[0] === "agent" && args[1] === "start") return liveAgent();
				if (args[0] === "agent" && args[1] === "prompt")
					return new Promise((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }),
					);
				return response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "xai", id: "grok" }, thinkingLevel: "low" } as never, {
		prompt: "继续检查",
		session: "worker-1",
	});
	const start = calls.find((args) => args[0] === "agent" && args[1] === "start") ?? [];
	expect(start.slice(start.indexOf("--session"), start.indexOf("--session") + 2)).toEqual([
		"--session",
		"/tmp/worker.jsonl",
	]);
	// Worker 用 pi 默认工具集（ADR-0004），不再传 --tools 白名单。
	expect(start).not.toContain("--tools");
	expect(calls.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
	expect(store.state.workers[0]).toMatchObject({ status: "working", thinking: "high" });
	pool.shutdown();
});

test("new Workers fill the current tab to four panes before opening another", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const calls: string[][] = [];
	const paneTabs = new Map<string, string>();
	let tabSerial = 0;
	let paneSerial = 0;
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create") {
				const tabId = `w1:t${++tabSerial}`;
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, tabId);
				return response({ result: { root_pane: { pane_id: paneId }, tab: { tab_id: tabId } } });
			}
			if (args[0] === "pane" && args[1] === "split") {
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, paneTabs.get(args[2] as string) as string);
				return response({ result: { pane: { pane_id: paneId } } });
			}
			if (args[0] === "pane" && (args[1] === "wait-output" || args[1] === "close")) return response({});
			if (args[0] === "agent" && args[1] === "start") {
				const paneId = args[args.indexOf("--pane") + 1] as string;
				const name = args[2] as string;
				return agentResponse(paneId, paneTabs.get(paneId) as string, `/tmp/${name}.jsonl`);
			}
			if (args[0] === "agent" && args[1] === "get") {
				const paneId = args[2] as string;
				const item = store.state.workers.find((candidate) => candidate.paneId === paneId);
				return agentResponse(paneId, paneTabs.get(paneId) as string, item?.sessionPath ?? "");
			}
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	for (let serial = 1; serial <= 5; serial += 1)
		await pool.start(ctx, { name: `worker-${serial}`, prompt: "做" });
	await pool.stop("worker-2", true);
	await pool.start(ctx, { name: "worker-6", prompt: "做" });

	const layout = calls.filter((args) =>
		(args[0] === "tab" && args[1] === "create") || (args[0] === "pane" && args[1] === "split")
	);
	// 2×2 象限：右切 p1、下切 p1、下切 p2；嵌套同向切会把后来者挤成 1/8 宽。
	expect(layout.map((args) => [
		...args.slice(0, 3),
		args.includes("--direction") ? args[args.indexOf("--direction") + 1] : "",
	])).toEqual([
		["tab", "create", "--workspace", ""],
		["pane", "split", "w1:p1", "right"],
		["pane", "split", "w1:p1", "down"],
		["pane", "split", "w1:p2", "down"],
		["tab", "create", "--workspace", ""],
		["pane", "split", "w1:p5", "right"],
	]);
	expect(layout[0]?.slice(0, 9)).toEqual([
		"tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "worker-1-m", "--env",
	]);
	// pane/tab/Pi 统一显示名：任务名-模型名；两种 shell 形态的 pane 都要命名。
	expect(calls).toContainEqual(["pane", "rename", "w1:p1", "worker-1-m"]);
	expect(calls).toContainEqual(["pane", "rename", "w1:p2", "worker-2-m"]);
	// agent 名同样携带模型（Herdr 字符集内）；Pi 名为完整显示名加 ↳ 前缀。
	const start = calls.find((args) => args[0] === "agent" && args[1] === "start" && args[2] === "worker-1-m");
	expect(start?.slice(start.indexOf("--name"), start.indexOf("--name") + 2)).toEqual(["--name", "↳worker-1-m"]);
	expect(layout[1]?.slice(0, 8)).toEqual([
		"pane", "split", "w1:p1", "--direction", "right", "--cwd", "/tmp", "--env",
	]);
	expect(layout[1]?.at(-1)).toBe("--no-focus");
	expect(calls).toContainEqual(["pane", "close", "w1:p2"]);
	pool.shutdown();
});

test("a failed split falls back to a new tab", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "split")
				return { code: 1, stdout: "", stderr: "split unavailable", killed: false };
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p3" }, tab: { tab_id: "w1:t3" } } });
			if (args[0] === "pane" && args[1] === "wait-output") return response({});
			if (args[0] === "agent" && args[1] === "start") return agentResponse("w1:p3", "w1:t3", "/tmp/worker-2.jsonl");
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "worker-2",
		prompt: "做",
	});
	expect(calls.filter((args) =>
		(args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create")
	).map((args) => args.slice(0, 2))).toEqual([["pane", "split"], ["tab", "create"]]);
	expect(store.state.workers.find((item) => item.name === "worker-2")).toMatchObject({ status: "working", tabId: "w1:t3" });
	pool.shutdown();
});

test("startup failure closes only the shell shape it created", async () => {
	process.env.SHELL = "/bin/zsh";
	for (const shape of ["tab", "pane"] as const) {
		const store = createStore();
		if (shape === "pane") store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
		const calls: string[][] = [];
		const pool = new HerdrWorkers({
			pi: { exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "create")
					return response({ result: { root_pane: { pane_id: "w1:p3" }, tab: { tab_id: "w1:t3" } } });
				if (args[0] === "pane" && args[1] === "split") return response({ result: { pane: { pane_id: "w1:p3" } } });
				if (args[0] === "pane" && args[1] === "wait-output") return response({});
				if (args[0] === "agent" && args[1] === "start")
					return { code: 1, stdout: "", stderr: "start failed", killed: false };
				return response({});
			} } as never,
			store,
			workspaceId: "w1",
			notifyMaster() {},
		});
		await expect(pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
			name: "worker-2",
			prompt: "做",
		})).rejects.toThrow("start failed");
		expect(calls).toContainEqual(shape === "pane"
			? ["pane", "close", "w1:p3"]
			: ["tab", "close", "w1:t3"]);
		expect(calls.some((args) => args[0] === (shape === "pane" ? "tab" : "pane") && args[1] === "close")).toBe(false);
	}
});

test("resuming under a new name replaces the old Dormant identity", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	} });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "tab") return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
			if (args[0] === "pane") return response({});
			if (args[0] === "agent" && args[1] === "start") return liveAgent();
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "renamed-worker",
		prompt: "继续",
		session: "worker-1",
	});
	expect(store.state.workers.map((item) => item.name)).toEqual(["renamed-worker"]);
	pool.shutdown();
});

test("a failed renamed resume restores only the original Dormant identity", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	} });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "tab") return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
			if (args[0] === "pane") return response({});
			if (args[0] === "agent" && args[1] === "start") return { code: 1, stdout: "", stderr: "start failed", killed: false };
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await expect(pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "renamed-worker",
		prompt: "继续",
		session: "worker-1",
	})).rejects.toThrow("start failed");
	expect(store.state.workers).toEqual([{
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	}]);
});

test("review submits only the literal command and waits past blocked states", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const fixture = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, '{"type":"session","version":3,"id":"worker"}\n');
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	const calls: string[][] = [];
	let releaseWait!: () => void;
	const wait = new Promise<ReturnType<typeof liveAgent>>((resolve) => {
		releaseWait = () => resolve(liveAgent("done", sessionPath));
	});
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "prompt") return response({});
			if (args[0] === "agent" && args[1] === "wait") return wait;
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	expect(store.state.workers[0]?.status).toBe("reviewing");
	expect(calls.slice(0, 2)).toEqual([
		["agent", "prompt", "w1:p2", "/fire-review", "--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"],
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
	]);
	await expect(pool.send("worker-1", "顺便改一下")).rejects.toThrow("正在对抗审查，期间不能接收追问");
	await writeFile(sessionPath, `${fixture}${JSON.stringify({
		id: "assistant-1",
		message: { role: "assistant", content: [{ type: "text", text: "实现完成" }], stopReason: "stop" },
	})}\n`);
	releaseWait();
	expect(await notice).toContain("判定：通过");
	expect(await notice).toContain("最终回复：\n实现完成");
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("a settled checkpoint from an older run cannot pass a review that never started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-stale-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const fixture = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, fixture);
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	expect(await notice).toContain("审查未启动");
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("a stalled prompt still tracks a review that started without the occupancy signal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-stall-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const inProgress = await readFile(join(import.meta.dir, "fixtures/review-outcomes/in-progress.jsonl"), "utf8");
	const passed = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, '{"type":"session","version":3,"id":"worker"}\n');
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	let waits = 0;
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				// 占用信号失效：审查已启动（checkpoint 落盘）但状态全程无变化，prompt --wait 报 stalled。
				await writeFile(sessionPath, inProgress);
				return { code: 1, stdout: "", stderr: "agent_prompt_stalled", killed: false };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				waits += 1;
				if (waits === 2) {
					await writeFile(sessionPath, `${passed}${JSON.stringify({
						id: "assistant-1",
						message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" },
					})}\n`);
					return liveAgent("done", sessionPath);
				}
				return liveAgent("idle", sessionPath);
			}
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	// stall 回退：runId 已推进，必须进入 reviewing 而不是误报审查未启动。
	expect(store.state.workers[0]?.status).toBe("reviewing");
	// 第一次 wait 观测到 idle 但 outcome 仍是 in_progress：不结算，退避后重挂直到终态。
	const text = await notice;
	expect(text).toContain("判定：通过");
	expect(waits).toBe(2);
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
}, 15_000);

test("review initiation failure leaves the idle Worker available", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async () => ({ code: 1, stdout: "", stderr: "prompt rejected", killed: false }) } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => notices.push(notice),
	});
	await expect(pool.review("worker-1")).rejects.toThrow("prompt rejected");
	expect(store.state.workers[0]?.status).toBe("idle");
	expect(notices).toEqual([]);
});

test("reload restores filtered review listening and reports connection failure", async () => {
	const fixture = join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("reviewing"), sessionPath: fixture } });
	const calls: string[][] = [];
	let waitCalls = 0;
	let resolveResult!: (value: string) => void;
	const result = new Promise<string>((resolve) => { resolveResult = resolve; });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, fixture);
			if (args[0] === "agent" && args[1] === "wait") {
				waitCalls += 1;
				return waitCalls === 1
					? { code: 1, stdout: "", stderr: "connection lost", killed: false }
					: liveAgent("idle", fixture);
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => {
			notices.push(notice);
			if (notice.includes("审查结束")) resolveResult(notice);
		},
	});
	await pool.resume();
	expect(await result).toContain("判定：通过");
	expect(notices[0]).toContain("审查监听失败，正在恢复");
	expect(calls.filter((args) => args[0] === "agent" && args[1] === "wait")).toEqual([
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
	]);
	expect(store.state.workers[0]?.status).toBe("idle");
});

test("reload retains the review run snapshot and rejects an unchanged old terminal", async () => {
	const fixture = join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl");
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: {
			...worker("reviewing"),
			sessionPath: fixture,
			reviewPreviousRunId: "passed-run",
		},
	});
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, fixture);
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", fixture);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("审查未启动");
	expect(store.state.workers[0]?.reviewPreviousRunId).toBeUndefined();
});

test("a blocked Worker remains blocked and asks the Master for input", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait")
				return liveAgent("blocked", "/tmp/worker.jsonl", { "herdr:pi": "Allow edit to protected file?" });
			if (args[0] === "agent" && args[1] === "get") return liveAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("Allow edit to protected file?");
	expect(store.state.workers[0]?.status).toBe("blocked");
});

test("non-success assistant stops are returned as failures", async () => {
	for (const sample of [
		{ stopReason: "error", errorMessage: "429 quota exhausted", expected: "429 quota exhausted" },
		{ stopReason: "aborted", text: "partial", expected: "执行失败" },
		{ stopReason: "length", text: "truncated", expected: "停止原因：length" },
	]) {
		const directory = await mkdtemp(join(tmpdir(), "firecode-worker-failure-"));
		const sessionPath = join(directory, "worker.jsonl");
		await writeFile(sessionPath, JSON.stringify({
			type: "message",
			id: "a1",
			parentId: null,
			message: {
				role: "assistant",
				content: sample.text ? [{ type: "text", text: sample.text }] : [],
				stopReason: sample.stopReason,
				...(sample.errorMessage ? { errorMessage: sample.errorMessage } : {}),
			},
		}) + "\n");
		const store = createStore();
		store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
		let resolveNotice!: (value: string) => void;
		const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
		const pool = new HerdrWorkers({
			pi: { exec: async (_command: string, args: string[]) => {
				if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
				if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
				return response({});
			} } as never,
			store,
			workspaceId: "w1",
			notifyMaster: resolveNotice,
		});
		await pool.resume();
		expect(await notice).toContain(sample.expected);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failed Herdr wait reattaches and still returns the result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-reattach-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	let waitCalls = 0;
	let resolveResult!: (value: string) => void;
	const result = new Promise<string>((resolve) => { resolveResult = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "wait") {
				waitCalls += 1;
				return waitCalls === 1
					? { code: 1, stdout: "", stderr: "connection lost", killed: false }
					: liveAgent("idle", sessionPath);
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => { if (notice.includes("已停下")) resolveResult(notice); },
	});
	await pool.resume();
	expect(await result).toContain("finished");
	expect(waitCalls).toBe(2);
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("done keeps the Worker live for Master follow-up", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-done-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	const calls: string[][] = [];
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("done", sessionPath);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("done");
	expect(store.state.workers[0]?.status).toBe("idle");
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(false);
	await rm(directory, { recursive: true, force: true });
});

test("a late settlement cannot revive a stopped Worker", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	let getCalls = 0;
	let releaseLatest!: () => void;
	let markLatestStarted!: () => void;
	const latestStarted = new Promise<void>((resolve) => { markLatestStarted = resolve; });
	const latest = new Promise<ReturnType<typeof response>>((resolve) => {
		releaseLatest = () => resolve(liveAgent());
	});
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle");
			if (args[0] === "agent" && args[1] === "get") {
				getCalls += 1;
				if (getCalls === 2) {
					markLatestStarted();
					return latest;
				}
				return liveAgent();
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	await latestStarted;
	await pool.stop("worker-1");
	releaseLatest();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.state.workers[0]?.status).toBe("dormant");
});

test("stop releases the tab but keeps or forgets the session by choice", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				return args[0] === "agent" && args[1] === "get" ? liveAgent() : response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.stop("worker-1");
	expect(store.state.workers[0]?.status).toBe("dormant");
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);
	await pool.stop("worker-1", true);
	expect(store.state.workers).toEqual([]);
});

function agentResponse(paneId: string, tabId: string, sessionPath: string) {
	return response({
		result: {
			agent: {
				pane_id: paneId,
				tab_id: tabId,
				agent_session: { kind: "path", value: sessionPath },
			},
		},
	});
}

function liveAgent(
	status?: "idle" | "blocked" | "done",
	sessionPath = "/tmp/worker.jsonl",
	stateLabels?: Record<string, string>,
) {
	return response({
		result: {
			agent: {
				pane_id: "w1:p2",
				tab_id: "w1:t2",
				agent_session: { kind: "path", value: sessionPath },
				...(status ? { agent_status: status } : {}),
				...(stateLabels ? { state_labels: stateLabels } : {}),
			},
		},
	});
}
