/**
 * 会话自动命名（只在主会话的交互与 RPC 模式；print/json 是一次性运行，子会话是 Worker）。
 *
 * 触发：会话没有名字时，用户的一条消息到达（input 事件）就在后台起名，不挡回合；同一会话同时只有一个请求在飞。
 * 输入只有这条消息的文字（约 1000 字节，不带图片）。模型只走 background.model 链、单次失败不重试也不退回主模型，
 * 标题照旧显示首句，下一条用户消息再试；模型认为没有可命名的任务（问候、闲聊）时返回空，同样不设名、下一条再试。
 *
 * 写回前复查：会话仍没有名字、且仍是发起时的会话才 setSessionName。会话拆除（切换、/new、/resume、退出）时 session_shutdown 中止在飞请求，
 * 旧会话的结果不会写进新会话；用户在请求期间手动 /name、改名键或 CuePad 设的名字永远优先。
 * 只起一次：有名字之后不再触发，不随会话推进重起名——名字是用户对会话的第一印象，自动改写会让他在列表里认不出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { oneLine } from "../format.js";
import { readPrompt } from "../i18n.js";
import type { InProcessSessionPool } from "../spawn.js";
import { cleanName } from "../statusbar/title.js";

const PROMPT = readPrompt(new URL("./prompts/", import.meta.url), "naming");

const INPUT_BYTES = 1_000;
/** 名字的字符上限：提示词要求中文约 20 字，这里只挡模型不听话。 */
const NAME_CHARS = 40;
/** 低思考档的推理也计入输出额度，留够免得一句话被截断。 */
const MAX_TOKENS = 1_024;
const WRAPPING = /^["'`“”‘’「」]+|["'`“”‘’「」]+$/gu;
const TRAILING_STOP = /[.。]+$/u;

/** 按字节截断，不留下被切坏的末尾字符。 */
function head(text: string): string {
	const bytes = Buffer.from(text);
	return bytes.length <= INPUT_BYTES ? text : bytes.subarray(0, INPUT_BYTES).toString().replace(/\uFFFD+$/u, "");
}

function nameOf(text: string): string {
	const first = text.split("\n").map((line) => oneLine(cleanName(line)).replace(WRAPPING, "").replace(TRAILING_STOP, "").trim()).find(Boolean) ?? "";
	return Array.from(first).slice(0, NAME_CHARS).join("");
}

export function registerSessionNaming(pi: ExtensionAPI, pool: InProcessSessionPool, chain: ModelChain): void {
	let flight: AbortController | undefined;
	pi.on("input", (event, ctx) => {
		const text = event.text.trim();
		if (flight || !text || ctx.mode === "print" || ctx.mode === "json" || pi.getSessionName()) return { action: "continue" };
		const controller = flight = new AbortController();
		void name(head(text), controller).finally(() => { if (flight === controller) flight = undefined; });
		return { action: "continue" };
	});
	pi.on("session_shutdown", () => {
		flight?.abort();
		flight = undefined;
	});

	async function name(text: string, controller: AbortController): Promise<void> {
		try {
			const { message } = await pool.complete(
				chain,
				{ systemPrompt: PROMPT, messages: [{ role: "user", content: text, timestamp: Date.now() }] },
				{ maxTokens: MAX_TOKENS, signal: controller.signal },
			);
			const result = nameOf(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
			if (result && !controller.signal.aborted && !pi.getSessionName()) pi.setSessionName(result);
		} catch {
			// 单次失败不打扰用户：标题仍显示首句，下一条用户消息再试。
		}
	}
}
