/**
 * 系统提示里的当天日期。Pi 上游为保提示词缓存删掉了日期（earendil-works/pi#6621），这里作为独立段放回：
 * 每次开跑时写入，同一次运行内不变；日期变了宿主只在对话末尾追加一条段更新，不改已缓存的前缀。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { msg } from "./messages.js";

export function registerToday(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		// sv-SE 的日期格式就是本地时区的 YYYY-MM-DD。
		event.systemPromptOptions.sections.date = msg.today(new Date().toLocaleDateString("sv-SE"));
	});
}
