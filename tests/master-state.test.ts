import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MasterStore as Store, WorkerRef } from "../master/state.js";
import { loadFirecodeModule } from "./loader.ts";

// 经 loader 加载：state.ts 间接依赖宿主包，直接 import 要靠 bun 的自动安装，时好时坏。
const { MasterStore } = await loadFirecodeModule("master/state.ts") as { MasterStore: typeof Store };

const VERSION = 10;
const worker: WorkerRef = {
	name: "worker-1",
	role: "工程师",
	model: "test/worker",
	thinking: "medium",
	status: "working",
	sessionPath: "/tmp/subagents/worker-1.jsonl",
	cwd: "/tmp",
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
