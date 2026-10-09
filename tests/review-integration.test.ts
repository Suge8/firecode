import { describe, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule, featuresOnly, TEST_REVIEW_CONFIG } from "./loader.ts";

type RegisterReview = typeof import("../review/index.js").registerReview;
type ReviewHandle = ReturnType<RegisterReview>;
type WriteCheckpoint = typeof import("../review/checkpoint.js").writeCheckpoint;
type BeginCheckpoint = typeof import("../review/checkpoint.js").beginCheckpoint;
type ReadCheckpoint = typeof import("../review/checkpoint.js").readCheckpoint;
type CheckpointConflictError = typeof import("../review/checkpoint.js").CheckpointConflictError;
type InitialState = typeof import("../review/state.js").initialState;

let registerReview: RegisterReview;
/** 排空本测试里注册过的每个会话运行时。 */
let flush: () => Promise<void>;
let writeCheckpoint: WriteCheckpoint;
let beginCheckpoint: BeginCheckpoint;
let readCheckpoint: ReadCheckpoint;
let CheckpointConflictErrorCtor: CheckpointConflictError;
let initialState: InitialState;

async function loadAll() {
	const index = (await loadFirecodeModule("review/index.js")) as { registerReview: RegisterReview };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		writeCheckpoint: WriteCheckpoint;
		beginCheckpoint: BeginCheckpoint;
		readCheckpoint: ReadCheckpoint;
		CheckpointConflictError: CheckpointConflictError;
	};
	const state = (await loadFirecodeModule("review/state.js")) as { initialState: InitialState };
	const handles: ReviewHandle[] = [];
	registerReview = ((...args: Parameters<RegisterReview>) => {
		const handle = index.registerReview(...args);
		handles.push(handle);
		return handle;
	}) as RegisterReview;
	flush = async () => { for (const handle of handles) await handle.settled(); };
	writeCheckpoint = checkpoint.writeCheckpoint;
	beginCheckpoint = checkpoint.beginCheckpoint;
	readCheckpoint = checkpoint.readCheckpoint;
	CheckpointConflictErrorCtor = checkpoint.CheckpointConflictError;
	initialState = state.initialState;
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
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	return {
		statuses,
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
			setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
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
		renderers: fake.messageRenderers,
		commands: fake.commands,
		fire: fake.fire,
		get sent() { return fake.sent.map(({ message }) => message); },
		get emitted() { return fake.emitted.map(([name, data]) => ({ name, data })); },
	};
	return { pi: fake.pi, registered };
}

async function loadReviewWithVerdict(
	verdict: string,
	maxRounds?: number,
	{ top = {}, onSession }: { top?: Record<string, unknown>; onSession?: (options: { prompt: { system: string } }) => void } = {},
) {
	const review = (await loadFirecodeModule("review/index.js", {
		configJsonc: reviewConfig({
			reviewers: ["p/one/low"],
			...(maxRounds === undefined ? {} : { maxRounds }),
		}, top),
	})) as { registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => ReviewHandle };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		readCheckpoint: (ctx: unknown) => { phase: string; repair?: { status: string } | null } | undefined;
	};
	const outcome = (await loadFirecodeModule("review/outcome.js")) as {
		readReviewOutcome: (sessionPath: string) => { status: string; rounds?: number };
	};
	return {
		...checkpoint,
		...outcome,
		registerReview: (pi: unknown) => review.registerReview(pi, true, false, {
			runSession: async (options: { prompt: { system: string } }) => {
				onSession?.(options);
				return { kind: "output", text: verdict };
			},
		}),
	};
}

