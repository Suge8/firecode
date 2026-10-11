import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import { loadFirecodeModule, featuresOnly, TEST_REVIEW_CONFIG } from "./loader.ts";

type RegisterReview = typeof import("../review/index.js").registerReview;
type CheckpointModule = typeof import("../review/checkpoint.js");
type InitialState = typeof import("../review/state.js").initialState;

let registerReview: RegisterReview;
let CheckpointWriter: CheckpointModule["CheckpointWriter"];
let readCheckpoint: CheckpointModule["readCheckpoint"];
let initialState: InitialState;

/** 迁移是同步的；让出事件循环两拍，等已完成的会话 Promise 把结果回灌进来。 */
const flush = async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
};

async function loadAll() {
	registerReview = ((await loadFirecodeModule("review/index.js")) as { registerReview: RegisterReview }).registerReview;
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule;
	({ CheckpointWriter, readCheckpoint } = checkpoint);
	initialState = ((await loadFirecodeModule("review/state.js")) as { initialState: InitialState }).initialState;
}

/** 把一份状态当作上次会话留下的 checkpoint 写进会话记录。 */
function seed(pi: { appendEntry: (type: string, data: unknown) => void }, state: ReturnType<InitialState>) {
	new CheckpointWriter(pi as never).write(state);
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
		get sentOptions() { return fake.sent.map(({ options }) => options); },
		get userMessages() { return fake.userMessages; },
		get emitted() { return fake.emitted.map(([name, data]) => ({ name, data })); },
	};
	return { pi: fake.pi, registered };
}

