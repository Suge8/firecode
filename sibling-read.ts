/**
 * 同一批并行调用里读兄弟正在生成的文件：read 常先跑完得 ENOENT（如 [bash 生成 out.png, read out.png]），模型再花一整轮重读。
 * read 得 ENOENT 且同层还有兄弟在跑时，等它们全部结束再用宿主的 read 重读一次，
 * 一批结果本就整批交回模型，等待不加长这一轮。codemode 脚本里的嵌套调用同理：只等同一个父调用下的兄弟，不等父调用。
 * 不属于任何可关的功能，每个会话都注册。
 */
import { createReadToolDefinition, isReadToolResult, SettingsManager, type ExtensionAPI, type ExtensionToolContext, type ReadToolInput } from "@earendil-works/pi-coding-agent";

const NOT_FOUND = /\bENOENT\b/;

export function registerSiblingRead(pi: ExtensionAPI): void {
	/** 每层（父调用 id，顶层为空串）开跑了、还没结束的调用。 */
	const running = new Map<string, Set<string>>();
	/** 停在这里等兄弟的 read。它们彼此不等，否则同批两个 read 都 ENOENT 时互相卡住。 */
	const waiting = new Map<string, { level: string; release(): void }>();
	const othersAllWaiting = (level: string, id: string) =>
		[...running.get(level) ?? []].every((other) => other === id || waiting.has(other));
	const settle = () => {
		for (const [id, { release }] of [...waiting].filter(([id, { level }]) => othersAllWaiting(level, id))) {
			waiting.delete(id);
			release();
		}
	};

	// 开跑以 tool_call 为准，不用 tool_execution_start：嵌套调用在串行执行时先发 start 再排队，等排在自己身后的兄弟会卡死。
	pi.on("tool_call", (event) => {
		const level = event.parentToolCallId ?? "";
		running.set(level, (running.get(level) ?? new Set()).add(event.toolCallId));
	});
	pi.on("tool_execution_end", (event) => {
		const level = event.parentToolCallId ?? "";
		const calls = running.get(level);
		calls?.delete(event.toolCallId);
		if (calls?.size === 0) running.delete(level);
		settle();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isReadToolResult(event) || !event.isError || !event.content.some((block) => block.type === "text" && NOT_FOUND.test(block.text))) return;
		const level = event.parentToolCallId ?? "";
		if (othersAllWaiting(level, event.toolCallId)) return;
		await new Promise<void>((release) => {
			waiting.set(event.toolCallId, { level, release });
			settle();
		});
		const read = createReadToolDefinition(ctx.cwd, { autoResizeImages: SettingsManager.inMemory(pi.getSettings()).getImageAutoResize() });
		try {
			// tool_result 的上下文没有 executeTool；宿主 read 只用其中的 cwd 与 model。
			const result = await read.execute(event.toolCallId, event.input as ReadToolInput, ctx.signal, undefined, ctx as ExtensionToolContext);
			return { ...result, isError: false };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return NOT_FOUND.test(text) ? undefined : { content: [{ type: "text", text }], isError: true };
		}
	});
}
