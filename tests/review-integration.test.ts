import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerResult } from "../review/state.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type RegisterReview = typeof import("../review/index.js").registerReview;
type Flush = typeof import("../review/index.js").__reviewFlushForTests;
type WriteCheckpoint = typeof import("../review/checkpoint.js").writeCheckpoint;
type BeginCheckpoint = typeof import("../review/checkpoint.js").beginCheckpoint;
type ReadCheckpoint = typeof import("../review/checkpoint.js").readCheckpoint;
type CheckpointConflictError = typeof import("../review/checkpoint.js").CheckpointConflictError;
type InitialState = typeof import("../review/state.js").initialState;

let registerReview: RegisterReview;
let flush: Flush;
let writeCheckpoint: WriteCheckpoint;
let beginCheckpoint: BeginCheckpoint;
let readCheckpoint: ReadCheckpoint;
let CheckpointConflictErrorCtor: CheckpointConflictError;
let initialState: InitialState;

async function loadAll() {
	const index = (await loadFirecodeModule("review/index.js")) as {
		registerReview: RegisterReview;
		__reviewFlushForTests: Flush;
	};
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		writeCheckpoint: WriteCheckpoint;
		beginCheckpoint: BeginCheckpoint;
		readCheckpoint: ReadCheckpoint;
		CheckpointConflictError: CheckpointConflictError;
	};
	const state = (await loadFirecodeModule("review/state.js")) as { initialState: InitialState };
	registerReview = index.registerReview;
	flush = index.__reviewFlushForTests;
	writeCheckpoint = checkpoint.writeCheckpoint;
	beginCheckpoint = checkpoint.beginCheckpoint;
	readCheckpoint = checkpoint.readCheckpoint;
	CheckpointConflictErrorCtor = checkpoint.CheckpointConflictError;
	initialState = state.initialState;
}

afterEach(cleanupFirecodeModules);

function makeSessionManager() {
	const entries: unknown[] = [];
	return {
		entries,
		getBranch: () => [...entries],
		getEntries: () => [...entries],
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	};
}

type MockSessionManager = ReturnType<typeof makeSessionManager>;

function makeCtx(sessionManager: MockSessionManager, busy = false) {
	let idle = !busy;
	return {
		hasUI: true,
		cwd: "/tmp/firecode-test",
		sessionManager,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		setIdle: (value: boolean) => {
			idle = value;
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
		},
	};
}

function makePi(sessionManager: MockSessionManager) {
	const registered: {
		renderers: Map<string, unknown>;
		commands: Map<string, unknown>;
		shortcuts: Map<string, unknown>;
		events: Map<string, ((...args: unknown[]) => unknown)[]>;
		sent: unknown[];
		emitted: { name: string; data: unknown }[];
	} = {
		renderers: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		events: new Map(),
		sent: [],
		emitted: [],
	};
	const pi = {
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			registered.renderers.set(customType, renderer);
		},
		registerCommand: (name: string, options: unknown) => {
			registered.commands.set(name, options);
		},
		registerShortcut: (key: string, options: unknown) => {
			registered.shortcuts.set(key, options);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			registered.events.set(event, [...(registered.events.get(event) ?? []), handler]);
		},
		sendMessage: (message: unknown) => {
			registered.sent.push(message);
		},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		events: {
			emit: (name: string, data: unknown) => registered.emitted.push({ name, data }),
		},
	};
	return { pi, registered };
}

function reviewer(index: number, status: ReviewerResult["status"], details: string): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary: "s", details };
}

async function loadSingleFailReview() {
	const script = join(tmpdir(), `fake-pi-${Date.now()}-${Math.random()}.sh`);
	const verdict = [
		"FAIL",
		"## 发现 1",
		"- 严重程度: 中",
		"- 问题: x",
		"- 证据: a.ts",
		"- 违反的契约或期望行为: y",
		"- 需要运行的验证命令: bun test",
	].join("\\n");
	await writeFile(
		script,
		`#!/bin/bash\nprintf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${verdict}"}]}}'\n`,
		{ mode: 0o755 },
	);
	const review = (await loadFirecodeModule("review/index.js", {
		configJsonc: JSON.stringify({
			review: {
				reviewers: [{ model: "p/one", thinking: "low" }],
				background: { command: script },
			},
		}),
	})) as { registerReview: (pi: unknown) => void };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
	};
	return { ...review, ...checkpoint, script };
}

