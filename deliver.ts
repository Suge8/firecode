/**
 * 统一投递入口（Master 事件与 review 的修复反馈/总结提示共用）：一律以自定义消息 + triggerTurn 交给宿主，
 * 回合进行中在句缝送达，歇透时由宿主开一个回合，回合照常经过 before_agent_start（pi 1.2.0 起），扩展注入的系统提示段
 * 不被撤下。送达只认这条消息进入回合（它的 message_start），入队不算：入队的消息可能被清掉或滞留。
 * 手动 /compact、带摘要的 /tree 等不在回合里的忙先等它落定；自动压缩在回合内部，不受影响。规则见 deliver 与 DeliveryLine。
 * 只告知不唤醒的结果走 inform。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 机器消息的信封是唯一事实源：模型上下文里的来源标记、卡片与折叠界面的识别都从这里来。
 * 一条消息可含多个信封（并发落定的事件各占一个）；整条文本恰好由信封构成才算机器消息。
 */
const ENVELOPE_TAGS = ["firecode_master_event", "firecode_review"] as const;
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

type DeliveryMessage = { customType: string; content: string; display: true; details: { delivery: string } };

/**
 * 每个会话一条投递线：持有回合进行中等着上车的投递，凭 message_start 发回执。
 * 回合进行中不在调用时就把消息交给宿主的 steer 队列：在那里它可能被用户的 Esc/出队键清掉（宿主编辑器只回填文本，
 * 自定义消息无声丢失），也可能因回合被中止（含 /compact 开头的中止）滞留到用户下次输入，而扩展看不到那个队列，
 * 事后分不清是哪一种，补投就可能重复。所以消息先留在这里，只在宿主马上要取队列的时刻（turn_end、agent_end，
 * 回合未被中止、用户没有排队的话）上车：宿主紧接着取走它并发 message_start。一次只上一条：宿主默认逐条取队列。
 * 回合落定时还没进入的（中止、没赶上句缝）回到 deliver，等歇透后自己开回合。
 * 残余：上车后同一节拍里被清或被中止，或别的扩展的 steer 占了逐条取的那一格，落定时同样按未进入处理，
 * 可能重复一次——宁可重复不丢。
 */
class DeliveryLine {
	private readonly receipts = new Map<string, PromiseWithResolvers<boolean>>();
	private readonly riders: { message: DeliveryMessage; boarded: boolean }[] = [];

	constructor(private readonly pi: ExtensionAPI) {
		pi.on("turn_end", (_event, ctx) => this.board(ctx));
		pi.on("agent_end", (_event, ctx) => this.board(ctx));
		pi.on("message_start", ({ message }) => {
			if (message.role !== "custom") return;
			const delivery = (message.details as { delivery?: unknown } | undefined)?.delivery;
			if (typeof delivery === "string") this.receipts.get(delivery)?.resolve(true);
		});
		pi.on("agent_settled", () => {
			for (const rider of this.riders) this.receipts.get(rider.message.details.delivery)?.resolve(false);
		});
	}

	/** 歇透：宿主开回合，等这条消息的 message_start。 */
	async wake(message: DeliveryMessage, signal?: AbortSignal): Promise<void> {
		await this.receipt(message, signal, () => this.pi.sendMessage(message, { triggerTurn: true }));
	}

	/** 回合在跑：排队等句缝；true 是已进入这一回合，false 是回合落定时还没进入。 */
	async ride(message: DeliveryMessage, signal?: AbortSignal): Promise<boolean> {
		const rider = { message, boarded: false };
		this.riders.push(rider);
		try {
			return await this.receipt(message, signal);
		} finally {
			this.riders.splice(this.riders.indexOf(rider), 1);
		}
	}

	private async receipt(message: DeliveryMessage, signal?: AbortSignal, send?: () => void): Promise<boolean> {
		const receipt = Promise.withResolvers<boolean>();
		this.receipts.set(message.details.delivery, receipt);
		try {
			send?.();
			return await abortable(receipt.promise, signal);
		} finally {
			this.receipts.delete(message.details.delivery);
		}
	}

