import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import { installFaux } from "./faux-host.ts";
import { until } from "./until.ts";
import { loadFirecodeModule, featuresOnly, PI_AI_COMPAT_URL, TEST_REVIEW_CONFIG } from "./loader.ts";

const { fauxAssistantMessage } = await import(PI_AI_COMPAT_URL) as any;

type RegisterReview = typeof import("../review/index.js").registerReview;
type CheckpointModule = typeof import("../review/checkpoint.js");

let registerReview: RegisterReview;
let readCheckpoint: CheckpointModule["readCheckpoint"];

/** 迁移是同步的；让出事件循环两拍，等已完成的会话 Promise 把结果回灌进来。 */
const flush = async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * 审查者与顾问是真实的进程内会话，开在测试 Agent 目录的真实 models.json 里：供应商只有 faux，
 * 它的回答由用例经 script 脚本化（每个会话按自己看到的上下文回答，不依赖请求顺序）。
 */
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
let faux: any;
let agentDir: string;
beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "firecode-review-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// expired 没有凭据：登录过期的供应商。
	faux = await installFaux(agentDir, ["p/one", "p/two", "p/three", "expired/sol", "test/advisor", "test/reviewer"], ["expired"]);
});
beforeEach(() => {
	((globalThis as Record<symbol, unknown>)[Symbol.for("firecode.model-cooldowns")] as Map<string, unknown> | undefined)?.clear();
});
afterAll(async () => {
	faux.unregister();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

/** 每个会话的回答；返回 undefined 表示该会话的供应商报错（额度不足）。 */
type Reply = string | undefined;
function script(reply: (model: { provider: string; id: string }) => Reply) {
	faux.setResponses(Array.from({ length: 30 }, () => (_context: unknown, _options: unknown, _state: unknown, model: any) => {
		const text = reply(model);
		return text === undefined ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "额度不足" }) : fauxAssistantMessage(text);
	}));
}

/** 会话开始后一直不回答；收到取消（流的 signal 中止）时记录下来。 */
function hang(onStart?: () => void, onAbort?: () => void) {
	return (_context: unknown, options?: { signal?: AbortSignal }) => new Promise<never>(() => {
		onStart?.();
		options?.signal?.addEventListener("abort", () => onAbort?.(), { once: true });
	});
}

/** 入口把进程里唯一的池传给 registerReview；这里给每次注册一个新池。 */
async function loadReviewModule(path: string, options?: Parameters<typeof loadFirecodeModule>[1]) {
	const [review, spawn] = await Promise.all([loadFirecodeModule(path, options), loadFirecodeModule("spawn.js")]) as any[];
	return { ...review, registerReview: (pi: unknown, extra: object = {}) => review.registerReview(pi, new spawn.InProcessSessionPool(), extra) };
}