/** 等真实计时器驱动的状态落定（例如 2s 的回执超时）；条件满足即返回。 */
async function until(condition: () => boolean, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

const fireReview = (registered: ReturnType<typeof makePi>["registered"]) =>
	registered.commands.get("fire-review") as { handler: (args: string, ctx: unknown) => Promise<void> };

const FAIL_VERDICT = [
	"FAIL",
	"## 发现 1",
	"- 严重程度: 中",
	"- 问题: x",
	"- 证据: a.ts",
	"- 违反的约定与期望行为: y",
	"- 验证命令: bun test",
].join("\n");

async function loadSingleFailReview() {
	return loadReviewWithVerdict(FAIL_VERDICT);
}

const OCCUPIED = { name: "firecode:review", data: { active: true, progress: expect.any(Function) } };
const RELEASED = { name: "firecode:review", data: { active: false } };
const reviewConfig = (overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
	JSON.stringify({ ...top, review: { ...TEST_REVIEW_CONFIG, ...overrides } });

describe("registerReview wiring", () => {
	test("holds the occupancy channel exactly once until user cancellation", async () => {
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
		expect(registered.emitted).toEqual([OCCUPIED]);

		await registered.fire("session_shutdown", { reason: "quit" }, ctx);
		await flush();
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
	});

	test("a missing control prompt settles as an infrastructure error", async () => {
		const module = (await loadFirecodeModule("review/index.js", {
			extraFiles: { "review/prompts/review.zh.md": "" },
		})) as { registerReview: (pi: unknown) => void };
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string; history: { result: string; details: string }[] } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi);
		const ctx = makeCtx(sessionManager);
		const command = fireReview(registered);
		await command.handler("", ctx);
		await until(() => checkpoint.readCheckpoint({ sessionManager })?.phase === "settled");
		const state = checkpoint.readCheckpoint({ sessionManager });
		expect(state?.phase).toBe("settled");
		expect(state?.history.at(-1)?.result).toBe("error");
		expect(state?.history.at(-1)?.details).toContain("system prompt 为空");
	}, 10_000);

	test("language en: the reviewer gets the English policy; the result card, summary prompt and notices are English", async () => {
		const verdict = "PASS\nVerification exited 0.\nEvidence: files=a.ts; commands=bun test";
		const systems: string[] = [];
		const { registerReview, readCheckpoint } = await loadReviewWithVerdict(verdict, undefined, {
			top: { language: "en" },
			onSession: (options) => systems.push(options.prompt.system),
		});
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = fireReview(registered);
		await command.handler("", ctx);
		await until(() => readCheckpoint({ sessionManager })?.summary?.status === "awaiting_start");
		expect(systems[0]).toContain("You are an independent adversarial reviewer");
		const sent = registered.sent as { customType?: string; content?: string }[];
		const card = sent.filter((message) => message.customType === "firecode-review-card").map((message) => message.content).join("\n");
		expect(card).toContain("Models: one");
		expect(card).toContain("Review passed");
		expect(card).toContain("Elapsed:");
		const summary = sent.find((message) => message.customType === "firecode-review-summary")?.content ?? "";
		expect(summary).toContain("The adversarial review passed after 1 round(s)");
		expect(`${card}${summary}`).not.toMatch(/[\u3400-\u9fff]/u);
	}, 20_000);

	test("a pass reports the summarizing stage through occupancy until the summary turn ends, then releases it", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const { registerReview, readCheckpoint } = await loadReviewWithVerdict(verdict);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = fireReview(registered);
		await command.handler("", ctx);
		// 质量裁决落地 → 总结提示已投递（awaiting_start），占用仍持有。
		await until(() => readCheckpoint({ sessionManager })?.summary?.status === "awaiting_start");
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		const held = (registered.emitted as { data: { active: boolean; progress?: () => unknown } }[]).findLast((event) => event.data.active);
		expect(held?.data.progress?.()).toMatchObject({ stage: "summarizing" });
		const sent = registered.sent as { customType?: string; content?: string; display?: boolean }[];
		const summaryIndex = sent.findIndex((message) => message.customType === "firecode-review-summary");
		const cardIndex = sent.findIndex((message) => message.customType === "firecode-review-card");
		expect(summaryIndex).toBeGreaterThan(cardIndex); // 结果卡先于总结提示
		expect(sent[cardIndex]?.content?.startsWith("<firecode_review>\n")).toBe(true);
		expect(sent[cardIndex]?.content?.endsWith("\n</firecode_review>")).toBe(true);
		expect(sent[summaryIndex]?.content?.startsWith("<firecode_review>\n")).toBe(true);
		expect(sent[summaryIndex]?.content).toContain("对抗审查已通过");
		expect(sent[summaryIndex]?.content).toContain("不要修改代码");
		expect(sent[summaryIndex]?.content?.endsWith("\n</firecode_review>")).toBe(true);
		expect(sent[summaryIndex]?.display).toBe(false);
		expect(registered.emitted).toEqual([OCCUPIED]);
		// 总结回合启动与结束 → settled，占用释放。
		await registered.fire("agent_start", {}, ctx);
		await registered.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "settled");
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(readCheckpoint({ sessionManager })?.summary ?? null).toBeNull();
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
	}, 20_000);

	test("an occupancy signal failure does not stop the review", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.events.emit = () => { throw new Error("Herdr unavailable"); };
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = fireReview(registered);
		await command.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		await registered.fire("session_shutdown", { reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("headless review runs to a readable terminal verdict without UI access", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const { registerReview, readCheckpoint, readReviewOutcome } = await loadReviewWithVerdict(verdict);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeHeadlessCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = fireReview(registered);
		await command.handler("", ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "summarizing");
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		await registered.fire("agent_start", {}, ctx);
		await registered.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await flush();
		const sessionPath = join(tmpdir(), `review-outcome-${randomUUID()}.jsonl`);
		await writeFile(sessionPath, sessionManager.entries.map((entry) => JSON.stringify(entry)).join("\n"));
		expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "passed", rounds: 1 });
		await rm(sessionPath, { force: true });
	}, 20_000);

	test("headless session shutdown cancels the active review session", async () => {
		let started!: () => void;
		const sessionStarted = new Promise<void>((resolve) => { started = resolve; });
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
		})) as {
			registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => ReviewHandle;
		};
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const review = module.registerReview(pi, true, false, {
			runSession: ({ signal }: { signal?: AbortSignal }) => new Promise((resolve) => {
				started();
				signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
			}),
		});
		const ctx = makeHeadlessCtx(sessionManager);
		const command = fireReview(registered);
		await command.handler("", ctx);
		await sessionStarted;
		await registered.fire("session_shutdown", { reason: "quit" }, ctx);
		await review.settled();
		expect(checkpoint.readCheckpoint({ sessionManager })?.phase).toBe("settled");
	}, 10_000);

	test("queued user cancellation notifies immediately without persisting a result card", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		let editorFactory: ((tui: unknown, theme: unknown, keys: unknown) => { handleInput: (data: string) => void }) | undefined;
		Object.assign(ctx.ui, {
			setWidget: () => {},
			setWorkingVisible: () => {},
			getEditorComponent: () => undefined,
			setEditorComponent: (factory?: typeof editorFactory) => { editorFactory = factory; },
		});
		const command = fireReview(registered);
		await command.handler("", ctx);
		await flush();
		if (!editorFactory) throw new Error("review editor was not installed");
		const editor = editorFactory(
			{ requestRender: () => {}, addInputListener: () => () => {} },
			{ borderColor: (text: string) => text, selectList: {} },
			{ matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" },
		);
		editor.handleInput("\x1b");
		await flush();
		expect(ctx.notices).toContain("审查已取消\n已按你的操作停止");
		expect(registered.sent).toHaveLength(0);
	});

	test("does not send cards or start reviewers before the current run is fully settled", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = fireReview(registered);

		await command.handler("", ctx);
		await flush();
		// streaming 时 sendMessage 会成为 steer；零发送是不能打断当前回复的关键合同。
		expect(registered.sent).toHaveLength(0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		expect(ctx.statuses).toEqual([]);

		// FireCode 入口把 review 注册在所有自动续跑模块之后；收到 settled 时，
		// 先前 handler 已完成且没有发起续跑，才会到这里。
		ctx.setIdle(true);
		await registered.fire("agent_settled", {}, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
		expect(registered.sent.length).toBeGreaterThan(0);
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

	test("review accepts focus text and rejects flags in the configured language", async () => {
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({}, { language: "en" }),
		})) as { registerReview: (pi: unknown) => ReviewHandle };
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const review = module.registerReview(pi);
		const ctx = makeCtx(sessionManager, true);
		const command = fireReview(registered);
		await command.handler("--unknown=value", ctx);
		expect(ctx.notices).toContain("Invalid fire-review arguments.");
		await command.handler("focus", ctx);
		await review.settled();
		expect(registered.emitted).toEqual([OCCUPIED]);
	});

	test("disabled review still renders history and settles an active checkpoint", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const state = {
			...initialState("disabled"),
			phase: "queued" as const,
			startedAt: 1,
			updatedAt: 1,
		};
		beginCheckpoint(pi as never, state);
		registerReview(pi as never, false);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.commands.has("fire-review")).toBe(false);
		await registered.fire("session_start", {}, makeCtx(sessionManager));
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("a broken features config preserves the active checkpoint instead of sealing it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const state = {
			...initialState("config-broken"),
			phase: "queued" as const,
			startedAt: 1,
			updatedAt: 1,
		};
		beginCheckpoint(pi as never, state);
		// features 整节类型错误被安全回退成全关，但那是配置坏而非用户关闭：不得封存。
		registerReview(pi as never, false, true);
		expect(registered.commands.has("fire-review")).toBe(false);
		await registered.fire("session_start", {}, makeCtx(sessionManager));
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
	});
});

