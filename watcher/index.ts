/**
 * Watcher 观察员：每个 turn 结束后异步评估主会话增量，要么沉默，要么发一条建议。
 * 与 Master、fire-review 各自独立注册；观察过程不落盘。
 */
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { watchBusy } from "../busy.js";
import { loadConfig } from "../config.js";
import { deliver } from "../deliver.js";
import { msg as rootMsg } from "../messages.js";
import type { InProcessSessionPool } from "../spawn.js";
import { STATUS_KEYS } from "../status-keys.js";
import {
	adviceMessage,
	registerWatcherCardRenderer,
	WATCHER_MESSAGE_TYPE,
	type WatcherCard,
} from "./card.js";
import { msg } from "./messages.js";
import { createObserver, type Observer } from "./observer.js";
import { renderTurn } from "./transcript.js";

/** 观察会话自身上下文占比超过此值即重建。 */
const CONTEXT_RESET_PERCENT = 70;

interface WatcherRuntime {
	ctx: ExtensionContext;
	pending: string[];
	lastTurnIndex: number;
	evaluating: boolean;
	observer?: Observer;
}

export function registerWatcher(pi: ExtensionAPI, pool: InProcessSessionPool): void {
	registerWatcherCardRenderer(pi);
	const loaded = loadConfig().watcher;
	// 配置有问题时拒绝启动：静默回退会拿用户没配的模型真实发起观察。
	if ("error" in loaded) {
		pi.registerCommand("fire-watch", {
			description: msg.command,
			handler: async (args, ctx) => ctx.ui.notify(args.trim() ? msg.noArguments : loaded.error, "error"),
		});
		return;
	}
	const config = loaded.config;
	let runtime: WatcherRuntime | undefined;
	let reviewActive = false;
	/** 还没送达的最近一条发言；只有一条在途，新建议或会话失效时中止它。 */
	let speaking: AbortController | undefined;
	const supersede = () => {
		speaking?.abort(new DOMException("superseded", "AbortError"));
		speaking = undefined;
	};

	const deactivate = (owner = runtime) => {
		if (!owner || runtime !== owner) return;
		supersede();
		runtime = undefined;
		owner.observer?.dispose();
		owner.observer = undefined;
		owner.ctx.ui.setStatus(STATUS_KEYS.watcher, undefined);
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
		ctx.ui.setStatus(STATUS_KEYS.watcher, ctx.ui.theme.fg("dim", msg.statusLabel));
		return owner;
	};
	// 与指挥官事件同构，经 deliver.ts 投递：忙时句缝送达，歇透时唤起。
	// 建议是当下的第二意见，过时重投没有价值：发言不阻塞评估循环，新建议、压缩或会话失效时中止上一条未送达的，
	// 它不再补投；投递失败只丢弃这一条并提示，观察员照常工作（Master 事件则重试）。
	const speak = (owner: WatcherRuntime, note: string, turnIndex: number) => {
		supersede();
		const controller = speaking = new AbortController();
		const ctx = owner.ctx;
		const card: WatcherCard = { note, turnIndex };
		deliver(pi, ctx, { customType: WATCHER_MESSAGE_TYPE, content: adviceMessage(card) }, controller.signal)
			.catch((error) => {
				if (controller.signal.aborted || runtime?.ctx !== ctx) return;
				ctx.ui.notify(msg.deliveryFailed(error instanceof Error ? error.message : String(error)), "warning");
			})
			.finally(() => {
				if (speaking === controller) speaking = undefined;
			});
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
					if (runtime !== owner) return;
					observer = await createObserver({
						cwd,
						chain: config.models,
						pool,
						onExtensionError: (error) => {
							if (runtime === owner) owner.ctx.ui.notify(rootMsg.spawn.extensionFailed(error.event, error.error), "warning");
						},
					});
					if (runtime !== owner) {
						await observer.dispose();
						return;
					}
					owner.observer = observer;
				}
				const advice = await observer.evaluate(increment);
				if (runtime !== owner) return;
				if (advice) speak(owner, advice, turnIndex);
				// 自身上下文快满时也重新入场：观察员只需要当下，不需要完整历史。
				if ((observer.contextPercent() ?? 0) >= CONTEXT_RESET_PERCENT) resetObserver(owner);
			}
		} catch (error) {
			// 被重新入场中断的评估不算故障：下一批增量会开一个新观察会话。
			if (runtime !== owner) return;
			owner.ctx.ui.notify(msg.stopped(error instanceof Error ? error.message : String(error)), "warning");
			deactivate(owner);
		} finally {
			owner.evaluating = false;
		}
	};

	pi.registerCommand("fire-watch", {
		description: msg.command,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(msg.noArguments, "error");
				return;
			}
			if (runtime) {
				deactivate();
				ctx.ui.notify(msg.disabled, "info");
				return;
			}
			activate(ctx);
			ctx.ui.notify(msg.enabled, "info");
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
	watchBusy(pi, {
		onChange: (view) => {
			const wasActive = reviewActive;
			reviewActive = view.review !== undefined;
			const active = runtime;
			if (!wasActive || reviewActive || !active || active.evaluating || !active.pending.length) return;
			void evaluate(active);
		},
	});

	// 主会话压缩：旧增量已不再对应主会话现场，观察员从当前尾部重新入场而不回放。
	pi.on("session_compact", () => {
		supersede();
		resetObserver();
	});
	pi.on("session_shutdown", () => deactivate());
}