async function loadAll() {
	registerReview = ((await loadReviewModule("review/index.js")) as { registerReview: RegisterReview }).registerReview;
	readCheckpoint = ((await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule).readCheckpoint;
}

function makeSessionManager() {
	const entries: unknown[] = [];
	return {
		entries,
		getBranch: () => [...entries],
		getEntries: () => [...entries],
		getSessionFile: () => "/tmp/review-session.jsonl",
		getSessionName: () => undefined,
		getCwd: () => "/tmp/firecode-test",
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	};
}

type MockSessionManager = ReturnType<typeof makeSessionManager>;

const checkpoints = (sessionManager: MockSessionManager) =>
	sessionManager.entries.filter((entry) => (entry as { customType?: string }).customType === "firecode-review-checkpoint");

function makeCtx(sessionManager: MockSessionManager, busy = false) {
	let idle = !busy;
	const notices: string[] = [];
	return {
		notices,
		hasUI: true,
		cwd: "/tmp/firecode-test",
		sessionManager,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		setIdle: (value: boolean) => {
			idle = value;
		},
		ui: {
			notify: (message: string) => { notices.push(message); },
			setStatus: () => {},
			setTitle: () => {},
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
	};
}

function makeHeadlessCtx(sessionManager: MockSessionManager) {
	const ctx = makeCtx(sessionManager);
	ctx.hasUI = false;
	ctx.ui = new Proxy(ctx.ui, {
		get: () => { throw new Error("headless review dereferenced ctx.ui"); },
	});
	return ctx;
}

function makePi(sessionManager: MockSessionManager) {
	const fake = fakePi({
		appendEntry: (customType: string, data?: unknown) => { sessionManager.appendCustomEntry(customType, data); },
	});
	const registered = {
		commands: fake.commands,
		fire: fake.fire,
		get sent() { return fake.sent.map(({ message }) => message as { content: string }); },
		/** 投给执行模型的消息（修复反馈、总结提示）：带 triggerTurn:true 的自定义消息；结果卡不带。 */
		get delivered() { return fake.sent.filter(({ options }) => options?.triggerTurn === true).map(({ message }) => message as { customType: string; content: string; display: boolean; details?: unknown }); },
	};
	return { pi: fake.pi, registered };
}

/** Master 读到的审查判定（经会话文件）。 */
async function outcomeOf(sessionManager: MockSessionManager) {
	const outcome = (await loadFirecodeModule("review/outcome.js")) as typeof import("../review/outcome.js");
	const sessionPath = join(tmpdir(), `review-outcome-${randomUUID()}.jsonl`);
	await writeFile(sessionPath, sessionManager.entries.map((entry) => JSON.stringify(entry)).join("\n"));
	try {
		return outcome.readReviewOutcome(sessionPath);
	} finally {
		await rm(sessionPath, { force: true });
	}
}

/** 所有审查者都给出同一个结论。 */
async function loadReviewWithVerdict(verdict: string) {
	const review = (await loadReviewModule("review/index.js", {
		configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
	})) as { registerReview: (pi: unknown, options?: unknown) => void };
	return {
		readCheckpoint: ((await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule).readCheckpoint,
		registerReview: (pi: unknown) => {
			script(() => verdict);
			review.registerReview(pi);
		},
	};
}

/**
 * 宿主为空闲时 triggerTurn 投递的最近一条自定义消息开回合：agent_start，随后记录这条消息（message_start，deliver 以此确认送达）；
 * 让出一拍，等确认推进的迁移落定（真实回合里模型请求远比这长）。
 */
async function startTurn(registered: ReturnType<typeof makePi>["registered"], ctx: unknown) {
	const { customType, content, details } = registered.delivered.at(-1)!;
	await registered.fire("agent_start", {}, ctx);
	await registered.fire("message_start", { message: { role: "custom", customType, content, display: true, details } }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
}

const fireReview = (registered: ReturnType<typeof makePi>["registered"]) =>
	registered.commands.get("fire-review") as { handler: (args: string, ctx: unknown) => Promise<void> };

const FAIL_VERDICT = [
	"核对了 a.ts。",
	"证据：文件=a.ts；命令=bun test",
	"## 发现 1",
	"- 发生条件: 每次",
	"- 频率: 10",
	"- 影响: 5",
	"- 问题: x",
	"- 证据: a.ts",
	"- 违反的约定与期望行为: y",
	"- 验证命令: bun test",
].join("\n");

const PASS_VERDICT = "PASS\n核对完毕。\n证据：文件=a.ts；命令=bun test";

const reviewConfig = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({ review: { ...TEST_REVIEW_CONFIG, ...overrides } });

describe("/fire-review", () => {
	test("a second /fire-review while one runs is refused and recorded", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = fireReview(registered);
		await command.handler("", ctx);
		await flush();
		await command.handler("", ctx);
		await flush();
		expect(ctx.notices).toHaveLength(1);
		expect(sessionManager.entries).toContainEqual(expect.objectContaining({ customType: "firecode-review-refusal" }));
	});

	test("a passing review hands the executor a summary turn and ends as passed for the Master", async () => {
		const { registerReview, readCheckpoint } = await loadReviewWithVerdict(PASS_VERDICT);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.delivered.length > 0);
		await startTurn(registered, ctx);
		await registered.fire("agent_settled", { aborted: false }, ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "settled");
		expect(await outcomeOf(sessionManager)).toMatchObject({ status: "passed", rounds: 1 });
	}, 20_000);

	test("/fire-review --cancel aborts the running reviewer and ends the review as cancelled", async () => {
		const started = Promise.withResolvers<void>();
		const module = (await loadReviewModule("review/index.js", {
			configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
		})) as { registerReview: (pi: unknown, options?: unknown) => void };
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule;
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		let aborted = false;
		faux.setResponses([hang(started.resolve, () => { aborted = true; })]);
		module.registerReview(pi);
		const ctx = makeHeadlessCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = fireReview(registered);
		await command.handler("", ctx);
		await started.promise;
		await command.handler("--cancel", ctx);
		await until(() => aborted);
		await flush();
		expect(checkpoint.readCheckpoint({ sessionManager })).toMatchObject({ phase: "settled", end: "cancelled" });
		expect(sessionManager.entries).not.toContainEqual(expect.objectContaining({ customType: "firecode-review-refusal" }));
	}, 10_000);

	test("cancelling during the repair turn is reported to the Master as cancelled, not as rounds exhausted", async () => {
		const { registerReview, readCheckpoint } = await loadReviewWithVerdict(FAIL_VERDICT);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.delivered.length > 0);
		await startTurn(registered, ctx);
		await registered.fire("agent_settled", { aborted: true }, ctx);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(await outcomeOf(sessionManager)).toMatchObject({ status: "cancelled", rounds: 1 });
	}, 20_000);

	test("while the executor is still streaming nothing is sent; once it settles the review starts", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		await fireReview(registered).handler("", ctx);
		await flush();
		// streaming 时 sendMessage 会成为 steer，会打断当前回复。
		expect(registered.sent).toHaveLength(0);
		ctx.setIdle(true);
		await registered.fire("agent_settled", {}, ctx);
		await flush();
		expect(registered.sent.length).toBeGreaterThan(0);
	});

	test.each([
		["a malformed field", `{ "review": { "reviewers": "typo" } }`, ""],
		["an unparsable config file", "{", ""],
		["an unknown flag", reviewConfig(), "--unknown=value"],
	])("the command refuses to start on %s: it tells the user, records the refusal and writes no checkpoint", async (_name, configJsonc, args) => {
		const { registerReview } = (await loadReviewModule("review/index.js", { configJsonc })) as { registerReview: (pi: unknown) => void };
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		await fireReview(registered).handler(args, ctx);
		expect(ctx.notices.length).toBeGreaterThan(0);
		expect(sessionManager.entries).toContainEqual(expect.objectContaining({ customType: "firecode-review-refusal" }));
		expect(checkpoints(sessionManager)).toHaveLength(0);
	});

	test("Master remains available when review configuration is invalid", async () => {
		const entry = (await loadFirecodeModule("index.js", {
			configJsonc: JSON.stringify({
				features: await featuresOnly("master", "review"),
				review: { reviewers: "invalid" },
			}),
		})) as { default: (pi: unknown) => void };
		const { pi, registered } = makePi(makeSessionManager());
		entry.default(pi);
		expect(registered.commands.has("fire-master")).toBe(true);
	});
});