describe("registerReview wiring", () => {
	test("registers the card renderer eagerly (top level, not in session_start)", async () => {
		await loadAll();
		const { pi, registered } = makePi(makeSessionManager());
		registerReview(pi as never);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.renderers.size).toBe(1);
	});

	test("registers the fire-review command and session lifecycle events", async () => {
		await loadAll();
		const { pi, registered } = makePi(makeSessionManager());
		registerReview(pi as never);
		expect(registered.commands.has("fire-review")).toBe(true);
		expect(registered.events.has("session_start")).toBe(true);
		expect(registered.events.has("agent_settled")).toBe(true);
		expect(registered.events.has("agent_end")).toBe(true);
		expect(registered.events.has("session_shutdown")).toBe(true);
	});

	test("does not send cards or start reviewers before the current run is fully settled", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};

		await command.handler("", ctx);
		await flush();
		// streaming 时 sendMessage 会成为 steer；零发送是不能打断当前回复的关键合同。
		expect(registered.sent).toHaveLength(0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		ctx.setIdle(true);
		for (const handler of registered.events.get("agent_settled") ?? [])
			await handler({}, ctx);
		// 模拟同一 agent_settled 上后注册的 master handler 立即触发 follow-up。
		ctx.setIdle(false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		expect(registered.sent).toHaveLength(0);

		// follow-up 真正 settled 后才允许审查启动。
		ctx.setIdle(true);
		for (const handler of registered.events.get("agent_settled") ?? [])
			await handler({}, ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
		expect(registered.sent.length).toBeGreaterThan(0);
	});

	test("the FireCode entry keeps the renderer when every feature is disabled", async () => {
		const entry = (await loadFirecodeModule("index.js", {
			configJsonc: JSON.stringify({
				features: {
					header: false,
					statusbar: false,
					tools: false,
					presets: false,
					rename: false,
					stats: false,
					claudeSub: false,
					openaiNative: false,
					review: false,
					master: false,
				},
			}),
		})) as { default: (pi: unknown) => void };
		const { pi, registered } = makePi(makeSessionManager());
		entry.default(pi);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.commands.size).toBe(0);
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
		beginCheckpoint(pi as never, { sessionManager } as never, state);
		registerReview(pi as never, false);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.commands.has("fire-review")).toBe(false);
		for (const handler of registered.events.get("session_start") ?? [])
			await handler({}, makeCtx(sessionManager));
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});
});

describe("checkpoint persistence", () => {
	test("write then read round-trips; a remembered-expected mismatch is a conflict", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi } = makePi(sessionManager);
		const ctx = { sessionManager };
		const state = initialState("gen-1");
		// 首次写用 beginCheckpoint（无条件替换旧终态），返回本次写入凭证
		const first = beginCheckpoint(pi as never, ctx, state);
		expect(readCheckpoint(ctx)?.generation).toBe("gen-1");
		expect(first).toEqual({ generation: "gen-1", seq: 1 });

		// 后续写带凭证（本 controller 记住的上一次写入）；匹配则成功且 seq 递增
		const next = { ...state, phase: "queued" as const, updatedAt: 5 };
		const second = writeCheckpoint(pi as never, ctx, next, first);
		expect(readCheckpoint(ctx)?.phase).toBe("queued");
		expect(second.seq).toBe(2);

		// 陈旧写者：generation 相同但 seq 落后 —— 只比 generation 时无法识别，必须拒绝
		expect(() => writeCheckpoint(pi as never, ctx, next, first)).toThrow(
			CheckpointConflictErrorCtor,
		);

		// 另一场审查的凭证同样冲突
		expect(() =>
			writeCheckpoint(pi as never, ctx, next, { generation: "gen-9", seq: 2 }),
		).toThrow(CheckpointConflictErrorCtor);
	});

	test("real persist path detects a concurrent checkpoint writer and stops the review", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const commandHandler = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdownHandler = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;

		// 1. 排队开始审查（busy）→ 首次写落 g1
		await commandHandler.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.generation).toBeTruthy();
		const firstGeneration = readCheckpoint({ sessionManager })?.generation;

		// 2. 模拟并发写者塞入不同 generation 的 checkpoint
		sessionManager.appendCustomEntry("firecode-review-checkpoint", {
			version: 1,
			seq: 1,
			generation: "foreign-writer",
			phase: "queued",
			round: 0,
			focus: "",
			history: [],
			active: null,
			pending: null,
			consecutiveFailures: 0,
			startedAt: 1,
			roundStartedAt: 1,
			updatedAt: 1,
		});

		// 3. quit 关闭 → CANCEL 落盘时撞上外来 generation → 冲突 → 停写并通知
		await shutdownHandler({ type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.generation).toBe("foreign-writer");
		expect(firstGeneration).toBeTruthy();
	});
});

