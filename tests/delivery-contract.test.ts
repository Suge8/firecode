import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { until } from "./until.ts";
import { FIRECODE_DIR, PI_AI_COMPAT_URL, PI_AI_URL, PI_CODING_AGENT_URL } from "./loader.ts";

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
async function hostSession(extensionSource: string, responses: unknown[], options: Record<string, unknown> = {}, settings?: unknown) {
	directory = await mkdtemp(join(tmpdir(), "firecode-delivery-contract-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const extensionsDir = join(agentDir, "extensions");
	await Promise.all([mkdir(cwd), mkdir(extensionsDir, { recursive: true })]);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	await writeFile(join(extensionsDir, "contract.ts"), extensionSource);
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));

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

test("回合进行中 deliver 经 steer 入队：已发出的前缀不变，工具结果之后的下一次请求带上它", async () => {
	const requests: any[][] = [];
	const record = (reply: unknown) => (context: any) => {
		requests.push(structuredClone(context.messages));
		return reply;
	};
	const session = await hostSession(`
import { deliver } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	let delivered = false;
	pi.on("tool_execution_start", (_event, ctx) => {
		if (delivered) return;
		delivered = true;
		void deliver(pi, ctx, { customType: "delivery-contract", content: ${JSON.stringify(DELIVERY_TEXT)} });
	});
}
`, [record(toolCallResponse), record(fauxAssistantMessage("delivery observed"))], waitToolOptions);

	try {
		await session.bindExtensions({ mode: "print" });
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

// 宿主在 agent_start 之前就从 sendMessage 返回：deliver 过早 resolve 会让 Master 先扣在飞数，busy.ts 在唤醒回合开始前误报歇下（报告现场：一段被拆成两条轮记录）。
test("歇透时 deliver 等它开的回合 agent_start 之后才 resolve", async () => {
	const session = await hostSession(`
import { deliver, wrapEnvelope } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	const order = (globalThis.__wakeOrder = []);
	pi.on("agent_start", () => { order.push("agent_start"); });
	pi.on("session_start", (_event, ctx) => {
		globalThis.__deliverIdle = () => deliver(pi, ctx, { customType: "firecode-master-event", content: wrapEnvelope("firecode_master_event", "worker done") })
			.then(() => order.push("delivered"));
	});
}
`, [fauxAssistantMessage("woken")]);
	try {
		await session.bindExtensions({ mode: "print" });
		await (globalThis as any).__deliverIdle();
		await session.waitForIdle();
		expect((globalThis as any).__wakeOrder).toEqual(["agent_start", "delivered"]);
	} finally {
		delete (globalThis as any).__wakeOrder;
		delete (globalThis as any).__deliverIdle;
		session.dispose();
	}
}, 10_000);

test("review 的修复反馈与总结提示经 deliver 唤起：回合的每次请求都经过 before_agent_start，扩展注入的段不被撤下", async () => {
	const requests: { prompt: string; first: string }[] = [];
	const record = (reply: unknown) => (context: any) => {
		const user = context.messages.find((message: any) => message.role === "user");
		requests.push({
			prompt: getCurrentSystemPrompt(context.messages),
			first: typeof user.content === "string" ? user.content : user.content.map((part: any) => part.text ?? "").join(""),
		});
		return reply;
	};
	const session = await hostSession(`
import { deliver, wrapEnvelope } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.guidelines_mark = "GUIDELINES-MARK"; });
	pi.on("session_start", (_event, ctx) => {
		globalThis.__deliverFix = () => deliver(pi, ctx, { customType: "firecode-review-card", content: wrapEnvelope("firecode_review", "fix the findings") });
	});
}
`, [record(toolCallResponse), record(fauxAssistantMessage("fixed"))], waitToolOptions);
	try {
		await session.bindExtensions({ mode: "print" });
		// 修复回合第一次工具调用之后的请求，系统提示里仍有扩展注入的段（pi 1.2.0 之前 triggerTurn 开的回合会在这里把它撤下，#33）。
		await (globalThis as any).__deliverFix();
		await session.waitForIdle();
		expect(requests).toHaveLength(2);
		expect(requests.every(({ prompt }) => prompt.includes("GUIDELINES-MARK"))).toBe(true);
		expect(requests[0].first).toBe("<firecode_review>\nfix the findings\n</firecode_review>");
	} finally {
		delete (globalThis as any).__deliverFix;
		session.dispose();
	}
}, 10_000);

// 手动 /compact 不在回合里：宿主 isIdle 为 false，但 steer 只会被当场追加、没有回合可续。deliver 要等压缩落定再唤起。
test("手动 /compact 期间 deliver：压缩真正落定后（含其他扩展较慢的 session_compact 处理器）才唤起一个回合，信封进上下文", async () => {
	const requests: string[] = [];
	let release!: () => void;
	const summaryGate = new Promise<void>((resolve) => { release = resolve; });
	const session = await hostSession(`
import { deliver, wrapEnvelope } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	// 排在 deliver 的登记之后的其他扩展：宿主逐个 await 处理器，压缩状态要等它跑完才清。
	pi.on("session_compact", () => new Promise((resolve) => setTimeout(resolve, 80)));
	pi.on("session_start", (_event, ctx) => {
		globalThis.__deliverDuringCompaction = () => deliver(pi, ctx, { customType: "firecode-review-card", content: wrapEnvelope("firecode_master_event", "worker done") });
	});
}
`, [
		fauxAssistantMessage("ok 1"),
		fauxAssistantMessage("ok 2"),
		fauxAssistantMessage("ok 3"),
		async () => { await summaryGate; return fauxAssistantMessage("SUMMARY"); },
		(context: any) => {
			const last = context.messages.at(-1);
			requests.push(typeof last.content === "string" ? last.content : last.content.map((part: any) => part.text ?? "").join(""));
			return fauxAssistantMessage("handled");
		},
	], {}, { compaction: { enabled: false, keepRecentTokens: 5 } });
	try {
		await session.bindExtensions({ mode: "print" });
		for (let turn = 1; turn <= 3; turn++) await session.prompt(`message ${turn} ${"word ".repeat(200)}`);
		const compacting = session.compact();
		await until(() => session.isCompacting);
		const delivered = (globalThis as any).__deliverDuringCompaction();
		const early = await Promise.race([delivered.then(() => "resolved"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);
		expect(early).toBe("pending");

		release();
		await compacting;
		await delivered;
		await session.waitForIdle();
		expect(requests).toEqual(["<firecode_master_event>\nworker done\n</firecode_master_event>"]);
	} finally {
		delete (globalThis as any).__deliverDuringCompaction;
		session.dispose();
	}
}, 15_000);

/** 三轮对话后切回第一条助手消息并生成分支摘要；摘要请求卡在闸门上，摘要期间调 deliver。 */
async function summarizingSession() {
	const requests: string[] = [];
	let release!: () => void;
	const summaryGate = new Promise<void>((resolve) => { release = resolve; });
	const session = await hostSession(`
import { deliver, wrapEnvelope } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		globalThis.__deliverDuringSummary = () => deliver(pi, ctx, { customType: "firecode-review-card", content: wrapEnvelope("firecode_master_event", "worker done") });
	});
}
`, [
		fauxAssistantMessage("ok 1"),
		fauxAssistantMessage("ok 2"),
		fauxAssistantMessage("ok 3"),
		async () => { await summaryGate; return fauxAssistantMessage("BRANCH SUMMARY"); },
		(context: any) => {
			const last = context.messages.at(-1);
			requests.push(typeof last.content === "string" ? last.content : last.content.map((part: any) => part.text ?? "").join(""));
			return fauxAssistantMessage("handled");
		},
	]);
	await session.bindExtensions({ mode: "print" });
	for (let turn = 1; turn <= 3; turn++) await session.prompt(`message ${turn}`);
	const firstAssistant = session.sessionManager.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "assistant");
	const navigating = session.navigateTree(firstAssistant.id, { summarize: true });
	await until(() => session.isCompacting);
	const delivered = (globalThis as any).__deliverDuringSummary();
	const early = await Promise.race([delivered.then(() => "resolved"), new Promise((resolve) => setTimeout(() => resolve("pending"), 100))]);
	const onCurrentBranch = () => session.sessionManager.getBranch().some((entry: any) =>
		entry.type === "custom_message" && JSON.stringify(entry.content).includes("worker done"));
	return { session, requests, release, navigating, delivered, early, onCurrentBranch };
}

// 宿主在摘要期间 isIdle 为 false 却没有回合：steer 会把消息追加在即将被丢下的旧分支上，模型永远看不到，也没人被唤起。
test("带摘要的 /tree 切换期间 deliver：摘要结束后才唤起一个回合，信封在切换后的当前分支上", async () => {
	const { session, requests, release, navigating, delivered, early, onCurrentBranch } = await summarizingSession();
	try {
		expect(early).toBe("pending");

		release();
		expect((await navigating).cancelled).toBe(false);
		await delivered;
		await session.waitForIdle();
		expect(requests).toEqual([ENVELOPE_TEXT]);
		expect(onCurrentBranch()).toBe(true);
	} finally {
		delete (globalThis as any).__deliverDuringSummary;
		session.dispose();
	}
}, 15_000);

// 指挥官在回合里被中止（Esc、流式中断、/compact 开头的中止）后，在途的投递不能丢、不能重、也不能卡到用户下次输入。
const ENVELOPE_TEXT = "<firecode_master_event>\nworker done\n</firecode_master_event>";
const messageText = (message: any) => typeof message.content === "string"
	? message.content
	: message.content?.map((part: any) => part.text ?? "").join("") ?? "";
const eventCount = (messages: string[]) => messages.filter((text) => text === ENVELOPE_TEXT).length;

/** 工具卡在闸门上：测试在工具执行中放闸；`__deliverNow` 由测试或首个工具开始时调用，只投一次。 */
const gatedExtension = (armOnTool: boolean) => `
import { deliver, wrapEnvelope } from ${JSON.stringify(join(FIRECODE_DIR, "deliver.ts"))};
export default function (pi) {
	let sent = false;
	pi.on("session_start", (_event, ctx) => {
		globalThis.__deliverNow = () => {
			if (sent) return;
			sent = true;
			globalThis.__sent = true;
			void deliver(pi, ctx, { customType: "firecode-master-event", content: wrapEnvelope("firecode_master_event", "worker done") });
		};
	});
	${armOnTool ? 'pi.on("tool_execution_start", () => globalThis.__deliverNow());' : ""}
}`;

function stalledSession(source: string, responses: unknown[]) {
	const gate = Promise.withResolvers<void>();
	const requests: string[][] = [];
	const gatedTool = {
		...waitTool,
		execute: async () => { await gate.promise; return { content: [{ type: "text", text: "tool completed" }], details: {} }; },
	};
	const record = (reply: unknown) => async (context: any) => {
		requests.push(context.messages.map(messageText));
		return typeof reply === "function" ? (reply as () => unknown)() : reply;
	};
	return hostSession(source, responses.map(record), { tools: ["contract_wait"], customTools: [gatedTool] })
		.then((session) => ({ session, requests, gate }));
}

/** 事件没等用户输入就到达模型，最后一次请求里恰好一份；用户随后再发话也不重复。 */
async function expectDeliveredOnce(session: any, requests: string[][]) {
	await until(() => requests.some((request) => request.includes(ENVELOPE_TEXT)));
	await session.waitForIdle();
	expect(eventCount(requests.at(-1)!)).toBe(1);
	await session.prompt("user follows up");
	expect(eventCount(requests.at(-1)!)).toBe(1);
}

const idle = (text: string) => fauxAssistantMessage(text);

test.each([
	["工具执行中，用户清队列后中止（Esc）", "tool", true],
	["模型流式输出中，队列没清", "stream", false],
] as const)("投递在途时回合被中止（%s）：不等用户输入自动唤醒，恰好一次", async (_case, phase, clear) => {
	const streaming = phase === "stream";
	const stream = Promise.withResolvers<void>();
	const { session, requests, gate } = await stalledSession(gatedExtension(!streaming), [
		toolCallResponse,
		streaming ? async () => { await stream.promise; return idle("late"); } : idle("a"),
		idle("b"), idle("c"), idle("d"),
	]);
	try {
		await session.bindExtensions({ mode: "print" });
		if (streaming) gate.resolve();
		const run = session.prompt("go");
		if (streaming) {
			await until(() => requests.length === 2);
			(globalThis as any).__deliverNow();
		} else {
			await until(() => (globalThis as any).__sent);
		}
		if (clear) session.clearQueue();
		const aborting = session.abort();
		gate.resolve();
		stream.resolve();
		await aborting;
		await run.catch(() => {});
		await expectDeliveredOnce(session, requests);
	} finally {
		delete (globalThis as any).__deliverNow;
		delete (globalThis as any).__sent;
		session.dispose();
	}
}, 10_000);
