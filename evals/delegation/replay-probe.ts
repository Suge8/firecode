// 重放探针：主会话的每个工具调用一律拦下不执行（被重放的会话属于有生产权限的项目），只记一行证据，由 replay.ts 随即停掉进程。
// /eval-wake 把截下的子代理事件按生产投递路径重发：自定义消息 + triggerTurn（见 deliver.ts），不改成用户消息。
import { appendFileSync, readFileSync } from "node:fs";

export default function replayProbe(pi: any) {
	const log = process.env.EVAL_LOG;
	if (!log) throw new Error("EVAL_LOG 未设置");
	pi.on("tool_call", (event: any) => {
		appendFileSync(log, JSON.stringify({ t: Date.now(), tool: event.toolName }) + "\n");
		return { block: true, reason: "[eval] 重放环境不执行任何工具" };
	});
	const wake = process.env.EVAL_WAKE;
	if (wake) {
		pi.registerCommand("eval-wake", {
			description: "重发截下的子代理事件",
			handler: async () => pi.sendMessage(JSON.parse(readFileSync(wake, "utf8")), { triggerTurn: true }),
		});
	}
}
