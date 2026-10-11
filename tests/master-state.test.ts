import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MasterStore, type WorkerRef } from "../master/state.js";

const VERSION = 10;
const worker: WorkerRef = {
	name: "worker-1",
	role: "工程师",
	model: "test/worker",
	thinking: "medium",
	status: "working",
	sessionPath: "/tmp/subagents/worker-1.jsonl",
	launch: 1,
};
const other = { ...worker, name: "worker-2", sessionPath: "/tmp/subagents/worker-2.jsonl", launch: 3 };

let directory: string;
let path: string;

const seed = async (workers: unknown[], version = VERSION) => {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-state-"));
	path = join(directory, "state.json");
	await writeFile(path, JSON.stringify({ version, workers }));
};
const exists = (file: string) => access(file).then(() => true, () => false);

afterEach(() => rm(directory, { recursive: true, force: true }));

test("载入时在飞状态收敛为带中断标记的 idle 并记入 recovered，审查义务等标记原样保留，已落定的不变", async () => {
	const reviewing = { ...other, status: "reviewing", reviewNeeded: true };
	const idle = { ...worker, name: "idle", sessionPath: "/tmp/subagents/idle.jsonl", status: "idle", launch: 3, interruptedAt: 7 };
	await seed([worker, reviewing, idle]);
	const store = new MasterStore(path);
	expect(store.workers).toEqual([
		{ ...worker, status: "idle", interruptedAt: expect.any(Number) },
		{ ...reviewing, status: "idle", interruptedAt: expect.any(Number) },
		idle,
	]);
	expect(store.recovered).toEqual(["worker-1", "worker-2"]);
	// 收敛结果已落盘：下一次载入不再把它们当在飞，也不再算本次收敛的。
	expect(new MasterStore(path).recovered).toEqual([]);
});

test("格式不合法的档案明确失败，不当作空池", async () => {
	const invalid: unknown[][] = [
		[{ ...worker, status: "starting" }],
		[{ ...worker, interruptedAt: 0 }],
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

test("列表始终按启动序：档案里乱序的载入后有序，新增按启动序插入", async () => {
	await seed([other, worker]);
	const store = new MasterStore(path);
	expect(store.workers.map((entry) => entry.name)).toEqual(["worker-1", "worker-2"]);
	store.upsert({ ...worker, name: "worker-0", sessionPath: "/tmp/subagents/worker-0.jsonl", launch: 2 });
	store.upsert({ ...worker, name: "worker-9", sessionPath: "/tmp/subagents/worker-9.jsonl", launch: 9 });
	expect(store.workers.map((entry) => entry.name)).toEqual(["worker-1", "worker-0", "worker-2", "worker-9"]);
	store.upsert({ ...other, status: "idle" });
	expect(store.workers.map((entry) => entry.name)).toEqual(["worker-1", "worker-0", "worker-2", "worker-9"]);
});

test("每次变更以 0600 原子覆盖唯一状态文件；池变空（删最后一票、载入空池）就删文件", async () => {
	await seed([]);
	expect(await exists(path)).toBe(true);
	const store = new MasterStore(path);
	expect(await exists(path)).toBe(false);
	store.upsert(worker);
	store.upsert(other);
	expect(store.remove(worker.name)).toBe(true);
	expect(store.remove(worker.name)).toBe(false);
	expect(await readdir(directory)).toEqual(["state.json"]);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: VERSION, workers: [other] });
	store.remove(other.name);
	expect(await readdir(directory)).toEqual([]);
});

test("旧版本档案丢弃并记下版本；更新版本（降级）明确失败且不删档案", async () => {
	await seed([], VERSION - 1);
	const legacy = new MasterStore(path);
	expect(legacy.discardedLegacyVersion).toBe(VERSION - 1);
	expect(await exists(path)).toBe(false);

	await rm(directory, { recursive: true, force: true });
	await seed([worker], VERSION + 1);
	expect(() => new MasterStore(path)).toThrow("更新版本");
	expect(await exists(path)).toBe(true);
});
