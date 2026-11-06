/**
 * 闲置压缩（主会话与子会话）：歇下后闲置到 Timing.cacheTtlMs − idleCompactionLeadMs，用后台链预先算好摘要，只放内存，
 * 绑定当时的会话末端（leaf）。下一次请求发出前——用户输入经 input 事件，插件投递经 deliver.ts 的 beforeWake——
 * 闲置已超过缓存过期线且会话末端没变，就经宿主 ctx.compact 把它作为一次压缩应用（压缩钩子交出这份摘要，持久化与事件仍是宿主的），
 * 再发请求；否则丢弃。指挥官给暂停的子代理续跑时直接投自定义消息、不经这两处，那次请求开回合时预算作废、照常发出。缓存没过期时压缩反而要重写整段前缀，所以过期线之前的请求一律原样。
 *
 * 不当场算：进程重启后没有预算好的摘要就照常走；请求到达时预算还在飞，作废预算。上下文不到 MIN_CONTEXT_TOKENS 不预算。
 * 原生压缩接管的会话不碰（见 openai-native 的 nativeTakesOver）。
 *
 * 切点：pi 没有导出 prepareCompaction，这里用它导出的 findCutPoint 按 pi 的 keepRecentTokens 选（与宿主的区别只在不按 context_edit
 * 投影逐条估算大小，切点同样只落在宿主允许的位置），摘要带着这个 firstKeptEntryId 交给宿主；会话末端没变，这个切点就仍然成立。
 */
import {
	type CompactionResult,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	buildSessionProjection,
	calculateContextTokens,
	findCutPoint,
	getLastAssistantUsage,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { beforeWake } from "../deliver.js";
import { physicalModel } from "../model-route.js";
import { nativeCompactionEnabled } from "../provider/openai-native/index.js";
import { nativeTakesOver } from "../provider/openai-native/src/native-compaction.js";
import type { InProcessSessionPool } from "../spawn.js";
import { msg } from "./messages.js";
import { type Preparation, type Summary, summarize } from "./summarize.js";

/** 上下文到这么大才值得闲置压缩：更小的上下文缓存失效后重写也便宜，不值得丢掉原文。 */
const MIN_CONTEXT_TOKENS = 150_000;

interface Ready {
	leafId: string | null;
	idleSince: number;
	tokensBefore: number;
	summary: Summary;
}

export class IdleCompaction {
	private idleSince?: number;
	private timer?: NodeJS.Timeout;
	private computing?: AbortController;
	private ready?: Ready;
	private current?: Ready;

	constructor(private readonly pi: ExtensionAPI, private readonly pool: InProcessSessionPool, private readonly chain: ModelChain) {
		pi.on("agent_settled", (_event, ctx) => this.settled(ctx));
		pi.on("agent_start", () => this.reset());
		pi.on("session_shutdown", () => this.reset());
		pi.on("input", async (_event, ctx) => {
			await this.beforeRequest(ctx);
			return { action: "continue" };
		});
		beforeWake(pi, (ctx) => this.beforeRequest(ctx));
	}

	/** 正在应用的那份摘要：只在 beforeRequest 发起的压缩期间有值，压缩钩子原样交给宿主。 */
	applying(): CompactionResult | undefined {
		return this.current?.summary.result;
	}

	private settled(ctx: ExtensionContext): void {
		this.reset();
		this.idleSince = Date.now();
		const { cacheTtlMs, idleCompactionLeadMs } = this.pool.timing;
		this.timer = setTimeout(() => void this.precompute(ctx), Math.max(0, cacheTtlMs - idleCompactionLeadMs));
		this.timer.unref?.();
	}

	private reset(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.computing?.abort();
		this.computing = undefined;
		this.ready = undefined;
		this.idleSince = undefined;
	}

	private async precompute(ctx: ExtensionContext): Promise<void> {
		this.timer = undefined;
		const idleSince = this.idleSince;
		const branch = ctx.sessionManager.getBranch();
		// 子会话的模型是路由虚拟模型，宿主算不出它的上下文用量：退回分支上最后一次回复报告的用量（同一口径）。
		const lastUsage = getLastAssistantUsage(branch);
		const tokensBefore = ctx.getContextUsage()?.tokens ?? (lastUsage ? calculateContextTokens(lastUsage) : 0);
		if (idleSince === undefined || !ctx.isIdle() || tokensBefore < MIN_CONTEXT_TOKENS) return;
		if (nativeTakesOver(branch, physicalModel(ctx.model), nativeCompactionEnabled())) return;
		const preparation = idlePreparation(branch, this.settings(ctx), tokensBefore);
		if (!preparation) return;
		const leafId = ctx.sessionManager.getLeafId();
		const controller = this.computing = new AbortController();
		try {
			const summary = await summarize(this.pool, this.chain, preparation, undefined, controller.signal);
			if (this.computing === controller) this.ready = { leafId, idleSince, tokensBefore, summary };
		} catch (error) {
			if (!controller.signal.aborted) notify(ctx, msg.idleFailed(error instanceof Error ? error.message : String(error)));
		} finally {
			if (this.computing === controller) this.computing = undefined;
		}
	}

	/** 请求发出前：够条件就应用预算好的摘要，不够就丢弃；无论如何这次闲置的预算到此为止。 */
	private async beforeRequest(ctx: ExtensionContext): Promise<void> {
		if (!ctx.isIdle()) return;
		const ready = this.ready;
		this.reset();
		if (!ready || Date.now() - ready.idleSince < this.pool.timing.cacheTtlMs || ctx.sessionManager.getLeafId() !== ready.leafId) return;
		this.current = ready;
		try {
			const result = await new Promise<CompactionResult>((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject }));
			const minutes = Math.round((Date.now() - ready.idleSince) / 60_000);
			if (ctx.hasUI) ctx.ui.notify(msg.idleApplied(minutes, ready.summary.model, ready.tokensBefore, result.estimatedTokensAfter), "info");
		} catch (error) {
			notify(ctx, msg.idleApplyFailed(error instanceof Error ? error.message : String(error)));
		} finally {
			this.current = undefined;
		}
	}

	/** 与宿主 getCompactionSettings 同一规则：按模型覆写、普通设置、内置默认的顺序取。 */
	private settings(ctx: ExtensionContext): Preparation["settings"] {
		const compaction = this.pi.getSettings().compaction ?? {};
		const override = ctx.model ? compaction.modelOverrides?.[`${ctx.model.provider}/${ctx.model.id}`] : undefined;
		return {
			enabled: compaction.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
			reserveTokens: override?.reserveTokens ?? compaction.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: override?.keepRecentTokens ?? compaction.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};
	}
}