describe("reload", () => {
	test("reload shutdown keeps the checkpoint active; session_start restores it and the review resumes", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		await fireReview(registered).handler("", ctx);
		await flush();
		const runId = readCheckpoint({ sessionManager })?.runId;
		await registered.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })).toMatchObject({ phase: "queued", runId });

		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2 as never);
		faux.setResponses([hang()]);
		const restoredCtx = makeCtx(sessionManager);
		restoredCtx.cwd = tmpdir();
		await registered2.fire("session_start", { type: "session_start", reason: "reload" }, restoredCtx);
		await registered2.fire("resources_discover", {}, restoredCtx);
		await flush();
		expect(readCheckpoint({ sessionManager })).toMatchObject({ phase: "reviewing", runId });

		await registered2.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, restoredCtx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("旧版 v8 审查不会被恢复或改写", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		sessionManager.appendCustomEntry("firecode-review-checkpoint", {
			version: 8, runId: "old-review", phase: "reviewing", round: 1, rounds: 0, last: null,
			slots: [{ model: "p/one", thinking: "low", fallback: [], result: null }],
		});
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager);
		await registered.fire("session_start", {}, ctx);
		await registered.fire("resources_discover", {}, ctx);
		expect(readCheckpoint({ sessionManager })).toBeUndefined();
		expect(checkpoints(sessionManager)).toHaveLength(1);
		expect(ctx.notices).toEqual([]);
	});
});