async function loadReviewWithVerdict(
	verdict: string,
	maxRounds?: number,
	{ top = {}, onSession }: { top?: Record<string, unknown>; onSession?: (options: { prompt: { system: string; user: string } }) => void } = {},
) {
	const review = (await loadFirecodeModule("review/index.js", {
		configJsonc: reviewConfig({
			reviewers: ["p/one/low"],
			...(maxRounds === undefined ? {} : { maxRounds }),
		}, top),
	})) as { registerReview: (pi: unknown, options?: unknown) => void };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		readCheckpoint: (ctx: unknown) => { phase: string; repair?: { status: string } | null } | undefined;
	};
	const outcome = (await loadFirecodeModule("review/outcome.js")) as {
		readReviewOutcome: (sessionPath: string) => { status: string; rounds?: number };
	};
	return {
		...checkpoint,
		...outcome,
		registerReview: (pi: unknown) => review.registerReview(pi, {
			runSession: async (options: { prompt: { system: string; user: string } }) => {
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

/** 宿主按前门送达的最近一条用户消息开回合：agent_start，随后记录这条用户消息（deliver 以此确认送达）；让出一拍，等确认推进的迁移落定（真实回合里模型请求远比这长）。 */
async function startTurn(registered: ReturnType<typeof makePi>["registered"], ctx: unknown, content = registered.userMessages.at(-1)) {
	await registered.fire("agent_start", {}, ctx);
	await registered.fire("message_start", { message: { role: "user", content } }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
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
		expect(state?.history.at(-1)?.error).toContain("system prompt 为空");
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
		await until(() => registered.userMessages.length > 0);
		expect(systems[0]).toContain("You are an independent adversarial reviewer");
		const sent = registered.sent as { customType?: string; content?: string }[];
		const card = sent.filter((message) => message.customType === "firecode-review-card").map((message) => message.content).join("\n");
		expect(card).toContain("Models: one");
		expect(card).toContain("Review passed");
		expect(card).toContain("Elapsed:");
		const summary = registered.userMessages[0] ?? "";
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
		// 质量裁决落地 → 总结提示经前门送出（回合尚未开始，仍是 pending），占用仍持有。
		await until(() => registered.userMessages.length > 0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		expect(readCheckpoint({ sessionManager })?.turn).toBe("pending");
		const held = (registered.emitted as { data: { active: boolean; progress?: () => unknown } }[]).findLast((event) => event.data.active);
		expect(held?.data.progress?.()).toMatchObject({ stage: "summarizing" });
		const card = (registered.sent as { customType?: string; content?: string }[]).find((message) => message.customType === "firecode-review-card");
		expect(card?.content?.startsWith("<firecode_review>\n")).toBe(true);
		expect(card?.content?.endsWith("\n</firecode_review>")).toBe(true);
		const summary = registered.userMessages[0];
		expect(summary.startsWith("<firecode_review>\n")).toBe(true);
		expect(summary).toContain("对抗审查已通过");
		expect(summary).toContain("不要修改代码");
		expect(summary.endsWith("\n</firecode_review>")).toBe(true);
		expect(registered.emitted).toEqual([OCCUPIED]);
		// 总结回合开始（送达确认）→ running；回合结束 → settled，占用释放。
		await startTurn(registered, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.turn).toBe("running");
		await registered.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "settled");
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
				expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
	}, 20_000);

	test("the reviewer's evidence leaves out the review's own envelopes, whether custom messages or front-door user messages", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const prompts: string[] = [];
		const { registerReview, readCheckpoint } = await loadReviewWithVerdict(verdict, undefined, { onSession: (options) => prompts.push(options.prompt.user) });
		const sessionManager = makeSessionManager();
		const message = (role: string, content: string) => ({ type: "message", message: { role, content } });
		sessionManager.entries.push(
			message("user", "实现登录续期"),
			message("user", "<firecode_review>\n本轮审查未通过，请修复：旧反馈正文\n</firecode_review>"),
			{ type: "custom_message", customType: "firecode-review-card", content: "<firecode_review>\n补投的反馈正文\n</firecode_review>", display: true },
			message("user", "<firecode_master_event>\nfix-auth 已返回\n</firecode_master_event>"),
		);
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => readCheckpoint({ sessionManager })?.phase === "summarizing");
		expect(prompts[0]).toContain("实现登录续期");
		expect(prompts[0]).toContain("fix-auth 已返回");
		expect(prompts[0]).not.toContain("旧反馈正文");
		expect(prompts[0]).not.toContain("补投的反馈正文");
	}, 20_000);

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
		await until(() => registered.userMessages.length > 0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		await startTurn(registered, ctx);
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
			registerReview: (pi: unknown, options?: unknown) => void;
		};
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi, {
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
		await flush();
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
		})) as { registerReview: (pi: unknown) => void };
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi);
		const ctx = makeCtx(sessionManager, true);
		const command = fireReview(registered);
		await command.handler("--unknown=value", ctx);
		expect(ctx.notices).toContain("Invalid fire-review arguments.");
		await command.handler("focus", ctx);
		await flush();
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
		seed(pi, state);
		registerReview(pi as never, { enabled: false });
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
		seed(pi, state);
		// features 整节类型错误被安全回退成全关，但那是配置坏而非用户关闭：不得封存。
		registerReview(pi as never, { enabled: false, configBroken: true });
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
		registerReview(first.pi as never, {
			runSession: () => new Promise(() => {}),
		});
		registerReview(second.pi as never, {
			runSession: () => new Promise(() => {}),
		});
		const ctxA = makeCtx(a);
		const ctxB = makeCtx(b);
		const command = (registered: ReturnType<typeof makePi>["registered"]) =>
			registered.commands.get("fire-review") as { handler: (args: string, ctx: unknown) => Promise<void> };
		await command(first.registered).handler("", ctxA);
		await flush();
		await command(second.registered).handler("", ctxB);
		await flush();
		expect(ctxA.notices).toEqual([]);
		expect(ctxB.notices).toEqual([]);
		const stateA = readCheckpoint({ sessionManager: a });
		const stateB = readCheckpoint({ sessionManager: b });
		expect(stateA?.phase).toBe("reviewing");
		expect(stateB?.phase).toBe("reviewing");
		expect(stateA?.runId).not.toBe(stateB?.runId);
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

		// 4. 恢复后的审查正常处理后续事件：quit 关闭 → CANCEL 落终态
		await registered2.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(registered2.emitted).toEqual([OCCUPIED, RELEASED]);
	});

	test("headless reload immediately settles a Review Run whose persisted overall deadline elapsed", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		seed(pi, {
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
				version: 7,
				runId: "g",
				phase: "reviewing",
				round: 1,
				focus: "",
				history: [],
				slots: [{ model: "m", thinking: "high", result: null }],
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
			registerReview: (pi: unknown, options?: unknown) => void;
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
		seed(pi, {
			...initialState("restore-review"),
			phase: "reviewing",
			round: 1,
			slots: [{ model: "p/one", thinking: "low", result: null }],
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		module.registerReview(pi, {
			runSession: async () => {
				await writeFile(marker, "started");
				return { kind: "empty" };
			},
		});
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await registered.fire("session_start", {}, ctx);
		await flush();
		expect(existsSync(marker)).toBe(false);

		// 模拟后续 master handler 异步等待后触发续跑；post-session 事件此时才到。
		ctx.setIdle(false);
		await registered.fire("resources_discover", {}, ctx);
		await flush();
		expect(existsSync(marker)).toBe(false);

		ctx.setIdle(true);
		await registered.fire("agent_settled", {}, ctx);
		await reviewSettled;
		expect(existsSync(marker)).toBe(true);
		await rm(marker, { force: true });
	});

	test("reload before the repair turn starts re-delivers feedback without advancing the round", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		seed(pi, {
			...initialState("restore-repair"),
			phase: "awaiting_fix",
			round: 1,
			turn: "running",
			history: [{ round: 1, result: "failed", reviewers: [{ index: 0, model: "p/one", thinking: "low", status: "failed", summary: "s", details: "FAIL" }], elapsedMs: 1 }],
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager);
		await registered.fire("session_start", {}, ctx);
		ctx.setIdle(false);
		await flush();
		expect(readCheckpoint({ sessionManager })?.turn).toBe("pending");
		expect(registered.userMessages).toHaveLength(0);

		ctx.setIdle(true);
		await registered.fire("resources_discover", {}, ctx);
		await flush();
		const restored = readCheckpoint({ sessionManager });
		expect(restored?.phase).toBe("awaiting_fix");
		expect(restored?.round).toBe(1);
		expect(restored?.turn).toBe("pending");
		expect(registered.userMessages).toHaveLength(1);
		expect(registered.userMessages[0]).toContain("<firecode_review>");
		// 回合开始、这条用户消息被记录：送达确认，pending → running。
		await startTurn(registered, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.turn).toBe("running");
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

	// 前门唤起以消息送达为回执、没有计时器：回执迟迟不来也不取消；重复的推进请求不重复投递。
	// 宿主没接这条消息、下一个回合是用户自己的话时，反馈改走 steer 补投，同样算送达。
	test("feedback is delivered once and waits for the turn to start; a foreign first message falls back to steer", async () => {
		const { registerReview, readCheckpoint } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager, false);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.userMessages.length > 0);
		for (let turn = 0; turn < 3; turn += 1) {
			await registered.fire("agent_settled", {}, ctx);
			await flush();
		}
		expect(registered.userMessages).toHaveLength(1);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("awaiting_fix");
		expect(readCheckpoint({ sessionManager })?.turn).toBe("pending");

		await startTurn(registered, ctx, "用户自己的话");
		await flush();
		expect(registered.sent.map((message) => (message as { content: string }).content)).toContain(registered.userMessages[0]);
		expect(readCheckpoint({ sessionManager })?.turn).toBe("running");
	}, 20_000);

	test("a synchronous feedback failure cancels the review", async () => {
		const { registerReview, readCheckpoint } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendUserMessage = () => {
			throw new Error("同步拒绝");
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

describe("review cards and degraded paths", () => {
	// 超时发生在执行模型忙的时候：卡不能被压在队列里发不出去，也不能打断当前回合。
	test("an overall timeout while the executor is busy still posts the timeout card without waking the model", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		seed(pi, {
			...initialState("expired-run"),
			phase: "awaiting_fix",
			turn: "running",
			round: 1,
			startedAt: Date.now() - 500 * 60_000,
			updatedAt: Date.now() - 500 * 60_000,
		} as never);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		await registered.fire("session_start", {}, ctx);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(registered.sent).toHaveLength(1);
		expect((registered.sent[0] as { content: string }).content).toContain("审查超时");
		expect(registered.sentOptions[0]).toEqual({ triggerTurn: false });
		expect(registered.userMessages).toHaveLength(0);
	});

	// 以 FAIL 开头的票格式再差也是阻断意见：另一票 PASS 不能让整轮通过，原文随反馈交给执行模型。
	test("a malformed FAIL beats another reviewer's PASS and its original text reaches the executor", async () => {
		const { registerReview, readCheckpoint } = await loadTwoReviewers((model) =>
			model === "p/one" ? "FAIL\n没按模板写，但数据会丢：重启后 checkpoint 被覆盖" : "PASS\n核对完毕。\n证据：文件=a.ts；命令=bun test",
		);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.userMessages.length > 0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("awaiting_fix");
		expect(registered.userMessages[0]).toContain("数据会丢：重启后 checkpoint 被覆盖");
		const card = registered.sent.map((message) => (message as { content: string }).content).find((content) => content.includes("审查未通过"));
		expect(card).toContain("数据会丢");
	}, 20_000);

	test("an unavailable advisor is skipped with a visible card and the repair carries on", async () => {
		const { registerReview, readCheckpoint } = await loadTwoReviewers((model) =>
			model === "test/advisor" ? undefined : "FAIL\n## 发现 1\n- 严重程度: 高\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test",
		);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.userMessages.length === 1);
		await startTurn(registered, ctx);
		await registered.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await registered.fire("agent_settled", {}, ctx);
		// 第二轮仍未通过，到顾问阈值；顾问会话没有产出。
		await until(() => registered.userMessages.length === 2);
		const cards = registered.sent.map((message) => (message as { content: string }).content);
		expect(cards.some((content) => content.includes("顾问不可用，已跳过"))).toBe(true);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("awaiting_fix");
		expect(registered.userMessages[1]).toContain("<firecode_review>");
	}, 20_000);

	// 修复回合里被取消：末轮是 failed，Master 不能把它读成“轮数用尽”。
	test("cancelling during the repair turn is reported to the Master as cancelled, not as rounds exhausted", async () => {
		const { registerReview, readCheckpoint, readReviewOutcome } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		await fireReview(registered).handler("", ctx);
		await until(() => registered.userMessages.length > 0);
		await startTurn(registered, ctx);
		expect(readCheckpoint({ sessionManager })?.turn).toBe("running");
		await registered.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		const sessionPath = join(tmpdir(), `review-outcome-${randomUUID()}.jsonl`);
		await writeFile(sessionPath, sessionManager.entries.map((entry) => JSON.stringify(entry)).join("\n"));
		expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "failed", rounds: 1, reason: "审查被取消" });
		await rm(sessionPath, { force: true });
	}, 20_000);

	// 持久化失败的收口曾漏掉界面：输入框一直被锁，连再开一场审查的命令都敲不进去。
	test("a checkpoint write failure hands the editor and the occupancy back", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const append = pi.appendEntry;
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const editors: unknown[] = [];
		ctx.ui.setEditorComponent = (factory: unknown) => { editors.push(factory); };
		await fireReview(registered).handler("", ctx);
		expect(editors).toHaveLength(1);
		expect(editors[0]).toBeTypeOf("function");
		pi.appendEntry = () => { throw new Error("磁盘满了"); };
		ctx.setIdle(true);
		await registered.fire("agent_settled", {}, ctx);
		pi.appendEntry = append;
		expect(editors.at(-1)).toBeUndefined();
		expect(registered.emitted.at(-1)).toEqual(RELEASED);
		expect(ctx.notices.join()).toContain("写入失败");
	});
});

/** 两个审查者（p/one、p/two）加顾问；answer 按模型给出会话输出，返回 undefined 表示该会话没有产出。 */
async function loadTwoReviewers(answer: (model: string) => string | undefined) {
	const review = (await loadFirecodeModule("review/index.js", {
		configJsonc: reviewConfig({ reviewers: ["p/one/low", "p/two/low"], maxRounds: 3 }),
	})) as { registerReview: (pi: unknown, options?: unknown) => void };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as CheckpointModule;
	return {
		readCheckpoint: checkpoint.readCheckpoint,
		registerReview: (pi: unknown) => review.registerReview(pi, {
			runSession: async ({ config }: { config: { model: string } }) => {
				const text = answer(config.model);
				return text === undefined ? { kind: "error", message: "额度不足" } : { kind: "output", text };
			},
		}),
	};
}
