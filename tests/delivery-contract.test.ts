import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_AI_COMPAT_URL, PI_AI_URL, PI_CODING_AGENT_URL } from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const { getCurrentSystemPrompt } = await import(PI_AI_URL) as any;
const { createAgentSession, ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
const DELIVERY_TEXT = "queued delivery";
let directory: string | undefined;
let faux: any;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

const waitTool = {
	name: "contract_wait",
	label: "Contract wait",
	description: "Completes one deterministic tool call",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: async () => ({ content: [{ type: "text", text: "tool completed" }], details: {} }),
};

/** 真实 SDK 会话 + faux 供应商：宿主契约在真实宿主上验证，extension 是写进 Agent 目录的扩展源码。 */
async function hostSession(extensionSource: string, responses: unknown[], options: Record<string, unknown> = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-delivery-contract-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const extensionsDir = join(agentDir, "extensions");
	await Promise.all([mkdir(cwd), mkdir(extensionsDir, { recursive: true })]);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	await writeFile(join(extensionsDir, "contract.ts"), extensionSource);

	faux = registerFauxProvider();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	faux.setResponses(responses);
	const { session } = await createAgentSession({
		cwd, agentDir, model, modelRuntime, sessionManager: SessionManager.inMemory(cwd), ...options,
	});
	return session;
}

const waitToolOptions = { tools: ["contract_wait"], customTools: [waitTool] };
const toolCallResponse = fauxAssistantMessage(fauxToolCall("contract_wait", {}), { stopReason: "toolUse" });

test("streaming steer delivery preserves the sent prefix and reaches the next request after tool results", async () => {
	const requests: any[][] = [];
	const record = (reply: unknown) => (context: any) => {
		requests.push(structuredClone(context.messages));
		return reply;
	};
	const session = await hostSession(`
export default function (pi) {
	let delivered = false;
	pi.on("tool_execution_start", () => {
		if (delivered) return;
		delivered = true;
		pi.sendMessage(
			{ customType: "delivery-contract", content: ${JSON.stringify(DELIVERY_TEXT)}, display: false },
			{ deliverAs: "steer", triggerTurn: true },
		);
	});
}
`, [record(toolCallResponse), record(fauxAssistantMessage("delivery observed"))], waitToolOptions);

	try {
		await session.prompt("start contract run");
		const [inFlightRequest, nextRequest] = requests;
		const messageText = (message: any) => typeof message.content === "string"
			? message.content
			: message.content?.map((part: any) => part.text ?? "").join("") ?? "";

		expect(requests).toHaveLength(2);
		expect(inFlightRequest.some((message) => messageText(message) === DELIVERY_TEXT)).toBe(false);
		expect(nextRequest.slice(0, inFlightRequest.length)).toEqual(inFlightRequest);
		expect(nextRequest.slice(inFlightRequest.length).map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"user",
		]);
		expect(messageText(nextRequest.at(-2))).toContain("tool completed");
		expect(messageText(nextRequest.at(-1))).toBe(DELIVERY_TEXT);
	} finally {
		session.dispose();
	}
}, 10_000);

test("idle wake via sendUserMessage runs before_agent_start on every request", async () => {
	const prompts: string[] = [];
	const record = (reply: unknown) => (context: any) => {
		prompts.push(getCurrentSystemPrompt(context.messages));
		return reply;
	};
	const session = await hostSession(`
export default function (pi) {
	pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\\n\\nGUIDELINES-MARK" }));
}
`, [record(toolCallResponse), record(fauxAssistantMessage("woken"))], waitToolOptions);

	try {
		// 会话歇透时的前门唤醒：deliver.ts 空闲分支依赖的宿主契约。
		await session.sendUserMessage("delivered while idle");
		expect(prompts).toHaveLength(2);
		expect(prompts.every((prompt) => prompt.includes("GUIDELINES-MARK"))).toBe(true);
	} finally {
		session.dispose();
	}
}, 10_000);

test("宿主契约：扩展 API 的 sendUserMessage 立即返回、不等唤醒回合；唤醒回合在 agent_start 后原样记录这条用户消息", async () => {
	const session = await hostSession(`
export default function (pi) {
	const order = (globalThis.__wakeOrder = []);
	pi.on("agent_start", () => { order.push("agent_start"); });
	pi.on("message_start", ({ message }) => {
		if (message.role === "user") order.push("user:" + (typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("")));
	});
	pi.registerCommand("wake", { handler: async () => {
		const returned = pi.sendUserMessage("woken from extension");
		order.push(returned === undefined ? "returned-void" : "returned-value");
	} });
}
`, [fauxAssistantMessage("woken")]);
	try {
		await session.bindExtensions({ mode: "print" });
		await session.prompt("/wake");
		while (!(globalThis as any).__wakeOrder.includes("agent_start")) await new Promise((resolve) => setTimeout(resolve, 5));
		await session.waitForIdle();
		// 唤醒回合的第一条用户消息就是这条正文原样：deliver 据此确认送达，而不是见到任何 agent_start 就算。
		expect((globalThis as any).__wakeOrder).toEqual(["returned-void", "agent_start", "user:woken from extension"]);
	} finally {
		delete (globalThis as any).__wakeOrder;
		session.dispose();
	}
}, 10_000);
