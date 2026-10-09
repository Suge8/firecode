import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MasterStore, type WorkerRef } from "../master/state.js";

const worker: WorkerRef = {
	name: "worker-1",
	role: "工程师",
	model: "test/worker",
	thinking: "medium",
	status: "working",
	sessionPath: "/tmp/subagents/worker-1.jsonl",
	launch: 1,
};
const other = { ...worker, name: "worker-2", sessionPath: "/tmp/subagents/worker-2.jsonl", launch: 2 };

let directory: string;
let path: string;

const seed = async (workers: unknown[], version = 9) => {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-state-"));
	path = join(directory, "state.json");
	await writeFile(path, JSON.stringify({ version, workers }));
};

afterEach(() => rm(directory, { recursive: true, force: true }));

test("载入时在飞状态收敛为带中断标记的 idle，审查义务等标记原样保留，已落定的不变", async () => {
	const reviewing = { ...other, status: "reviewing", reviewNeeded: true, disposition: "pending" };
	const idle = { ...worker, name: "idle", sessionPath: "/tmp/subagents/idle.jsonl", status: "idle", launch: 3 };
	await seed([worker, reviewing, idle]);
	const store = new MasterStore(path);
	expect(store.workers).toEqual([
		{ ...worker, status: "idle", interruptedAt: expect.any(Number) },
		{ ...reviewing, status: "idle", interruptedAt: expect.any(Number) },
		idle,
	]);
	// 收敛结果已落盘：下一次载入不再把它们当在飞。
	expect(JSON.parse(await readFile(path, "utf8")).workers[0]).toMatchObject({ status: "idle" });
});

test("格式不合法的档案明确失败，不当作空池", async () => {
	const invalid: unknown[][] = [
		[{ ...worker, status: "starting" }],
		[{ ...worker, interruptedAt: 0 }],
		[{ ...worker, disposition: "done" }],
		[{ ...worker, launch: undefined }],
		[{ ...worker, launch: 1.5 }],
		[worker, worker],
		[worker, { ...worker, name: "worker-2" }],
	];
	for (const workers of invalid) {
		await seed(workers);
		expect(() => new MasterStore(path)).toThrow("结构无效");
		await rm(directory, { recursive: true, force: true });
	}
});

test("同名覆盖保留身份：不能更换 sessionPath，也不能占用别人的 sessionPath", async () => {
	await seed([]);
	const store = new MasterStore(path);
	store.upsert(worker);
	expect(() => store.upsert({ ...worker, sessionPath: "/tmp/subagents/other.jsonl" })).toThrow("不能更换 sessionPath");
	expect(() => store.upsert({ ...worker, name: "worker-2" })).toThrow("sessionPath 已被占用");
	store.upsert({ ...worker, status: "idle", interruptedAt: 42, reviewNeeded: true });
	expect(store.workers).toEqual([{ ...worker, status: "idle", interruptedAt: 42, reviewNeeded: true }]);
});

test("每次变更以 0600 原子覆盖唯一状态文件", async () => {
	await seed([]);
	const store = new MasterStore(path);
	store.upsert(worker);
	store.upsert(other);
	expect(store.remove(worker.name)).toBe(true);
	expect(store.remove(worker.name)).toBe(false);
	expect(await readdir(directory)).toEqual(["state.json"]);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 9, workers: [other] });
});
