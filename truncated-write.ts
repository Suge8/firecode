/**
 * 拦截把 read 截断结果整体写回的 write：宿主 read 截断时在正文末尾追加“…Use offset=N to continue.]”，
 * codemode 脚本把它原样写回会把文件清成半截（出过两次，测试文件被截断还被提交）。不属于任何可关的功能，每个会话都注册。
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { msg } from "./messages.js";

/** 与宿主 core/tools/read.ts 的截断提示同形。 */
const READ_TRUNCATION = /\n\[(?:Showing lines \d+-\d+ of \d+[^\]\n]*|\d+ more lines in file)\. Use offset=\d+ to continue\.\]/;

export function registerTruncatedWriteGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("write", event) || !READ_TRUNCATION.test(event.input.content)) return;
		return {
			block: true,
			reason: msg.truncatedWrite,
		};
	});
}
