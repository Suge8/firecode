/**
 * /goal：设一个目标，会话一轮接一轮干到完成。
 *
 * 续跑不自己调度：宿主在回合彻底结束前（agent_before_settle：重试、压缩、排队消息都处理完，被中止的回合不经过）问一次，
 * 目标还在进行就追加一句续跑并让宿主原地再跑一次请求。要自己开回合的只有三处——设目标、/goal resume、
 * 等的东西（子代理、审查）没叫醒会话就歇下——都经 deliver。
 * 状态只有会话分支上最近一条 GOAL_ENTRY：跟着分支走，恢复会话时自然还在；内存里只留两个还没落盘的计数。
 * 停由程序定：连续 IDLE_RUNS 个回合没有工具调用、回合出错、token 预算用完、回合被中断。不设次数上限：
 * 长任务的正常工作量没有上限，要防的是空转和失控花费。预算在回合中途用完时宿主没有优雅停下的口子，只在句缝提醒一次收尾。
 * 完成由证据定：模型调 goal_complete 声称完成，闸门开着就交给 review 做一场验收，通过才记完成；
 * 验收期间的修复回合不续跑，结局在会话歇下时从审查存档读（review/outcome.ts）。
 * 规则与目标原文挂在系统提示段里（压缩后还在），续跑消息只有一句；工具只在目标进行时激活，宿主把增减追加在会话后面。
 */
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { busyView, watchBusy } from "../busy.js";
import { loadConfig } from "../config.js";
import { boundaryMessage, deliver, type Delivery, inform, parseEnvelopes, wrapEnvelope } from "../deliver.js";
import { formatDuration, formatTokens, textOf } from "../format.js";
import { readPrompt } from "../i18n.js";
import { isRecord } from "../jsonc.js";
import { acceptedObjective, outcomeOfEntry } from "../review/outcome.js";
import { roundFromEntry } from "../round.js";
import { msg } from "./messages.js";

const GOAL_ENTRY = "firecode-goal";
const GOAL_CARD = "firecode-goal-card";
const TOOL = "goal_complete";
/** 连续几个回合没有工具调用就暂停：模型只是在重复汇报，或在等用户。 */
const IDLE_RUNS = 3;
const RULES = readPrompt(new URL("./prompts/", import.meta.url), "goal").trim();

interface Goal {
	objective: string;
	/** verifying：已声称完成，验收在跑。 */
	status: "active" | "verifying" | "paused" | "complete";
	/** 主会话为这个目标新处理的 token：未命中缓存的输入 + 输出。 */
	tokens: number;
	/** 连续没有工具调用的回合数。 */
	idleRuns: number;
	startedAt: number;
}

/** 以目标原文发起一场验收；被拒时返回原因。 */
type Accept = (objective: string, ctx: ExtensionContext) => string | undefined;

const live = (goal: Goal | undefined): goal is Goal => goal?.status === "active" || goal?.status === "verifying";
const card = (text: string): Delivery => ({ customType: GOAL_CARD, content: wrapEnvelope("firecode_goal", text) });
const closed = (text: string) => text.replaceAll("</goal>", "&lt;/goal&gt;");

function read(ctx: ExtensionContext): Goal | undefined {
	const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === GOAL_ENTRY);
	return entry?.type === "custom" && isRecord(entry.data) ? entry.data as unknown as Goal : undefined;
}

/**
 * accept：review 功能开着时的验收入口。返回的 focusNote 交给 review：目标进行中开的普通审查要知道目标还没做完。
 * 调用前提：配置里 goal 节可用（入口判过）。
 */
