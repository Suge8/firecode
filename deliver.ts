/**
 * 统一投递入口（Master 事件、观察员发言与 review 的修复反馈/总结提示共用）：宿主流式中投自定义卡片、经
 * steer 队列在句缝送达；会话歇透时改走 sendUserMessage 前门唤起。只告知不唤醒的结果走 inform。唤醒走前门而非
 * triggerTurn 的原因（#33）见根 AGENTS.md 硬约束。
 * 宿主的扩展 sendUserMessage 返回 void、不等回合：以宿主记录这条消息为送达，没进回合就改走 steer 补投（tests/delivery-contract.test.ts 钉住）。
 *
 * 忙闲判断与发送必须在同一事件循环节拍内完成，两者之间禁止 await：会话落定
 * 是下一节拍的事件，同节拍读到的忙闲不会骑墙；宿主在回合结束前清空 steer
 * 队列，忙时入队的消息以同回合续跑送达，不会沦为唤醒者。
 * 唯一的例外是手动 /compact：它不在回合里，宿主 isIdle 为 false 却没有回合可续，steer 只会被当场追加、没人被唤起
 * （宿主 sendCustomMessage 的 isStreaming 为 false 分支）。所以发送前先等压缩落定，再做上面那步同节拍的忙闲判断。
 * 自动压缩在回合内部，宿主压缩后按队列续跑，不受影响。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textOf } from "./format.js";

/**
 * 机器消息的信封是唯一事实源：模型上下文里的来源标记、卡片与折叠界面的识别都从这里来。
 * 一条消息可含多个信封（并发落定的事件各占一个）；整条文本恰好由信封构成才算机器消息。
 */
const ENVELOPE_TAGS = ["firecode_master_event", "firecode_watcher", "firecode_review"] as const;
export type EnvelopeTag = (typeof ENVELOPE_TAGS)[number];

interface ParsedEnvelope {
	tag: EnvelopeTag;
	body: string;
}

export function wrapEnvelope(tag: EnvelopeTag, body: string): string {
	return `<${tag}>\n${body}\n</${tag}>`;
}

const ENVELOPE = new RegExp(`<(${ENVELOPE_TAGS.join("|")})>\\n([\\s\\S]*?)\\n</\\1>\\s*`, "uy");

export function parseEnvelopes(text: string): ParsedEnvelope[] | undefined {
	const source = text.trim();
	const found: ParsedEnvelope[] = [];
	let end = 0;
	for (;;) {
		ENVELOPE.lastIndex = end;
		const match = ENVELOPE.exec(source);
		if (!match) break;
		found.push({ tag: match[1] as EnvelopeTag, body: match[2] });
		end = ENVELOPE.lastIndex;
	}
	return found.length && end === source.length ? found : undefined;
}

export interface Delivery {
	customType: string;
	/** 已按信封格式包好的正文，同时是卡片渲染的唯一数据源。 */
	content: string;
}

interface CompactionState {
	/** 手动压缩进行中的等待点；undefined 表示没有。 */
	pending?: PromiseWithResolvers<void>;
	/** 压缩事件已发完、但宿主可能还没退出压缩状态的收尾期。 */
	settling: boolean;
}

const manualCompactions = new WeakMap<ExtensionAPI, CompactionState>();

/** 收尾期里宿主退出压缩状态之前的轮询间隔；收尾只剩其余扩展的 session_compact 处理器，通常毫秒级。 */
const SETTLE_TICK_MS = 5;

/**
 * 登记宿主的手动压缩事件，主会话注册时调用一次。session_compact 在宿主清掉压缩状态之前发出，且宿主逐个 await 全部处理器
 * （包括排在本处理器之后的其他扩展），所以事件到达时 isIdle 仍是 false，之后多久转 true 取决于别人的处理器：
 * 没有事件可等，收尾期由 deliver 按 isIdle 等到真正落定。失败与取消走 session_compact_failed，同样处理。
 */