describe("review runtime is per session", () => {
	test("two sessions in one process each run their own review", async () => {
		await loadAll();
		const a = makeSessionManager();
		const b = makeSessionManager();
		const first = makePi(a);
		const second = makePi(b);
		const reviewA = registerReview(first.pi as never, true, false, {
			runSession: () => new Promise(() => {}),
		});
		const reviewB = registerReview(second.pi as never, true, false, {
			runSession: () => new Promise(() => {}),
		});
		const ctxA = makeCtx(a);
		const ctxB = makeCtx(b);
		const command = (registered: ReturnType<typeof makePi>["registered"]) =>
			registered.commands.get("fire-review") as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command(first.registered).handler("", ctxA);
		await reviewA.settled();
		await command(second.registered).handler("", ctxB);
		await reviewB.settled();
		expect(ctxA.notices).toEqual([]);
		expect(ctxB.notices).toEqual([]);
		const stateA = readCheckpoint({ sessionManager: a });
		const stateB = readCheckpoint({ sessionManager: b });
		expect(stateA?.phase).toBe("reviewing");
		expect(stateB?.phase).toBe("reviewing");
		expect(stateA?.runId).not.toBe(stateB?.runId);
	});
});

describe("checkpoint persistence", () => {
	test("write then read round-trips; a remembered-expected mismatch is a conflict", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi } = makePi(sessionManager);
		const ctx = { sessionManager };
		const state = initialState("run-1");
		// 首次写用 beginCheckpoint（无条件替换旧终态），返回本次写入凭证
		const first = beginCheckpoint(pi as never, state);
		expect(readCheckpoint(ctx)?.runId).toBe("run-1");
		expect(first).toEqual({ runId: "run-1", seq: 1 });

		// 后续写带凭证（本 controller 记住的上一次写入）；匹配则成功且 seq 递增
		const next = { ...state, phase: "queued" as const, updatedAt: 5 };
		const second = writeCheckpoint(pi as never, ctx, next, first);
		expect(readCheckpoint(ctx)?.phase).toBe("queued");
		expect(second.seq).toBe(2);

		// 陈旧写者：Run ID 相同但 seq 落后——只比 Run ID 时无法识别，必须拒绝
		expect(() => writeCheckpoint(pi as never, ctx, next, first)).toThrow(
			CheckpointConflictErrorCtor,
		);

		// 另一场审查的凭证同样冲突
		expect(() =>
			writeCheckpoint(pi as never, ctx, next, { runId: "run-9", seq: 2 }),
		).toThrow(CheckpointConflictErrorCtor);
	});

	test("real persist path detects a concurrent checkpoint writer and stops the review", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);

		// 1. 排队开始审查（busy）→ 首次写落盘
		await fireReview(registered).handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		// 2. 模拟并发写者塞入不同 Run ID 的 checkpoint
		sessionManager.appendCustomEntry("firecode-review-checkpoint", {
			version: 5,
			seq: 1,
			runId: "foreign-writer",
			phase: "queued",
			round: 0,
			focus: "",
			history: [],
			active: null,
			pending: null,
			repair: null,
			summary: null,
			consecutiveFailures: 0,
			startedAt: 1,
			roundStartedAt: 1,
			updatedAt: 1,
		});

		// 3. quit 关闭 → CANCEL 落盘时撞上外来 Run ID → 冲突 → 不覆盖对方的记录并通知
		await registered.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.runId).toBe("foreign-writer");
		expect(ctx.notices.join()).toContain("checkpoint 冲突");
	});
});

