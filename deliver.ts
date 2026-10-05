/**
 * 统一投递入口（Master 事件与观察员发言共用）：宿主流式中投自定义卡片、经
 * steer 队列在句缝送达；会话歇透时改走 sendUserMessage 前门唤起——宿主的
 * triggerTurn 唤醒会跳过 before_agent_start（上游缺陷，#33），前门唤醒自带
 * 完整开跑仪式，系统提示注入不随回合抖动。
 *
 * 忙闲判断与发送必须在同一事件循环节拍内完成，两者之间禁止 await：会话落定
 * 是下一节拍的事件，同节拍读到的忙闲不会骑墙；宿主在回合结束前清空 steer
 * 队列，忙时入队的消息以同回合续跑送达，不会沦为唤醒者。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
 * 统一投递。返回语义两分支不对称，调用方依赖它：
 * - 主回合在跑：卡片进 steer 队列，入队即 resolve；
 * - 主回合歇透：前门 sendUserMessage 唤起，等整个唤醒回合结束才 resolve。
 * Master 靠后者让在飞数覆盖唤醒回合（投递完成前不归零）；观察员在此期间不评估新增量。
 */
export async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Delivery,
): Promise<void> {
	if (ctx.isIdle()) {
		await pi.sendUserMessage(envelope.content);
		return;
	}
	pi.sendMessage(
		{ customType: envelope.customType, content: envelope.content, display: true },
		{ deliverAs: "steer" },
	);
}
