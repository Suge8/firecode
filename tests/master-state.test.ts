import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MASTER_MODELS, parseMasterConfig } from "../config.js";
import {
	MasterStore,
	initialMasterState,
	loadMasterState,
	reduceMaster,
	restoreMasterState,
} from "../master/state.js";

test("master 节省略时用默认花名册，无配置问题", () => {
	const problems: string[] = [];
	expect(parseMasterConfig({}, problems).models).toEqual(DEFAULT_MASTER_MODELS);
	expect(problems).toEqual([]);
});

test("master 节未知字段、模型重复与缺失 model 都报配置问题", () => {
	const problems: string[] = [];
	const parsed = parseMasterConfig(
		{
			typo: true,
			models: [
				{ model: "openai-codex/gpt-5.6-sol", extra: 1 },
				{ thinking: "nope" },
				{ model: "openai-codex/gpt-5.6-sol" },
			],
		},
		problems,
	);
	expect(parsed.models[0]).toEqual({
		model: "openai-codex/gpt-5.6-sol",
		thinking: "medium",
		use: "通用",
	});
	expect(problems).toEqual([
		"未知字段 master.typo",
		"未知字段 master.models[0].extra",
		"master.models[1].model 必须是非空字符串",
		"master.models[1].thinking 值无效",
		"master.models 模型不能重复",
	]);
});

const dormant = {
	name: "worker-1",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium" as const,
	status: "dormant" as const,
	sessionPath: "/tmp/worker.jsonl",
};

test("restore rejects malformed identities, duplicate Pi sessions and foreign versions", () => {
	expect(restoreMasterState({ version: 4, workers: [dormant] })).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [{ ...dormant, status: "closed" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [{ ...dormant, thinking: "huge" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [dormant, dormant] })).toBeUndefined();
	expect(restoreMasterState({
		version: 5,
		workers: [dormant, { ...dormant, name: "worker-2" }],
	})).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [dormant] })).toEqual({ version: 5, workers: [dormant] });
	const blocked = { ...dormant, status: "blocked", paneId: "w1:p2", tabId: "w1:t2" };
	expect(restoreMasterState({ version: 5, workers: [blocked] })).toEqual({ version: 5, workers: [blocked] });
	const reviewing = { ...blocked, status: "reviewing" };
	expect(restoreMasterState({ version: 5, workers: [reviewing] })).toEqual({ version: 5, workers: [reviewing] });
});

test("v5 新字段（cwd/interruptedAt/disposition）类型错误拒绝，合法值保留", () => {
	expect(restoreMasterState({ version: 5, workers: [{ ...dormant, cwd: "" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [{ ...dormant, interruptedAt: -1 }] })).toBeUndefined();
	expect(restoreMasterState({ version: 5, workers: [{ ...dormant, disposition: "nagged" }] })).toBeUndefined();
	const interrupted = {
		...dormant,
		status: "idle",
		paneId: "w1:p2",
		tabId: "w1:t2",
		cwd: "/tmp/checkout",
		interruptedAt: 1700000000000,
		disposition: "pending",
	};
	expect(restoreMasterState({ version: 5, workers: [interrupted] })).toEqual({ version: 5, workers: [interrupted] });
});

test("Worker Pool state atomically overwrites one file instead of appending session entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-state-"));
	const path = join(directory, "state.json");
	const store = new MasterStore(path);
	for (let index = 1; index <= 20; index += 1) {
		store.dispatch({
			type: "UPSERT_WORKER",
			worker: { ...dormant, name: `worker-${index}`, sessionPath: `/tmp/worker-${index}.jsonl` },
		});
	}
	expect(await readdir(directory)).toEqual(["state.json"]);
	expect(JSON.parse(await readFile(path, "utf8")).workers).toHaveLength(20);
	expect(loadMasterState(path)?.workers).toHaveLength(20);
	store.dispatch({ type: "CLEAR" });
	expect(await readdir(directory)).toEqual([]);
	await rm(directory, { recursive: true, force: true });
});

test("a corrupt current state fails closed instead of reviving an older snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-corrupt-"));
	const path = join(directory, "state.json");
	await writeFile(path, "not-json");
	expect(() => loadMasterState(path)).toThrow("不是合法 JSON");
	await rm(directory, { recursive: true, force: true });
});

test("reducer records reviewing and removes forgotten Workers", () => {
	let state = reduceMaster(initialMasterState(), { type: "UPSERT_WORKER", worker: dormant });
	state = reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...dormant, status: "reviewing", paneId: "w1:p2", tabId: "w1:t2" },
	});
	expect(state).toMatchObject({ version: 5, workers: [{ status: "reviewing" }] });
	state = reduceMaster(state, { type: "REMOVE_WORKER", name: "worker-1" });
	expect(state.workers).toEqual([]);
});