describe("reload preserves recoverable state", () => {
	test("reload shutdown keeps the checkpoint active; session_start restores it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const commandHandler = fireReview(registered);

		// 1. 排队开始审查（queued），checkpoint 落成 queued
		await commandHandler.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		const runId = readCheckpoint({ sessionManager })?.runId;

		// 2. reload 关闭：不 settle，checkpoint 保持 queued（可恢复）
		expect(registered.emitted).toEqual([OCCUPIED]);
		await registered.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
		await flush();
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		const afterReload = readCheckpoint({ sessionManager });
		expect(afterReload?.phase).toBe("queued");
		expect(afterReload?.runId).toBe(runId);

		// 3. 新会话（同一 session 文件，新 pi 实例）session_start：从 checkpoint 恢复
		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2 as never);
		await registered2.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
		await flush();
		expect(registered2.emitted).toEqual([OCCUPIED]);

		// 4. 恢复后的 controller 正常处理后续事件：quit 关闭 → CANCEL 落终态
		await registered2.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(registered2.emitted).toEqual([OCCUPIED, RELEASED]);
	});

	test("headless reload immediately settles a Review Run whose persisted overall deadline elapsed", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		beginCheckpoint(pi as never, {
			...initialState("expired-run"),
			phase: "queued",
			startedAt: Date.now() - 201 * 60_000,
			updatedAt: Date.now() - 201 * 60_000,
		});
		registerReview(pi as never);
		await registered.fire("session_start", {}, makeHeadlessCtx(sessionManager));
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});
});

