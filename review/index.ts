/**
 * /fire-review：对抗性审查插件的入口。
 *
 * 职责分界：领域状态只活在纯 reducer（state.ts）里，一场审查的副作用由 run.ts 的 Run 执行；
 * 本文件只做注册与会话级事件分发。运行时状态按会话隔离：pi 在同一进程内对同一 cwd 复用扩展模块实例，
 * 主会话与每个 Worker 子会话共用本文件，registerReview 各自持有一份当前 Run，模块级不留任何会话状态。
 * 渲染器在此无条件注册，live 与 reload 外观一致。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { InProcessSessionPool } from "../spawn.js";
import { registerCardRenderer } from "./card.js";
import { CheckpointWriter, readCheckpoint, recordRefusal, sealCheckpoint } from "./checkpoint.js";
import { msg } from "./messages.js";
import { sessionLabel } from "./ui.js";
import { errorText, Run, type RunHost } from "./run.js";
import { createReviewSessionRunner, type ReviewSessionRunner } from "./session.js";
import { CANCEL_REVIEW_ARG } from "./outcome.js";
import { initialState, isActive } from "./state.js";

export interface ReviewOptions {
	/** 用户关闭 review 功能：只封存遗留的活动 checkpoint。 */
	enabled?: boolean;
	/** features 配置坏掉不是关闭：保留 checkpoint，修好配置重启后继续恢复。 */
	configBroken?: boolean;
	/** 审查/顾问会话开在这个池里：进程里唯一的子会话池，由入口传入，本模块不自建。 */
	pool?: InProcessSessionPool;
	/** 审查/顾问会话的执行器；测试注入脚本化会话用，给了就不需要 pool。 */
	runSession?: ReviewSessionRunner;
}

export function registerReview(pi: ExtensionAPI, { enabled = true, configBroken = false, pool, runSession }: ReviewOptions = {}): void {
	// 渲染器与开关解耦：关闭 review 后历史卡 reload 仍使用原生结果卡样式。
	registerCardRenderer(pi);
	if (!enabled) {
		if (!configBroken) pi.on("session_start", (_event, ctx) => settleDisabledCheckpoint(pi, ctx));
		return;
	}
	const sessionRunner = runSession ?? (pool && createReviewSessionRunner(pool));
	if (!sessionRunner) throw new Error("registerReview needs a session pool or a session runner");
	let current: Run | undefined;
	const host: RunHost = {
		pi,
		runSession: sessionRunner,
		ended: (run) => {
			if (current === run) current = undefined;
		},
	};

	pi.registerCommand("fire-review", {
		description: msg.command.description,
		handler: (args, ctx) => startReview(args, ctx),
	});
	pi.on("session_start", (_event, ctx) => resume(ctx));
	// 宿主保证 resources_discover 在整次 session_start（含所有异步 handler）完成后发出。
	pi.on("resources_discover", (_event, ctx) => current?.advance(ctx));
	pi.on("agent_start", () => current?.agentStarted());
	// agent_end 只记录修复/总结回合的结局，不在此推进审查。
	pi.on("agent_end", (event) => current?.agentEnded(event));
	// settled 后尝试推进；后续异步 handler 若再触发模型，agent_start 互锁会先停审查。
	pi.on("agent_settled", (_event, ctx) => current?.advance(ctx));
	pi.on("session_shutdown", (event, ctx) => current?.shutdown(event.reason, ctx));

	async function startReview(args: string, ctx: ExtensionContext): Promise<void> {
		// 取消不依赖配置能否解析：配置坏掉时也要能停掉已在跑的审查。
		if (args.trim() === CANCEL_REVIEW_ARG) return cancelReview(ctx);
		// 配置解析失败不能让命令无声失败：pi 会捕获 handler 异常，用户只会看到什么都没发生。
		// 命令与恢复两个入口共用同一判定：任何一个静默回退默认模型都会花真钱跑错模型。
		const loaded = loadConfig().review;
		if ("error" in loaded) return refuse(ctx, loaded.error, "error");
		if (current) return refuse(ctx, msg.command.alreadyRunning, "info");
		const input = args.trim();
		if (input.startsWith("--")) return refuse(ctx, msg.command.invalidArgs, "error");
		current = new Run(host, ctx, loaded.config, initialState(randomUUID()), new CheckpointWriter(pi));
		current.start(input);
	}

	function cancelReview(ctx: ExtensionContext): void {
		if (current) current.cancel();
		else if (ctx.hasUI) ctx.ui.notify(msg.command.nothingToCancel, "info");
	}

	/** 拒绝启动：有 UI 时通知，无论有无 UI 都记录——Worker 里没有 UI，Master 靠这条记录读到原因。 */
	function refuse(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
		recordRefusal(pi, message);
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	/**
	 * 重启 / 会话恢复：从 checkpoint 重建 Run 并续跑未完成的环节。
	 * reload / new / resume / fork 是运行时替换（新 pi、新 runtime），旧 runtime 已在 session_shutdown 收口；
	 * 这里只按新会话的 checkpoint 恢复，quit 之外不 settle。
	 */
	function resume(ctx: ExtensionContext): void {
		const checkpoint = readCheckpoint(ctx, () => voidDamaged(pi, ctx));
		if (!checkpoint || !isActive(checkpoint)) return;
		// 配置问题的告警由入口统一聚合；这里保留活动 checkpoint，修好后继续恢复。
		const loaded = loadConfig().review;
		if ("error" in loaded) return;
		current = new Run(host, ctx, loaded.config, checkpoint, new CheckpointWriter(pi, checkpoint));
		current.resume();
	}
}

/** 提示存档损坏并写一份空的已收口存档作废它：之后读到的是有效存档，同一会话不再重复提示。 */
function voidDamaged(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.notify(msg.notify.checkpointDamaged(sessionLabel(ctx)), "error");
	try {
		sealCheckpoint(pi, initialState(randomUUID()));
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(msg.notify.cannotSealOld(errorText(error)), "error");
	}
}

function settleDisabledCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	try {
		sealCheckpoint(pi, checkpoint);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(msg.notify.cannotSealOld(errorText(error)), "error");
	}
}