describe("multi-reviewer verdicts and degraded paths", () => {
	test("a malformed blocking finding beats another reviewer's PASS and its original text reaches the executor", async () => {
		const { registerReview } = await loadTwoReviewers((model) =>
			model === "p/one" ? "## 发现 1：没按模板写，但数据会丢：重启后 checkpoint 被覆盖\n- 发生条件: 每次重启\n- 频率: 10\n- 影响: 9" : PASS_VERDICT,
		);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.delivered.length > 0);
		expect(registered.delivered[0].content).toContain("数据会丢：重启后 checkpoint 被覆盖");
		expect(registered.sent.some((message) => message.content.includes("审查通过"))).toBe(false);
	}, 20_000);

	test("a reviewer that gives no verdict keeps the review from passing; the result names the model and the reason", async () => {
		const { registerReview, readCheckpoint } = await loadTwoReviewers(() => PASS_VERDICT, ["expired/sol/low", "p/one/low"]);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "settled");
		expect(registered.delivered).toEqual([]);
		const result = await outcomeOf(sessionManager);
		expect(result.status).toBe("failed");
		expect((result as { reason: string }).reason).toContain("expired/sol");
		expect(registered.sent.some((message) => message.content.includes("审查通过"))).toBe(false);
	}, 20_000);

	test.each([
		["its output has no valid format", [["p/one/low", "p/two/low"]], (model: string) => model === "p/one" ? "结论如下\n随便写" : "核对完毕。\n证据：文件=a.ts；命令=bun test", "p/two"],
		["it runs out of quota", [["p/two/low", "p/three/low"]], (model: string) => model === "p/two" ? undefined : PASS_VERDICT, "p/three"],
	])("a seat whose first model fails because %s is reviewed by the next model in its chain, and the pass card says so", async (_name, reviewers, answer, fallback) => {
		const { registerReview, readCheckpoint } = await loadTwoReviewers(answer, reviewers);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => ["summarizing", "settled"].includes(readCheckpoint({ sessionManager })?.phase ?? ""));
		expect(readCheckpoint({ sessionManager })).toMatchObject({ phase: "summarizing", history: [{ reviewers: [{ model: fallback }] }] });
		expect(registered.sent.find((message) => message.content.includes("审查通过"))?.content).toContain("（备用）");
	}, 20_000);
});

/** 审查者（默认 p/one、p/two）加顾问；answer 按模型给出会话输出，返回 undefined 表示该会话没有产出。 */
async function loadTwoReviewers(answer: (model: string) => Reply, reviewers: unknown[] = ["p/one/low", "p/two/low"]) {
	const review = (await loadReviewModule("review/index.js", {
		configJsonc: reviewConfig({ reviewers, maxRounds: 3 }),
	})) as { registerReview: (pi: unknown, options?: unknown) => void };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule;
	return {
		readCheckpoint: checkpoint.readCheckpoint,
		registerReview: (pi: unknown) => {
			script((model) => answer(`${model.provider}/${model.id}`));
			review.registerReview(pi);
		},
	};
}