describe("reload preserves recoverable state", () => {
	test("reload shutdown keeps the checkpoint active; session_start restores it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const commandHandler = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdownHandler = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: string },
			ctx: unknown,
		) => unknown;
		const sessionStartHandler = (registered.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;

		// 1. 排队开始审查（queued），checkpoint 落成 queued
		await commandHandler.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		const generation = readCheckpoint({ sessionManager })?.generation;

		// 2. reload 关闭：不 settle，checkpoint 保持 queued（可恢复）
		await shutdownHandler({ type: "session_shutdown", reason: "reload" }, ctx);
		await flush();
		const afterReload = readCheckpoint({ sessionManager });
		expect(afterReload?.phase).toBe("queued");
		expect(afterReload?.generation).toBe(generation);

		// 3. 新会话（同一 session 文件，新 pi 实例）session_start：从 checkpoint 恢复
		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2 as never);
		const sessionStartHandler2 = (registered2.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		const shutdownHandler2 = (registered2.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;
		await sessionStartHandler2({ type: "session_start", reason: "reload" }, ctx);
		await flush();

		// 4. 恢复后的 controller 正常处理后续事件：quit 关闭 → CANCEL 落终态
		await shutdownHandler2({ type: "session_shutdown", reason: "quit" }, ctx);
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

	test("the command refuses to start and spawns nothing", async () => {
		const { registerReview } = await loadWithConfig(brokenConfig);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(notices.join()).toContain("配置有问题");
		// 没有写入任何 checkpoint，等于没有启动审查
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("an unknown review field also blocks the command", async () => {
		const { registerReview } = await loadWithConfig(`{ "review": { "reviewerz": [] } }`);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("an unparsable config file also blocks the command", async () => {
		const { registerReview } = await loadWithConfig(unparsableConfig);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(notices.join()).toContain("配置有问题");
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("recovery from an active checkpoint refuses too", async () => {
		const { registerReview } = await loadWithConfig(brokenConfig);
		const sessionManager = makeSessionManager();
		sessionManager.entries.push({
			type: "custom",
			customType: "firecode-review-checkpoint",
			data: {
				version: 1,
				seq: 1,
				generation: "g",
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
		const handler = (registered.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>;
		await handler({ type: "session_start", reason: "startup" }, ctx);
		expect(notices.join()).toContain("配置有问题");
		// 恢复被拒后不得追加新 checkpoint（即没有接管这场审查）
		expect(sessionManager.entries).toHaveLength(1);
	});
});

describe("reload recovery actually resumes the loop", () => {
	// reload 不产生 agent_end，而 queued / awaiting_fix 正是在等这个事件。
	// 不在 session_start 推进的话，会话一空闲审查就永远停在活动态，还会挡住新的 /fire-review。
	test("a queued review resumes on session_start when the session is idle", async () => {
		const { registerReview } = (await loadFirecodeModule("review/index.js", {
			// 子进程立即退出：只验证循环是否真的被推进，不依赖模型
			configJsonc: `{ "review": { "background": { "command": "/usr/bin/true" } } }`,
		})) as { registerReview: (pi: unknown) => void };
		const checkpointModule = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const busyCtx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", busyCtx);
		await flush();
		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).toBe("queued");

		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: string },
			ctx: unknown,
		) => unknown;
		await shutdown({ type: "session_shutdown", reason: "reload" }, busyCtx);
		await flush();

		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2);
		const sessionStart = (registered2.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		// 关键：reload 后会话空闲，没有任何 agent_end 会到来
		await sessionStart({ type: "session_start", reason: "reload" }, makeCtx(sessionManager, false));
		await flush();
		await flush();

		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
	});
});

test("a terminal review infrastructure error is reported to the owning control plane", async () => {
	const module = (await loadFirecodeModule("review/index.js", {
		configJsonc: `{ "review": { "reviewers": [{ "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }], "background": { "command": "/usr/bin/true" } } }`,
	})) as { registerReview: (pi: unknown) => void };
	const sessionManager = makeSessionManager();
	const { pi, registered } = makePi(sessionManager);
	let cards = 0;
	pi.sendMessage = () => {
		cards += 1;
		if (cards === 2) throw new Error("terminal card failed");
	};
	const settled = new Promise<unknown>((resolve) => {
		pi.events.emit = (name: string, data: unknown) => {
			registered.emitted.push({ name, data });
			if (name === "firecode:review-settled") resolve(data);
		};
	});
	module.registerReview(pi);
	const command = registered.commands.get("fire-review") as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	await command.handler("", makeCtx(sessionManager, false));
	expect(await settled).toMatchObject({ passed: false });
	expect(cards).toBe(2);
});

describe("the loop survives failing side effects", () => {
	// dispatchQueue 一旦 rejected 就再也不执行后续迁移，连 esc 取消都会失效。
	test("a throwing send keeps later dispatches (including cancel) working", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		let failNextSend = true;
		pi.sendMessage = () => {
			if (!failNextSend) return;
			failNextSend = false;
			throw new Error("UI 挂了");
		};
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;

		// 启动时发卡抛错：不能让状态机就此死掉
		await command.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		// 后续迁移仍然生效 → quit 能把审查收成终态
		await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	// 一个 effect 抛错不能吞掉同一迁移里后续的推进动作：
	// 发卡失败若连带跳过 start_reviewers，就会停在「审查中但没有模型在跑」的假活动态。
	test("a failing card does not swallow the effects after it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = () => {
			throw new Error("UI 挂了");
		};
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, false) as never;
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		// 启动卡发送失败，但本轮仍进入 reviewing（后续 effect 没被跳过）
		expect(readCheckpoint({ sessionManager })?.phase).toBe("reviewing");
	});

	// 宿主 sendMessage 返回 void，异步失败不会 throw；必须靠 agent_start 回执超时收口，
	// 不能用同步 throw 的假 API 制造假覆盖。
	test("feedback without an agent_start receipt cancels instead of stranding awaiting_fix", async () => {
		const { registerReview, readCheckpoint, script } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		// 与真实宿主一致：调用立即返回 void，异步失败不会反馈给插件，也没有 agent_start。
		registerReview(pi);
		const ctx = makeCtx(sessionManager, false);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 40; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(
			registered.sent.some(
				(message) => (message as { customType?: string }).customType === "firecode-review-feedback",
			),
		).toBe(true);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		await rm(script, { force: true });
	}, 15_000);

	test("a synchronous feedback failure cancels without dispatchQueue self-deadlock", async () => {
		const { registerReview, readCheckpoint, script } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = (message: { customType?: string }) => {
			if (message.customType === "firecode-review-feedback") throw new Error("同步拒绝");
		};
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 20; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		await rm(script, { force: true });
	});

	// 持久化失败不能被当成成功继续，否则会拿不一致的状态起子进程、投反馈。
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
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).toContain("写入失败");
		// 没有落盘，也没有把审查推进下去
		expect(sessionManager.entries).toHaveLength(0);

		// 失败必须连内存态一起释放：否则幽灵审查只是从磁盘搬进内存，
		// 后续命令永远被「已有审查在进行中」挡住且无处取消。
		notices.length = 0;
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).not.toContain("已有审查在进行中");
	});
});
