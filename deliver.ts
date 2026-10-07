/**
 * 统一投递入口（Master 事件与观察员发言共用）：宿主流式中投自定义卡片、经
 * steer 队列在句缝送达；会话歇透时改走 sendUserMessage 前门唤起（只告知不唤醒的
 * 结果改走 inform，歇透时直接追加）。唤醒走前门而非 triggerTurn 的原因（#33）与回合中不得立即追加（#28）见根 AGENTS.md 硬约束。
 * 宿主的扩展 sendUserMessage 返回 void、不等回合：以宿主记录这条消息为送达，没进回合就改走 steer 补投（tests/delivery-contract.test.ts 钉住）。
 *
 * 忙闲判断与发送必须在同一事件循环节拍内完成，两者之间禁止 await：会话落定
 * 是下一节拍的事件，同节拍读到的忙闲不会骑墙；宿主在回合结束前清空 steer
 * 队列，忙时入队的消息以同回合续跑送达，不会沦为唤醒者。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textOf } from "./format.js";

/**
 * 机器消息的信封是唯一事实源：模型上下文里的来源标记、卡片与折叠界面的识别都从这里来。
 * 一条消息可含多个信封（并发落定的事件各占一个）；整条文本恰好由信封构成才算机器消息。
 */
export const ENVELOPE_TAGS = ["firecode_master_event", "firecode_watcher", "firecode_review"] as const;
export type EnvelopeTag = (typeof ENVELOPE_TAGS)[number];

export interface ParsedEnvelope {
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

/**
 * 统一投递，resolve 即“已交给指挥官”：
 * - 主回合在跑：卡片进 steer 队列，入队即交付；
 * - 主回合歇透：前门 sendUserMessage 唤起，见 wake。
 */
export async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
): Promise<void> {
	if (ctx.isIdle()) return wake(pi, envelope);
	steer(pi, envelope);
}

/**
 * 告知不唤醒：指挥官没在等的结果（用户在子代理视图里直接派的运行）。主回合在跑时与 deliver 相同，经 steer 队列句缝送达；
 * 主会话歇透时以不带 triggerTurn 的 sendMessage 追加为会话记录，下一回合自然进上下文，resolve 即已写入。
 * 歇透时追加是安全的（核对宿主 AgentSession.sendCustomMessage）：不在流式中且不触发回合时，宿主当场写会话树并刷新
 * 上下文，追加在最后一条消息之后，不夹进工具调用与结果之间，已有前缀不变、提示词缓存不重写。#28 的快照分叉只发生在
 * 回合进行中立即追加；这里也不经 triggerTurn，与 #33 无关。
 */
export async function inform(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
): Promise<void> {
	if (!ctx.isIdle()) return steer(pi, envelope);
	pi.sendMessage({ customType: envelope.customType, content: envelope.content, display: true });
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
 * 之后再没有任何回合时投递保持未完成：宁可不歇下，也不误报歇下；没有计时器。
 * 不以任意 agent_start 为送达（宿主拒绝后用户自己开的回合会被误认，事件被 ack 却没进上下文）；不加超时（超时后仍判断不了是否送达）。
 */
function wake(pi: ExtensionAPI, envelope: Delivery): Promise<void> {
	const delivered = Promise.withResolvers<void>();
	let running = false;
	const unsubscribe = [
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
	try {
		pi.sendUserMessage(envelope.content);
	} catch (error) {
		for (const off of unsubscribe) off();
		throw error;
	}
	return delivered.promise;
}