describe("review config is rejected at every entry point", () => {
	// 配置错误不能静默回退默认模型：那会拿用户没配的模型真实发起调用。
	// 命令入口与 checkpoint 恢复入口必须同标准。
	const brokenConfig = `{ "review": { "reviewers": "typo" } }`;
	// 整个文件语法坏掉时 review 节根本没被读到，错误信息也不带节名——
	// 曾因此被前缀过滤漏掉，然后拿默认审查者真实开跑。
	const unparsableConfig = "{";

	async function loadWithConfig(configJsonc: string) {
		return (await loadFirecodeModule("review/index.js", { configJsonc })) as {
			registerReview: (pi: unknown) => void;
		};
	}

	test.each([
		["a missing review section", '{"features":{"review":true}}'],
		["an empty advisor and reviewer list", reviewConfig({ advisor: "", reviewers: [] })],
		["a malformed field", brokenConfig],
		["an unknown field", `{ "review": { "reviewerz": [] } }`],
		["an unparsable config file", unparsableConfig],
	])("the command refuses to start on %s: it tells the user, records the refusal and writes no checkpoint", async (_name, configJsonc) => {
		const { registerReview } = await loadWithConfig(configJsonc);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		await fireReview(registered).handler("", ctx);
		expect(ctx.notices.join()).toContain("配置有问题");
		expect(sessionManager.entries).toContainEqual(expect.objectContaining({ customType: "firecode-review-refusal" }));
		expect(checkpoints(sessionManager)).toHaveLength(0);
	});

	test("recovery from an active checkpoint refuses without sealing recoverable state", async () => {
		const { registerReview } = await loadWithConfig(brokenConfig);
		const sessionManager = makeSessionManager();
		sessionManager.entries.push({
			type: "custom",
			customType: "firecode-review-checkpoint",
			data: {
				version: 5,
				seq: 1,
				runId: "g",
				phase: "reviewing",
				round: 1,
				focus: "",
				history: [],
				active: {
					round: 1,
					reviewers: [{ index: 0, model: "m", thinking: "high", status: "running", result: null }],
					settledCount: 0,
				},
				pending: null,
				repair: null,
				summary: null,
				consecutiveFailures: 0,
				startedAt: 1,
				roundStartedAt: 1,
				updatedAt: 1,
			},
		});
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		await registered.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		// 启动告警由 FireCode 入口统一聚合，review 只负责保留可恢复 checkpoint。
		expect(notices).toEqual([]);
		expect(readCheckpoint({ sessionManager })).toMatchObject({
			runId: "g",
			phase: "reviewing",
			seq: 1,
		});
	});
});