export function registerGoal(pi: ExtensionAPI, accept?: Accept): { focusNote(ctx: ExtensionContext): string | undefined } {
	const config = loadConfig().config.goal!;
	const gate = config.review ? accept : undefined;
	/** 还没写进 GOAL_ENTRY 的 token 与“这个回合调过工具”。 */
	let spent = 0;
	let ran = false;
	let nudged = false;
	let latest: ExtensionContext | undefined;
	let lifetime = new AbortController();

	const syncTool = (goal: Goal | undefined) => {
		const tools = pi.getActiveTools();
		if (tools.includes(TOOL) === live(goal)) return;
		pi.setActiveTools(live(goal) ? [...tools, TOOL] : tools.filter((name) => name !== TOOL));
	};
	const write = (goal: Goal | undefined) => {
		pi.appendEntry(GOAL_ENTRY, goal);
		syncTool(goal);
	};
	const flushed = (goal: Goal): Goal => {
		const tokens = goal.tokens + spent;
		spent = 0;
		return { ...goal, tokens };
	};
	const say = (ctx: ExtensionContext, message: string, level: "info" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level === "error") console.error(message);
	};
	/** 歇着的会话由它开回合；投递等不到（会话关了）就算了，别的失败要说出来。 */
	const kick = (ctx: ExtensionContext, text: string) => {
		const { signal } = lifetime;
		void deliver(pi, ctx, card(text), signal).catch((error) => {
			if (!signal.aborted) say(ctx, error instanceof Error ? error.message : String(error), "error");
		});
	};
	const elapsed = (goal: Goal) => formatDuration(Date.now() - goal.startedAt);

	pi.registerMessageRenderer(GOAL_CARD, (message, _options, theme) => {
		const text = textOf(message.content);
		const body = parseEnvelopes(text)?.map((envelope) => envelope.body).join("\n") ?? text;
		return new Text(theme.fg("muted", `◎ ${body}`), 1, 0);
	});

	pi.registerTool({
		name: TOOL,
		label: msg.tool.label,
		description: gate ? msg.tool.accept : msg.tool.declare,
		defaultActive: false,
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
			const goal = read(ctx);
			if (goal?.status === "verifying") return result(msg.tool.verifying);
			if (goal?.status !== "active") throw new Error(msg.notRunning);
			if (!gate) {
				const done = flushed(goal);
				write({ ...done, status: "complete" });
				inform(pi, card(msg.card.complete(elapsed(done), formatTokens(done.tokens))));
				return result(msg.tool.done);
			}
			const refused = gate(goal.objective, ctx);
			if (refused) throw new Error(refused);
			write({ ...flushed(goal), status: "verifying" });
			return result(msg.tool.queued);
		},
	});

	pi.registerCommand("goal", {
		description: msg.command.description,
		handler: async (args, ctx) => {
			latest = ctx;
			const input = args.trim();
			const goal = read(ctx);
			/** 设目标与继续共用：会话歇着、验收可用才开工。 */
			const start = (base: Goal, text: string) => {
				if (!ctx.isIdle() || busyView(pi).review) return say(ctx, msg.command.busy, "error");
				const review = loadConfig().review;
				if (gate && "error" in review) return say(ctx, msg.reviewBroken(review.error), "error");
				// 没落盘的计数属于现有目标：被拒的命令不动它，新目标不继承它。
				const used = base === goal ? base.tokens + spent : 0;
				if (config.tokenBudget && used >= config.tokenBudget) return say(ctx, msg.command.budgetSpent(formatTokens(config.tokenBudget)), "error");
				const next: Goal = { ...base, status: "active", tokens: used, idleRuns: 0 };
				// 用户的工具白名单（--tools）没放行完成工具时，目标永远无法完成：不开工。
				syncTool(next);
				if (!pi.getActiveTools().includes(TOOL)) return say(ctx, msg.command.toolBlocked(TOOL), "error");
				spent = 0;
				ran = false;
				write(next);
				kick(ctx, text);
			};
			switch (input) {
				case "":
					return say(ctx, goal ? msg.command.status(goal.objective, msg.status[goal.status], elapsed(goal), formatTokens(goal.tokens + spent)) : msg.command.none);
				case "clear":
					if (!goal) return say(ctx, msg.command.none);
					write(undefined);
					return say(ctx, msg.command.cleared(goal.objective));
				case "resume":
					if (!goal || goal.status === "complete") return say(ctx, msg.command.nothingToResume);
					return start(goal, msg.card.resumed);
				default:
					return start({ objective: input, status: "active", tokens: 0, idleRuns: 0, startedAt: Date.now() }, msg.card.started);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		latest = ctx;
		lifetime = new AbortController();
		spent = 0;
		ran = false;
		nudged = false;
		const goal = read(ctx);
		syncTool(goal);
		// 重开会话不自己开工：下一个回合结束时目标照常续跑，这里只告诉用户它还在。
		if (goal?.status === "active") say(ctx, msg.command.restored(goal.objective));
	});
	pi.on("session_tree", (_event, ctx) => syncTool(read(ctx)));
	pi.on("session_shutdown", () => {
		lifetime.abort();
		latest = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		const goal = read(ctx);
		if (live(goal)) event.systemPromptOptions.sections.firecode_goal = RULES.replace("{{objective}}", () => closed(goal.objective));
	});
	pi.on("tool_execution_start", () => {
		ran = true;
	});
	pi.on("message_end", ({ message }, ctx) => {
		if (message.role !== "assistant" || !live(read(ctx))) return;
		spent += message.usage.input + message.usage.cacheWrite + message.usage.output;
	});

	pi.on("turn_end", (event, ctx) => {
		const goal = read(ctx);
		const budget = config.tokenBudget;
		if (nudged || !budget || goal?.status !== "active" || !event.toolResults.length || goal.tokens + spent < budget) return undefined;
		nudged = true;
		return { entries: [...event.entries, boundaryMessage(card(msg.card.budget(formatTokens(budget))))] };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		latest = ctx;
		nudged = false;
		const goal = read(ctx);
		if (goal?.status !== "active") return undefined;
		const view = busyView(pi);
		// 子代理在飞或审查在跑：它们的结果会叫醒会话，这里不续跑；等待不算空转。
		const waiting = view.inFlight > 0 || view.review !== undefined;
		const next: Goal = { ...flushed(goal), idleRuns: ran ? 0 : waiting ? goal.idleRuns : goal.idleRuns + 1 };
		ran = false;
		const state = (data: Goal): SessionBoundaryDraft => ({ type: "custom", customType: GOAL_ENTRY, data });
		// 出错的回合宿主已重试过；预算与空转由这里数。
		const reason = event.outcome === "error" ? msg.pause.error
			: config.tokenBudget && next.tokens >= config.tokenBudget ? msg.pause.budget(formatTokens(config.tokenBudget))
			: next.idleRuns >= IDLE_RUNS ? msg.pause.idle(IDLE_RUNS)
			: undefined;
		if (reason) {
			const paused: Goal = { ...next, status: "paused" };
			syncTool(paused);
			return { entries: [...event.entries, state(paused), boundaryMessage(card(msg.card.paused(reason)))] };
		}
		if (waiting) return { entries: [...event.entries, state(next)] };
		return { entries: [...event.entries, state(next), boundaryMessage(card(msg.card.continue))], continue: true };
	});

	// 被中止的回合不经过 agent_before_settle：Esc 就是暂停，哪怕还有子代理在飞（它们的结果之后会叫醒会话）。
	// 声称完成之后被中止也暂停：已排队的验收照审查自己的规则走完，但它的结局不再能把目标记成完成。
	pi.on("agent_settled", (event, ctx) => {
		latest = ctx;
		const goal = read(ctx);
		if (!event.aborted || !live(goal)) return;
		write({ ...flushed(goal), status: "paused" });
		inform(pi, card(msg.card.paused(msg.pause.interrupted)));
	});

	watchBusy(pi, {
		// 会话歇下（回合、子代理、审查都停了）：验收有了结局；或目标还在进行却没人叫醒，接着干。
		onSettled: () => {
			const ctx = latest;
			const goal = ctx && read(ctx);
			if (!ctx || !goal) return;
			if (goal.status === "verifying") return settleAcceptance(goal, ctx);
			if (goal.status !== "active") return;
			// 歇下边沿先于上面的 agent_settled 处理器（busy.ts 的处理器注册在前）；轮记录此刻已写入，被中止的回合留给它暂停。
			const round = ctx.sessionManager.getBranch().findLast((entry) => roundFromEntry(entry));
			if (roundFromEntry(round)?.outcome !== "aborted") kick(ctx, msg.card.continue);
		},
	});

	/**
	 * 验收的结局是当前分支上最近一条审查判定（拒绝记录不算：验收期间重复声称完成会留下一条），而且必须是这个目标的验收：
	 * 切回历史上还在验收的节点后跑的普通审查、别的目标的验收，都不能把它记成完成。
	 */
	function settleAcceptance(goal: Goal, ctx: ExtensionContext): void {
		const entry = ctx.sessionManager.getBranch().findLast((item) => {
			const status = outcomeOfEntry(item)?.status;
			return status !== undefined && status !== "refused";
		});
		const outcome = acceptedObjective(entry) === goal.objective ? outcomeOfEntry(entry) : undefined;
		const done = flushed(goal);
		if (outcome?.status === "passed") {
			write({ ...done, status: "complete" });
			return inform(pi, card(msg.card.complete(elapsed(done), formatTokens(done.tokens))));
		}
		const why = outcome?.status === "stopped" ? msg.review.stopped
			: outcome?.status === "failed" ? msg.review.failed(outcome.reason)
			: outcome?.status === "cancelled" ? msg.review.cancelled
			: msg.review.missing;
		write({ ...done, status: "paused" });
		inform(pi, card(msg.card.paused(msg.pause.review(why))));
	}

	return {
		focusNote: (ctx) => {
			const goal = read(ctx);
			return goal?.status === "active" || goal?.status === "paused" ? msg.inProgress(closed(goal.objective)) : undefined;
		},
	};
}