	/** 宿主取 steer 队列之前（处理器返回后它立即取）：队首还没上车就上车，取走时发 message_start；发送抛错交回这条投递。 */
	private board(ctx: ExtensionContext): void {
		const next = this.riders[0];
		if (!next || next.boarded || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
		next.boarded = true;
		try {
			this.pi.sendMessage(next.message, { triggerTurn: true });
		} catch (error) {
			this.receipts.get(next.message.details.delivery)?.reject(error);
		}
	}
}

/** 第一次投递时建线：订阅从那以后的回合事件就够了，乘车的投递只在宿主 agent 循环在跑时加入（见 deliver）。 */
const lines = new WeakMap<ExtensionAPI, DeliveryLine>();
function lineOf(pi: ExtensionAPI): DeliveryLine {
	let line = lines.get(pi);
	if (!line) lines.set(pi, line = new DeliveryLine(pi));
	return line;
}
const wakeHooks = new WeakMap<ExtensionAPI, (ctx: ExtensionContext) => Promise<void>>();

/** 登记歇透时开回合前要先做完的事（每个会话一个）：它可以发起手动压缩，deliver 之后照常等压缩落定。 */
export function beforeWake(pi: ExtensionAPI, hook: (ctx: ExtensionContext) => Promise<void>): void {
	wakeHooks.set(pi, hook);
}

/** 宿主忙却不在回合里时检查歇透的间隔：这类忙没有成对的结束事件可等（见 deliver）。 */
const IDLE_TICK_MS = 20;

/**
 * 统一投递，resolve 即这条消息已进入回合（宿主为它发了 message_start，先于带上它的模型请求）：
 * - 主回合歇透：宿主开回合，等这条消息的 message_start。宿主在回合开始之前就从 sendMessage 返回，过早 resolve 会让
 *   Master 先扣掉在飞数，busy.ts 在回合开始前误报一次歇下。不以“下一个 agent_start”为回执：agent_settled 派发期间
 *   宿主把 triggerTurn 推迟到派发完逐个执行，别人先排进去时下一个回合是别人的。
 * - 主回合在跑（宿主 agent 循环在跑，ctx.signal 有值）：经投递线在句缝上车（见 DeliveryLine），同样等自己的
 *   message_start；回合落定时还没进入就回到下一条。
 * - 宿主忙却不在回合里：开回合的准备段、手动 /compact、带摘要的 /tree、落定收尾。此时 steer 只会被当场追加、没人
 *   唤起，triggerTurn 会在压缩落定前开回合，/tree 还会把消息挂到被丢下的旧分支，所以按间隔查 isIdle 等歇透或回合开始。
 *   不等事件：分支切换只在成功时发 session_tree（取消、报错都没有事件），session_compact 先于宿主清压缩状态发出，
 *   宿主还逐个 await 排在后面的扩展的处理器。回合没赶上而落定后也先等一个间隔：宿主在落定处理器返回后才放行
 *   等着它歇下的压缩与分支切换（它们开头先中止回合），让它们先占住会话，投递随后唤醒，不抢在它们前面开回合。
 * 认消息靠 details 里每次投递新生成的 delivery id（宿主把 details 原样带进消息与会话记录），不比正文：同类型同正文的
 * 两条投递（或别的扩展发的同文消息）也不会互相确认。details 只承载这个 id，渲染与折叠界面不认它，照常降级。
 * 忙闲判断与发送之间不能 await：两者在同一节拍，读到的忙闲就是宿主处理这条消息时的忙闲。
 * 歇透时要开回合的投递先过唤醒前钩子（beforeWake）。调用方收口（signal 中止）时撤下并以中止原因 reject。
 */
export async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
	signal?: AbortSignal,
): Promise<void> {
	const line = lineOf(pi);
	const message: DeliveryMessage = {
		customType: envelope.customType, content: envelope.content, display: true, details: { delivery: crypto.randomUUID() },
	};
	for (;;) {
		signal?.throwIfAborted();
		if (ctx.isIdle()) {
			const hook = wakeHooks.get(pi);
			if (hook) await abortable(hook(ctx), signal);
			if (ctx.isIdle()) return line.wake(message, signal);
		} else if (ctx.signal && await line.ride(message, signal)) return;
		await abortable(new Promise<void>((resolve) => setTimeout(resolve, IDLE_TICK_MS)), signal);
	}
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