describe("reload recovery actually resumes the loop", () => {
	// resources_discover 是宿主提供的 post-session 边界：只有全部异步 session_start
	// handler 返回后才发，不能用 tick 或毫秒猜测。
	test("restored reviewers wait for the post-session event after later async handlers", async () => {
		await loadAll();
		const marker = join(tmpdir(), `fire-review-marker-${Date.now()}`);
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
		})) as {
			registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => ReviewHandle;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		let resolveReview!: () => void;
		const reviewSettled = new Promise<void>((resolve) => { resolveReview = resolve; });
		const sendMessage = pi.sendMessage;
		pi.sendMessage = (...args: unknown[]) => {
			(sendMessage as (...values: unknown[]) => void)(...args);
			resolveReview();
		};
		beginCheckpoint(pi as never, {
			...initialState("restore-review"),
			phase: "reviewing",
			round: 1,
			active: {
				round: 1,
				reviewers: [{ index: 0, model: "p/one", thinking: "low", status: "running", result: null }],
				settledCount: 0,
			},
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		const review = module.registerReview(pi, true, false, {
			runSession: async () => {
				await writeFile(marker, "started");
				return { kind: "empty" };
			},
		});
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await registered.fire("session_start", {}, ctx);
		await review.settled();
		expect(existsSync(marker)).toBe(false);

		// 模拟后续 master handler 异步等待后触发续跑；post-session 事件此时才到。
		ctx.setIdle(false);
		await registered.fire("resources_discover", {}, ctx);
		await review.settled();
		expect(existsSync(marker)).toBe(false);

		ctx.setIdle(true);
		await registered.fire("agent_settled", {}, ctx);
		await reviewSettled;
		expect(existsSync(marker)).toBe(true);
		await rm(marker, { force: true });
	});

	test("reload before repair agent_start re-delivers feedback without advancing the round", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		beginCheckpoint(pi as never, {
			...initialState("restore-repair"),
			phase: "awaiting_fix",
			round: 1,
			repair: { details: "FAIL", advisor: null, status: "awaiting_start" },
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager);
		await registered.fire("session_start", {}, ctx);
		ctx.setIdle(false);
		await flush();
		expect(readCheckpoint({ sessionManager })?.repair?.status).toBe("pending");
		expect(registered.sent).toHaveLength(0);

		ctx.setIdle(true);
		await registered.fire("resources_discover", {}, ctx);
		await flush();
		const restored = readCheckpoint({ sessionManager });
		expect(restored?.phase).toBe("awaiting_fix");
		expect(restored?.round).toBe(1);
		expect(restored?.repair?.status).toBe("awaiting_start");
		expect(
			registered.sent.some((message) => (message as { customType?: string }).customType === "firecode-review-feedback"),
		).toBe(true);
	});

	test("a queued review resumes on session_start when the session is idle", async () => {
		const { registerReview } = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig(),
		})) as { registerReview: (pi: unknown) => void };
		const checkpointModule = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const busyCtx = makeCtx(sessionManager, true);
		const command = fireReview(registered);
		await command.handler("", busyCtx);
		await flush();
		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).toBe("queued");

		await registered.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, busyCtx);
		await flush();

		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2);
		const restoredCtx = makeCtx(sessionManager, false);
		await registered2.fire("session_start", { type: "session_start", reason: "reload" }, restoredCtx);
		await flush();
		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).toBe("queued");
		await registered2.fire("resources_discover", {}, restoredCtx);
		await flush();

		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
	});
});

