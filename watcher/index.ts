/**
 * Watcher 观察员：每个 turn 结束后异步评估主会话增量，要么沉默，要么发一条建议。
 * 与 Master、fire-review 各自独立注册；观察过程不落盘。
 */
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { deliver } from "../deliver.js";
import { InProcessSessionPool } from "../master/spawn.js";
import { OCCUPANCY_CHANNEL, type OccupancyPayload } from "../review/occupancy.js";
import {
	adviceMessage,
	registerWatcherCardRenderer,
	WATCHER_MESSAGE_TYPE,
	type WatcherCard,
} from "./card.js";
import { createObserver, type Advice, type Observer } from "./observer.js";
import { renderTurn } from "./transcript.js";

/** 观察会话自身上下文占比超过此值即重建。 */
const CONTEXT_RESET_PERCENT = 70;

interface WatcherDependencies {
	pool?: InProcessSessionPool;
	createObserver?: typeof createObserver;
}

interface WatcherRuntime {
	ctx: ExtensionContext;
	pending: string[];
	lastTurnIndex: number;
	evaluating: boolean;
	observer?: Observer;
}

export function registerWatcher(
	pi: ExtensionAPI,
	dependencies: WatcherDependencies = {},
	subsession = false,
): void {
	// 子会话不带观察员：级联抑制是代码规则，不靠进程环境。
	if (subsession) return;
	registerWatcherCardRenderer(pi);
	const loaded = loadConfig().watcher;
	// 配置有问题时拒绝启动：静默回退会拿用户没配的模型真实发起观察。
	if ("error" in loaded) {
		pi.registerCommand("fire-watch", {
			description: "翻转当前会话的观察员开关",
			handler: async (args, ctx) => ctx.ui.notify(args.trim() ? "/fire-watch 不接受参数" : loaded.error, "error"),
		});
		return;
	}
	const config = loaded.config;
	const pool = dependencies.pool ?? new InProcessSessionPool();
	const spawnObserver = dependencies.createObserver ?? createObserver;
	let runtime: WatcherRuntime | undefined;
	let reviewActive = false;

	const deactivate = (owner = runtime) => {
		if (!owner || runtime !== owner) return;
		runtime = undefined;
		owner.observer?.dispose();
		owner.observer = undefined;
		owner.ctx.ui.setStatus("watcher", undefined);
	};
	const resetObserver = (owner = runtime) => {
		if (!owner || runtime !== owner) return;
		runtime = {
			ctx: owner.ctx,
			pending: [],
			lastTurnIndex: owner.lastTurnIndex,
			evaluating: false,
		};
		owner.observer?.dispose();
		owner.observer = undefined;
	};
	const activate = (ctx: ExtensionContext): WatcherRuntime => {
		const owner = { ctx, pending: [], lastTurnIndex: 0, evaluating: false };
		runtime = owner;
		ctx.ui.setStatus("watcher", ctx.ui.theme.fg("dim", "观察员"));
		return owner;
	};
	// 与指挥官事件同构：忙时卡片经 steer 队列句缝追加，歇透时走前门唤起（见 deliver.ts）。
	// 建议是当下的第二意见，过时重投没有价值：投递失败只丢弃这一条并提示，观察员照常工作（Master 事件则重试）。
	const speak = async (owner: WatcherRuntime, advice: Advice, turnIndex: number) => {
		const card: WatcherCard = { note: advice.note, turnIndex };
		try {
			await deliver(pi, owner.ctx, { customType: WATCHER_MESSAGE_TYPE, content: adviceMessage(card) });
		} catch (error) {
			if (runtime === owner) owner.ctx.ui.notify(`观察员这条建议投递失败，已丢弃：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};
	const evaluate = async (owner: WatcherRuntime) => {
		owner.evaluating = true;
		try {
			while (runtime === owner && owner.pending.length && !reviewActive) {
				// 合并跳最新：评估期间到达的回合并进下一批，不排队补评估。
				const increment = owner.pending.splice(0).join("\n");
				const turnIndex = owner.lastTurnIndex;
				let observer = owner.observer;
				if (!observer) {
					const cwd = owner.ctx.cwd;
					const model = await pool.resolveModel(config.model);
					if (runtime !== owner) return;
					observer = await spawnObserver({ cwd, model, thinking: config.thinking, pool });
					if (runtime !== owner) {
						await observer.dispose();
						return;
					}
					owner.observer = observer;
				}
				const advice = await observer.evaluate(increment);
				if (runtime !== owner) return;
				if (advice) {
					await speak(owner, advice, turnIndex);
					if (runtime !== owner) return;
				}
				// 自身上下文快满时也重新入场：观察员只需要当下，不需要完整历史。
				if ((observer.contextPercent() ?? 0) >= CONTEXT_RESET_PERCENT) resetObserver(owner);
			}
		} catch (error) {
			// 被重新入场中断的评估不算故障：下一批增量会开一个新观察会话。
			if (runtime !== owner) return;
			owner.ctx.ui.notify(`观察员已停止：${error instanceof Error ? error.message : String(error)}`, "warning");
			deactivate(owner);
		} finally {
			owner.evaluating = false;
		}
	};

	pi.registerCommand("fire-watch", {
		description: "翻转当前会话的观察员开关",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("/fire-watch 不接受参数", "error");
				return;
			}
			if (runtime) {
				deactivate();
				ctx.ui.notify("观察员已关闭", "info");
				return;
			}
			activate(ctx);
			ctx.ui.notify("观察员已开启", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (!config.enabled) return;
		activate(ctx);
	});

	pi.on("turn_end", (event) => {
		const owner = runtime;
		if (!owner) return;
		owner.pending.push(renderTurn(event, config.context));
		owner.lastTurnIndex = event.turnIndex;
		if (!owner.evaluating && !reviewActive) void evaluate(owner);
	});

	// fire-review 活跃期静默：不与对抗审查的反馈打架，增量留着审查完合并评估。
	pi.events.on(OCCUPANCY_CHANNEL, (data) => {
		reviewActive = (data as OccupancyPayload).active;
		const active = runtime;
		if (reviewActive || !active || active.evaluating || !active.pending.length) return;
		void evaluate(active);
	});

	// 主会话压缩：旧增量已不再对应主会话现场，观察员从当前尾部重新入场而不回放。
	pi.on("session_compact", () => resetObserver());
	pi.on("session_shutdown", () => deactivate());
}

