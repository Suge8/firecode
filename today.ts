/**
 * 系统提示里的日期。Pi 上游为保提示词缓存删掉了日期（earendil-works/pi#6621），这里作为独立段放回：
 * 会话第一次开跑时写入当天，之后沿用会话里已有的那个，不随跨天更新。
 * 宿主把段更新追加在对话末尾，但把对话中途的系统消息并进系统提示的网关会因此重写整段缓存。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { msg } from "./messages.js";

const DATE = /\d{4}-\d{2}-\d{2}/;

export function registerToday(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		let written: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "system") continue;
			written = entry.message.sections?.date?.match(DATE)?.[0] ?? written;
		}
		// sv-SE 的日期格式就是本地时区的 YYYY-MM-DD。
		event.systemPromptOptions.sections.date = msg.today(written ?? new Date().toLocaleDateString("sv-SE"));
	});
}