describe("the loop survives failing side effects", () => {
	// dispatchQueue 一旦 rejected 就再也不执行后续迁移，连 esc 取消都会失效。
	// 发卡只是展示，失败不能吞掉同一迁移里的推进请求。
	test("a failing card does not swallow the effects after it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = () => {
			throw new Error("UI 挂了");
		};
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, false) as never;
		const command = fireReview(registered);
		await command.handler("", ctx);
		await flush();
		// 启动卡发送失败，但仍离开 queued 并实际跑完审查者。
		expect(readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
	});

	// 宿主 sendMessage 返回 void，异步失败不会 throw；必须靠 agent_start 回执超时收口，
	// 不能用同步 throw 的假 API 制造假覆盖。
	test("feedback without an agent_start receipt cancels instead of stranding awaiting_fix", async () => {
		const { registerReview, readCheckpoint } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		// 与真实宿主一致：调用立即返回 void，异步失败不会反馈给插件，也没有 agent_start。
		const review = registerReview(pi);
		const ctx = makeCtx(sessionManager, false);
		ctx.cwd = tmpdir();
		jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
		try {
			await fireReview(registered).handler("", ctx);
			for (let turn = 0; turn < 5; turn += 1) await review.settled();
			expect(readCheckpoint({ sessionManager })?.repair?.status).toBe("awaiting_start");
			jest.advanceTimersByTime(2_000);
			await review.settled();
		} finally {
			jest.useRealTimers();
		}
		expect(
			registered.sent.some(
				(message) => (message as { customType?: string }).customType === "firecode-review-feedback",
			),
		).toBe(true);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("a synchronous feedback failure cancels without dispatchQueue self-deadlock", async () => {
		const { registerReview, readCheckpoint } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = (message: { customType?: string }) => {
			if (message.customType === "firecode-review-feedback") throw new Error("同步拒绝");
		};
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = fireReview(registered);
		await command.handler("", ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "settled");
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	}, 20_000);

	// 持久化失败不能被当成成功继续，否则会拿不一致的状态起审查会话、投反馈。
	test("a checkpoint write failure stops the review instead of pressing on", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.appendEntry = () => {
			throw new Error("会话写入失败");
		};
		registerReview(pi as never);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager, false);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = fireReview(registered);
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).toContain("写入失败");
		// 没有落盘，也没有把审查推进下去
		expect(checkpoints(sessionManager)).toHaveLength(0);

		// 失败必须连内存态一起释放：否则幽灵审查只是从磁盘搬进内存，
		// 后续命令永远被「已有审查在进行中」挡住且无处取消。
		notices.length = 0;
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).not.toContain("已有审查在进行中");
	});
});
