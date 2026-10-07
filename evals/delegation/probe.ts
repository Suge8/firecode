// 评测探针：记录所有（含 codemode 内嵌）工具调用；subagents start 只记录不执行，避免真起 Worker。
import { appendFileSync } from "node:fs";

const LIMIT_SCRIPT = 2500;
const LIMIT_INPUT = 500;

export default function probe(pi: any) {
	const log = process.env.EVAL_LOG;
	if (!log) throw new Error("EVAL_LOG 未设置");
	pi.on("tool_call", (event: any) => {
		const limit = event.toolName === "codemode" ? LIMIT_SCRIPT : LIMIT_INPUT;
		const input = typeof event.input === "string" ? event.input : JSON.stringify(event.input);
		appendFileSync(log, JSON.stringify({ t: Date.now(), tool: event.toolName, input: input.slice(0, limit), args: event.toolName === "subagents" ? event.input : undefined }) + "\n");
		if (event.toolName === "subagents" && event.input?.action === "start") return { block: true, reason: "[eval] 子代理启动已记录，评测环境不真正执行" };
	});
}
