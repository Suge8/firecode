/**
 * 统一投递入口（Master 事件、观察员发言与 review 的修复反馈/总结提示共用）：一律以自定义消息 + triggerTurn 交给宿主，
 * 宿主在回合进行中（含开回合的准备阶段）把它放进 steer 队列句缝送达，歇透时由它开一个回合，回合照常经过
 * before_agent_start（pi 1.2.0 起），扩展注入的系统提示段不被撤下。只告知不唤醒的结果走 inform。
 *
 * 例外是手动 /compact 与带摘要的 /tree 切换：它们不在回合里，宿主 isIdle 为 false、isStreaming 为 false，此时 steer 只会被当场
 * 追加、没人被唤起，triggerTurn 则会在压缩还没落定时开一个回合；/tree 还会把消息挂到被丢下的旧分支。所以发送前先等它们落定。
 * 自动压缩在回合内部，宿主压缩后按队列续跑，不受影响。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

interface MaintenanceState {
	/** 手动压缩进行中的等待点；undefined 表示没有。 */
	pending?: PromiseWithResolvers<void>;
	/** 维护动作的事件已发完、或事件不完整（分支摘要），宿主可能还没退出忙状态的收尾期；deliver 按 isIdle 等。 */
	settling: boolean;
	/** 收尾期的检查间隔：分支摘要要等整个摘要请求，放宽；压缩只剩别的扩展的处理器，收紧。 */
	tickMs: number;
}

const maintenance = new WeakMap<ExtensionAPI, MaintenanceState>();

const COMPACTION_TICK_MS = 5;
const SUMMARY_TICK_MS = 50;

/**
 * 登记宿主的两类"不在回合里的忙"，主会话注册时调用一次：手动 /compact 与带摘要的 /tree 分支切换。
 * 两者宿主 isIdle 为 false、isStreaming 为 false，steer 只会被当场追加、没人被唤起；分支切换更糟，
 * 追加发生在摘要期间，消息挂在即将被丢下的旧分支上，模型之后永远看不到。所以 deliver 要等它们落定再投。
 *
 * 手动压缩有成对的事件：session_before_compact 开始，session_compact / session_compact_failed 结束，用 pending 等。
 * session_compact 在宿主清掉压缩状态之前发出，宿主还逐个 await 排在后面的扩展的处理器，所以事件到达时 isIdle 仍是 false，
 * 之后进入收尾期按 isIdle 等到真正落定。
 *
 * 分支切换没有成对的事件：宿主只在切换成功时发 session_tree，扩展取消、用户取消和摘要报错都没有事件，等事件会永远悬挂。
 * 所以 session_before_tree 起就只置收尾期、按 isIdle 等（摘要期间间隔放宽）；成功的 session_tree 到达后摘要已结束，间隔收紧。
 * 收尾期里有回合开始（agent_start）就不再等：之后的忙是回合在忙，steer 会被续跑。
 */
export function watchSessionMaintenance(pi: ExtensionAPI): void {
	if (maintenance.has(pi)) return;
	const state: MaintenanceState = { settling: false, tickMs: COMPACTION_TICK_MS };
	maintenance.set(pi, state);
	const finishCompaction = () => {
		const waiting = state.pending;
		if (!waiting) return;
		state.pending = undefined;
		state.settling = true;
		waiting.resolve();
	};
	pi.on("session_before_compact", (event) => {
		if (event.reason !== "manual") return;
		state.settling = false;
		state.tickMs = COMPACTION_TICK_MS;
		state.pending ??= Promise.withResolvers<void>();
	});
	pi.on("session_compact", (event) => { if (event.reason === "manual") finishCompaction(); });
	pi.on("session_compact_failed", (event) => { if (event.reason === "manual") finishCompaction(); });
	pi.on("session_before_tree", () => {
		state.settling = true;
		state.tickMs = SUMMARY_TICK_MS;
	});
	pi.on("session_tree", () => { state.tickMs = COMPACTION_TICK_MS; });
	pi.on("agent_start", () => { state.settling = false; });
	pi.on("session_shutdown", () => {
		state.settling = false;
		finishCompaction();
	});
}

/**
 * 统一投递，resolve 即指挥官回合已在跑：
 * - 主回合在跑：宿主把卡片放进 steer 队列，入队即交付；
 * - 主回合歇透：宿主当场把会话置为忙并开回合，等这个回合的 agent_start 再 resolve。宿主在 agent_start 之前就返回，
 *   过早 resolve 会让 Master 先扣掉在飞数，busy.ts 在回合开始前误报一次歇下。会话已置为忙，期间没有别的回合能先开始，
 *   所以下一个 agent_start 就是它开的回合；agent_settled 派发期间发出的，宿主推迟到派发完再开，同样是下一个；
 * - 手动压缩或分支切换中：等它落定再按上两条投递，期间保持未完成（见 watchSessionMaintenance）。
 * 忙闲判断与发送之间不能 await：两者在同一节拍，读到的忙闲就是宿主处理这条消息时的忙闲。
 * 调用方收口（signal 中止）时退订并以中止原因 reject。
 */
export async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
	signal?: AbortSignal,
): Promise<void> {
	const state = maintenance.get(pi);
	while (state?.pending) await abortable(state.pending.promise, signal);
	while (state?.settling && !ctx.isIdle()) {
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, state.tickMs));
	}
	signal?.throwIfAborted();
	const started = ctx.isIdle() ? Promise.withResolvers<void>() : undefined;
	const unsubscribe = started && pi.on("agent_start", () => started.resolve());
	try {
		pi.sendMessage({ customType: envelope.customType, content: envelope.content, display: true }, { triggerTurn: true });
		if (started) await abortable(started.promise, signal);
	} finally {
		unsubscribe?.();
	}
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