export function watchManualCompaction(pi: ExtensionAPI): void {
	if (manualCompactions.has(pi)) return;
	const state: CompactionState = { settling: false };
	manualCompactions.set(pi, state);
	const finish = () => {
		const waiting = state.pending;
		if (!waiting) return;
		state.pending = undefined;
		state.settling = true;
		waiting.resolve();
	};
	pi.on("session_before_compact", (event) => {
		if (event.reason !== "manual") return;
		state.settling = false;
		state.pending ??= Promise.withResolvers<void>();
	});
	pi.on("session_compact", (event) => { if (event.reason === "manual") finish(); });
	pi.on("session_compact_failed", (event) => { if (event.reason === "manual") finish(); });
	// 收尾期里用户或别的扩展开了回合：之后的忙就是回合在忙，steer 会被续跑，不用再等。
	pi.on("agent_start", () => { state.settling = false; });
	pi.on("session_shutdown", () => {
		state.settling = false;
		finish();
	});
}

/**
 * 统一投递，resolve 即“已交给指挥官”：
 * - 主回合在跑：卡片进 steer 队列，入队即交付；
 * - 主回合歇透：前门 sendUserMessage 唤起，见 wake；
 * - 手动压缩中：等压缩落定再按上两条投递，期间保持未完成。
 */
export async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
	signal?: AbortSignal,
): Promise<void> {
	const compaction = manualCompactions.get(pi);
	while (compaction?.pending) await abortable(compaction.pending.promise, signal);
	while (compaction?.settling && !ctx.isIdle()) {
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, SETTLE_TICK_MS));
	}
	if (ctx.isIdle()) return wake(pi, envelope, signal);
	steer(pi, envelope);
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return promise;
	signal.throwIfAborted();
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * 告知不唤醒：指挥官没在等的结果（用户在子代理视图里直接派的运行）。triggerTurn:false 的 sendMessage：歇透时宿主当场
 * 追加，回合进行中宿主推迟到本回合结束再追加（不夹进工具调用与结果之间，前缀不变），两种情况都不多起一次模型请求。
 * 必须显式写 false：省略时宿主在回合进行中把它当 steer 入队，等于唤醒（tests/delivery-contract.test.ts 钉住）。
 */
export function inform(pi: ExtensionAPI, envelope: Delivery): void {
	pi.sendMessage({ customType: envelope.customType, content: envelope.content, display: true }, { triggerTurn: false });
}

function steer(pi: ExtensionAPI, envelope: Delivery): void {
	pi.sendMessage(
		{ customType: envelope.customType, content: envelope.content, display: true },
		{ deliverAs: "steer" },
	);
}

/**
 * 前门唤起按事实确认送达。宿主的扩展 sendUserMessage 返回 void、不等回合；开回合前被拒时只走宿主
 * emitError，扩展订阅不到。所以等下一个回合的第一条消息：
 * - 正是这条信封（role=user、正文原样）：它开启了这一回合，送达；
 * - 是别的（用户自己发的话、其他扩展唤起的消息）：这条没进来，会话此刻正忙，同一节拍改走 steer 补投，句缝送达。
 * 两种情况下 resolve 时指挥官回合都已在跑，Master 扣在飞数不会让 busy.ts 误报歇下。
 * 之后再没有任何回合时投递保持未完成：宁可不歇下，也不误报歇下；没有计时器。调用方收口（signal 中止）时退订并以中止原因 reject，
 * 收口后的回合不再补投旧信封。
 * 不以任意 agent_start 为送达（宿主拒绝后用户自己开的回合会被误认，事件被 ack 却没进上下文）；不加超时（超时后仍判断不了是否送达）。
 */
function wake(pi: ExtensionAPI, envelope: Delivery, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const delivered = Promise.withResolvers<void>();
	let running = false;
	const onAbort = () => {
		for (const off of unsubscribe) off();
		delivered.reject(signal?.reason);
	};
	const unsubscribe = [
		() => signal?.removeEventListener("abort", onAbort),
		pi.on("agent_start", () => {
			running = true;
		}),
		pi.on("message_start", ({ message }) => {
			if (!running) return;
			for (const off of unsubscribe) off();
			if (message.role !== "user" || textOf(message.content) !== envelope.content) steer(pi, envelope);
			delivered.resolve();
		}),
	];
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		pi.sendUserMessage(envelope.content);
	} catch (error) {
		for (const off of unsubscribe) off();
		throw error;
	}
	return delivered.promise;
}