function notify(ctx: ExtensionContext, text: string): void {
	if (ctx.hasUI) ctx.ui.notify(text, "warning");
	else console.error(text);
}

/** 宿主 prepareCompaction 的公开替身：上次压缩之后的投影里按 keepRecentTokens 选切点，切在回合中间时另给回合前缀。 */
function idlePreparation(branch: SessionEntry[], settings: Preparation["settings"], tokensBefore: number): Preparation | undefined {
	if (!branch.length || branch.at(-1)!.type === "compaction") return undefined;
	const projected = buildSessionProjection(branch).entries;
	const entries = projected.map((entry) => entry.sourceEntry);
	const previousIndex = projected.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const previous = previousIndex >= 0 ? entries[previousIndex] : undefined;
	const start = previousIndex + 1;
	const cut = findCutPoint(entries, start, entries.length, settings.keepRecentTokens);
	const firstKept = entries[cut.firstKeptEntryIndex];
	if (!firstKept) return undefined;
	const messages = (from: number, to: number) => projected.slice(from, to).flatMap((entry) =>
		entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system"));
	const messagesToSummarize = messages(start, cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex);
	const turnPrefixMessages = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
	return {
		firstKeptEntryId: firstKept.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary: previous?.type === "compaction" ? previous.summary : undefined,
		fileOps: fileOperations([...messagesToSummarize, ...turnPrefixMessages], previous),
		settings,
	};
}

const FILE_TOOLS = { read: "read", write: "written", edit: "edited" } as const;

/** 与宿主同一口径的文件清单：上次（非扩展）压缩记下的清单，加这段消息里 read/write/edit 的路径（含 codemode 嵌套调用）。 */
function fileOperations(messages: Preparation["messagesToSummarize"], previous: SessionEntry | undefined): Preparation["fileOps"] {
	const ops: Preparation["fileOps"] = { read: new Set(), written: new Set(), edited: new Set() };
	if (previous?.type === "compaction" && !previous.fromHook && previous.details && typeof previous.details === "object") {
		const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
		if (Array.isArray(details.readFiles)) for (const file of details.readFiles) ops.read.add(String(file));
		if (Array.isArray(details.modifiedFiles)) for (const file of details.modifiedFiles) ops.edited.add(String(file));
	}
	const add = (name: string, args: unknown) => {
		const kind = FILE_TOOLS[name as keyof typeof FILE_TOOLS];
		const path = (args as { path?: unknown } | undefined)?.path;
		if (kind && typeof path === "string" && path) ops[kind].add(path);
	};
	for (const message of messages) {
		if (message.role === "toolResult") for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
		if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
	}
	return ops;
}
