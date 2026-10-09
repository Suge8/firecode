import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { dirname, join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import {
	featuresOnly,
	firecodeModulePath,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_AI_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
} from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const { getCurrentSystemPrompt } = await import(PI_AI_URL) as any;
const TEST_ROLES = {
	工程师: { model: "test/worker/medium", use: "测试" },
	设计师: { model: "test/worker-2/high", use: "切换测试" },
};
const TIMEOUT_DETAILS = "模型 1 · test/reviewer\n审查会话超时，未在时限内返回有效输出。";
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

let faux: any;
let directory: string | undefined;

afterEach(async () => {
	setSystemTime();
	delete (globalThis as any).__reviewTick;
	delete (globalThis as any).__modelGate;
	delete (globalThis as any).__inputGate;
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

test("新会话默认激活 subagents", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	expect(harness.activeTools).toEqual(["read", "bash", "edit", "write", "subagents", "subagents_list"]);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("autoActivate false 的新会话不注入，仍可手动启动", async () => {
	const harness = await setup(false, { autoActivate: false });
	await harness.emit("session_start", {});
	expect(harness.activeTools).toEqual(["read", "bash", "edit", "write"]);
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
	await harness.command("");
	expect(harness.activeTools).toContain("subagents");
});

test("/fire-master status 每个子代理一行，以角色为主、模型短名次之", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("完成")]);
	for (const [worker, role] of [["scout", "工程师"], ["verify", "设计师"]]) {
		const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
		await harness.execute({ action: "start", worker, prompt: "执行", role });
		await settled;
	}
	await harness.command("status");
	expect(harness.notices.at(-1)).toBe("scout 工程师·空闲 worker\nverify 设计师·空闲 worker-2");
});

test("子代理池状态文件落在 Pi Agent 目录（含 PI_CODING_AGENT_DIR 覆写），不写死家目录", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "where", prompt: "执行", role: "工程师" });
	await settled;
	const files = await readdir(join(harness.agentDir, "tmp"));
	expect(files).toContain(`firecode-master-${harness.sessionId}.json`);
});

test("边框身份只发布“指挥官”，子代理进出不改变它", async () => {
	const harness = await setup();
	expect(stripVTControlCharacters(harness.statuses.get("master")!)).toBe("指挥官");
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "status-id", prompt: "执行", role: "工程师" });
	expect(stripVTControlCharacters(harness.statuses.get("master")!)).toBe("指挥官");
	await settled;
	expect(stripVTControlCharacters(harness.statuses.get("master")!)).toBe("指挥官");
});

test("裸 /fire-master 来回翻转当前会话，status 保留并拒绝旧参数", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	await harness.command("");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
	await harness.command("status");
	expect(harness.notices.at(-1)).toBe("指挥官模式未启动");
	await harness.command("");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	await harness.command("off");
	expect(harness.notices.at(-1)).toContain("只接受 status");
});

test("Master Markdown 与动态角色表按单一接缝注入", async () => {
	const harness = await setup();
	const prompt = await loadFirecodeModule("master/prompt.js") as any;
	const expected = prompt.assembleMasterPrompt(
		prompt.readMasterPrompt("master"),
		"工程师：test/worker/medium（测试）；设计师：test/worker-2/high（切换测试）",
	);
	expect(expected.startsWith(prompt.readMasterPrompt("master"))).toBe(true);
	expect(expected.endsWith("\n\n角色表：工程师：test/worker/medium（测试）；设计师：test/worker-2/high（切换测试）。")).toBe(true);
	expect(await harness.systemPrompt("自定义系统提示")).toBe(`自定义系统提示\n\n${expected}`);
	await harness.command("");
	expect(await harness.systemPrompt("自定义系统提示")).toBe("自定义系统提示");
});

test("Worker 的系统提示带上自己的名字，包在协议信封里", async () => {
	const harness = await setup();
	let systemPrompt = "";
	faux.setResponses([(context: any) => {
		systemPrompt = getCurrentSystemPrompt(context.messages);
		return fauxAssistantMessage("完成");
	}]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "prompt-contract", prompt: "执行", role: "工程师",
	});
	await settled;
	expect(systemPrompt).toContain('<firecode_worker name="prompt-contract">');
	expect(systemPrompt).toContain("</firecode_worker>");
});

test("Master prompt 缺失或为空时只关闭 Master 并明确失败", async () => {
	const missing = await loadFirecodeModule("master/prompt.js") as any;
	expect(() => missing.readMasterPrompt("missing")).toThrow("Master missing prompt 读取失败");

	for (const kind of ["master", "worker"]) {
		const empty = await loadFirecodeModule("master/prompt.js", {
			extraFiles: { [`master/prompts/${kind}.zh.md`]: " \n" },
		}) as any;
		expect(() => empty.readMasterPrompt(kind)).toThrow(`Master ${kind} prompt 为空`);
	}

	const harness = await setup(true, {
		promptFiles: { "master/prompts/master.zh.md": " \n" },
	});
	expect(harness.notices.at(-1)).toContain("Master master prompt 为空");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
});

test("真 SDK 在执行前拒绝缺 worker 与旧 list 动作", async () => {
	const harness = await setup();
	const { createAgentSession, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	let executions = 0;
	const commandTool = {
		...harness.commandTool,
		execute: async (...args: any[]) => {
			executions += 1;
			return harness.commandTool.execute(...args);
		},
	};
	const { session } = await createAgentSession({
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		model: harness.model,
		modelRuntime: harness.modelRuntime,
		tools: ["subagents"],
		customTools: [commandTool],
		sessionManager: SessionManager.inMemory(harness.cwd),
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagents", {
			action: "start", prompt: "执行", role: "工程师",
		}), { stopReason: "toolUse" }),
		fauxAssistantMessage("已拒绝"),
	]);
	await session.prompt("调用 start，但不要传 worker");
	let result = session.messages.find((message: any) => message.role === "toolResult");
	expect(result?.isError).toBe(true);
	expect(JSON.stringify(result?.content)).toContain("worker");
	expect(executions).toBe(0);

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagents", { action: "list", worker: "pool" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("已拒绝"),
	]);
	await session.prompt("调用旧 list 动作");
	result = session.messages.findLast((message: any) => message.role === "toolResult");
	expect(result?.isError).toBe(true);
	expect(JSON.stringify(result?.content)).toContain("action");
	expect(executions).toBe(0);
	session.dispose();
});

test("角色表、原子与 fallback 配置错误时拒绝启动", async () => {
	const harness = await setup(true, {
		roles: {
			工程师: {
				model: "invalid/high",
				thinking: "medium",
				use: "旧写法",
				fallback: ["test/a/low", "test/b/low", "test/c/low"],
			} as any,
		},
	});
	expect(harness.notices.join("\n")).toContain("Master 配置有问题，已停止");
	expect(harness.notices.join("\n")).toContain("未知字段 master.roles.工程师.thinking");
	expect(harness.notices.join("\n")).toContain(
		"master.roles.工程师.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：invalid）",
	);
	expect(harness.notices.join("\n")).toContain("master.roles.工程师.fallback 必须是至多 2 项的数组");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
});

test("角色表提示词与 role 枚举都只来自已配置角色", async () => {
	const harness = await setup(true, { roles: { 工程师: TEST_ROLES.工程师 } });
	const prompt = await harness.systemPrompt("主提示词");
	expect(prompt).toContain("角色表：工程师：test/worker/medium（测试）");
	expect(prompt).not.toContain("设计师：");
	expect(harness.commandTool.parameters.properties.role.enum).toEqual(["工程师"]);
	await expect(harness.execute({
		action: "start", worker: "missing-role", prompt: "执行",
	})).rejects.toThrow("start 必须指定 role");
});

test("subagents 是 worker 必填的七命令，池快照是独立零参查询", async () => {
	const harness = await setup();
	expect(harness.commandTool.parameters.type).toBe("object");
	expect(harness.commandTool.parameters.required).toEqual(["action", "worker"]);
	expect(harness.commandTool.parameters.properties.action.anyOf?.map((item: any) => item.const)
		?? harness.commandTool.parameters.properties.action.enum).not.toContain("list");
	expect(harness.commandTool.parameters.properties).not.toHaveProperty("model");
	expect(harness.commandTool.parameters.properties.role.enum).toEqual(["工程师", "设计师"]);
	expect(harness.listTool.parameters.required ?? []).toEqual([]);
	expect(Object.keys(harness.listTool.parameters.properties)).toEqual([]);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("list 展开投影 working 的当前工具，但模型正文不含动作", async () => {
	const harness = await setup();
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	let releaseTool!: () => void;
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	faux.setResponses([
		async () => {
			await responseGate;
			return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("完成"),
	]);
	const started = await harness.execute({
		action: "start", worker: "observed", prompt: "读取约束", role: "工程师",
	});
	const session = harness.pool.getSession((started.details as any).worker.session);
	const toolStarted = new Promise<void>((resolve) => session.subscribe(async (event: any) => {
		if (event.type !== "tool_execution_start") return;
		resolve();
		await toolGate;
	}));
	const toolEventBefore = Date.now();
	releaseResponse();
	await toolStarted;
	const toolEventAfter = Date.now();

	const listed = await harness.list();
	expect(JSON.parse(listed.content[0].text)).toEqual({ workers: [expect.objectContaining({ name: "observed", status: "working" })] });
	expect(listed.content[0].text).not.toContain("currentAction");
	const workingAction = (listed.details as any).workers[0].currentAction;
	expect(workingAction).toMatchObject({ kind: "tool", tool: "read" });
	expect(typeof workingAction.startedAt).toBe("number");
	expect(workingAction.startedAt >= toolEventBefore).toBe(true);
	expect(workingAction.startedAt <= toolEventAfter).toBe(true);
	const collapsed = harness.renderListLine(listed);
	expect(collapsed).toHaveLength(1);
	expect(collapsed[0]).toContain("池 1：observed 工程师·工作");
	(listed.details as any).workers[0].currentAction.startedAt = Date.now() - 300;
	const expanded = harness.renderResult(listed, true).join("\n");
	expect(expanded).toContain("observed");
	expect(expanded).toMatch(/工程师·工作 · read · 已 0\.[34]s/u);

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const settledBefore = Date.now();
	releaseTool();
	await delivered;
	const settledAfter = Date.now();
	const idle = await harness.list();
	const idleAction = (idle.details as any).workers[0].currentAction;
	expect(idleAction).toMatchObject({ kind: "idle" });
	expect(typeof idleAction.since).toBe("number");
	expect(idleAction.since >= settledBefore).toBe(true);
	expect(idleAction.since <= settledAfter).toBe(true);
	expect((idle.details as any).workers[0].currentAction).not.toHaveProperty("tool");
	(idle.details as any).workers[0].currentAction.since = Date.now() - 65_000;
	const idleLine = harness.renderResult(idle, true).join("\n");
	expect(idleLine).toContain("落定 1m5s前");
});

test("Master 是在飞子代理数的唯一发布者：数量变化发布计数，停用时收口", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "pub", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await settled;
	await Bun.sleep(0);
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	expect(counts()).toEqual([1, 0]);

	faux.setResponses([fauxAssistantMessage("再来一次")]);
	const second = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "pub", prompt: "继续" });
	await second;
	await Bun.sleep(0);
	expect(counts()).toEqual([1, 0, 1, 0]);

	// 停用时在飞数归零；已经归零不再重复发布。
	await harness.command("");
	expect(counts()).toEqual([1, 0, 1, 0]);
});

test("名册发布在 firecode:subagents：角色、模型、状态、在做什么与时刻，停用时发空名册", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" }), fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "roster", prompt: "读取约束", role: "工程师", thinking: "low" });
	await settled;
	await Bun.sleep(0);
	const rosters = () => harness.emitted.filter(([channel]) => channel === "firecode:subagents").map(([, payload]) => payload.workers);
	const running = rosters().flat().find((worker: any) => worker.action.includes("AGENTS.md"));
	expect(running).toMatchObject({ name: "roster", role: "工程师", model: "test/worker", thinking: "low", state: "running" });
	expect(typeof running.startedAt).toBe("number");
	expect(running).not.toHaveProperty("settledAt");
	const last = rosters().at(-1)![0];
	expect(last).toMatchObject({ name: "roster", state: "done", action: "完成", startedAt: running.startedAt });
	expect(last.settledAt).toBeGreaterThanOrEqual(running.startedAt);

	await harness.command("");
	expect(rosters().at(-1)).toEqual([]);
});

test("子代理落定后，结果事件交给指挥官之前仍算在飞：闲时前门唤醒要等唤醒回合开始才归零（宿主 sendUserMessage 不等回合）", async () => {
	const harness = await setup(true, { holdWake: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "late", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await harness.userMessageStarted;
	await Bun.sleep(5);
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	// worker 已落定为 idle，前门消息已发出但唤醒回合还没开始：不能归零，否则会话会在唤醒前误报一次“歇下”。
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("idle");
	expect(counts()).toEqual([1]);

	await harness.wake();
	await Bun.sleep(5);
	expect(counts()).toEqual([1, 0]);
	await harness.command("");
});

test("报告现场时序：最后一个子代理在指挥官空闲时返回，整段只歇下一次，且在唤醒回合落定之后", async () => {
	const harness = await setup(true, { holdWake: true });
	const { watchBusy } = await loadFirecodeModule("busy.ts") as any;
	const rounds: any[] = [];
	watchBusy(harness.pi, { onSettled: (_ctx: unknown, round: unknown) => rounds.push(round) });
	try {
		at(0);
		// 指挥官回合派出子代理后歇着等。
		await harness.emit("agent_start", {});
		const finish = Promise.withResolvers<void>();
		faux.setResponses([async () => { await finish.promise; return fauxAssistantMessage("完成"); }]);
		await harness.execute({ action: "start", worker: "last", prompt: "执行", role: "工程师" });
		harness.idle = true;
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		await harness.emit("agent_settled", {});
		expect(rounds).toEqual([]);

		at(373);
		finish.resolve();
		await harness.userMessageStarted;
		await Bun.sleep(5);
		// 前门消息已发出、唤醒回合还没开始：不能歇下（报告里这里先写了一条整段记录）。
		expect(rounds).toEqual([]);

		harness.idle = false;
		await harness.wake();
		await Bun.sleep(5);
		expect(rounds).toEqual([]);
		at(376);
		harness.idle = true;
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		await harness.emit("agent_settled", {});
		expect(rounds).toEqual([{ elapsed: 376_000, outcome: "complete" }]);
	} finally {
		await harness.command("");
	}
});

test("指挥官空闲时陆续到达的一批结果合并成一次唤醒；指挥官在跑时照旧立即句缝送达", async () => {
	const harness = await setup(true, { wakeQuietMs: 80 });
	harness.idle = true;
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	faux.setResponses(gates.map((gate, index) => async () => { await gate.promise; return fauxAssistantMessage(`结果 ${index}`); }));
	await harness.execute({ action: "start", worker: "batch-a", prompt: "A", role: "工程师" });
	await harness.execute({ action: "start", worker: "batch-b", prompt: "B", role: "工程师" });
	gates[0].resolve();
	await Bun.sleep(40);
	// 第一条到达后安静窗口内不唤醒，等同批的下一条。
	expect(harness.userMessages).toEqual([]);
	gates[1].resolve();
	await Bun.sleep(200);
	expect(harness.userMessages).toHaveLength(1);
	expect(harness.userMessages[0]).toContain("结果 0");
	expect(harness.userMessages[0]).toContain("结果 1");

	// 指挥官在跑：不等窗口，立即经 steer 送达。
	harness.idle = false;
	faux.setResponses([fauxAssistantMessage("忙时结果")]);
	const steered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const sentAt = Date.now();
	await harness.execute({ action: "send", worker: "batch-a", prompt: "再来" });
	await steered;
	expect(Date.now() - sentAt).toBeLessThan(80);
	expect(harness.messages.at(-1).options).toEqual({ deliverAs: "steer" });
	await harness.command("");
});

test("前门唤醒被宿主拒绝后用户自己开回合：事件不算送达，在同一回合经 steer 补投并确认，不丢", async () => {
	const harness = await setup(true, { holdWake: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("被拒的结果")]);
	await harness.execute({ action: "start", worker: "rejected", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await harness.userMessageStarted;
	await Bun.sleep(5);
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	const envelope = harness.userMessages[0];
	expect(harness.appended.map(([type]) => type)).toEqual(["firecode-master-pending-event"]);

	// 宿主在开回合前拒绝了前门消息（扩展订阅不到）；之后用户自己发消息开了一个回合。
	harness.idle = false;
	await harness.userTurn("我自己的新问题");
	await Bun.sleep(5);
	expect(harness.messages).toEqual([
		{ message: expect.objectContaining({ content: envelope }), options: { deliverAs: "steer" } },
	]);
	expect(harness.appended.map(([type]) => type)).toEqual(["firecode-master-pending-event", "firecode-master-event-ack"]);
	expect(counts()).toEqual([1, 0]);
	await harness.command("");
});

test("前门唤醒正常时只确认一次，不重复补投", async () => {
	const harness = await setup(true, { holdWake: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "woken", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await harness.userMessageStarted;
	await harness.wake();
	await harness.userTurn("之后用户又问了一句");
	await Bun.sleep(5);
	expect(harness.messages).toEqual([]);
	expect(harness.appended.map(([type]) => type)).toEqual(["firecode-master-pending-event", "firecode-master-event-ack"]);
	await harness.command("");
});

test("事件投递失败等待重试期间仍计入在飞", async () => {
	const harness = await setup(true, { failDeliveries: 1 });
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "retry", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await Bun.sleep(100);
	expect(harness.notices.some((notice) => notice.includes("投递失败"))).toBe(true);
	expect(harness.messages).toHaveLength(0);
	expect(harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight)).toEqual([1]);
	await harness.command("");
});

test("停用 Master 时仍有子代理在飞：先发布归零", async () => {
	const harness = await setup();
	faux.setResponses([async () => { await Bun.sleep(5_000); return fauxAssistantMessage("不会等到"); }]);
	await harness.execute({ action: "start", worker: "slow", prompt: "慢", role: "工程师", thinking: "low" });
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	expect(counts()).toEqual([1]);
	await harness.command("");
	expect(counts()).toEqual([1, 0]);
});

test("主回合忙碌时，subagents 以队列语义完成 start→事件落定→list→kill", async () => {
	const harness = await setup();
	await harness.emit("agent_start", {});
	faux.setResponses([fauxAssistantMessage("确定性完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });

	const started = await harness.execute({
		action: "start",
		worker: "trace",
		prompt: "只回复完成",
		role: "工程师",
		thinking: "low",
	});
	const worker = (started.details as any).worker;
	expect(worker).toMatchObject({ status: "working", role: "工程师", model: "test/worker", thinking: "low" });
	await settled;
	await Bun.sleep(0);

	const listed = await harness.list();
	expect(JSON.parse(listed.content[0].text).workers).toEqual([{ ...worker, status: "idle", disposition: "pending" }]);
	expect((listed.details as any).workers).toEqual([
		{ ...worker, status: "idle", disposition: "pending", currentAction: expect.objectContaining({ kind: "idle" }) },
	]);
	expect(harness.messages[0]).toMatchObject({
		message: { content: expect.stringMatching(/^<firecode_master_event>\ntrace 已返回\n回复：\n确定性完成\n耗时：[^\n]+\n<\/firecode_master_event>$/u) },
		options: { deliverAs: "steer" },
	});
	const trace = await harness.execute({ action: "tail", worker: "trace" });
	expect(trace.content[0].text).toContain("assistant: 确定性完成");
	const sessionPath = worker.session as string;
	expect(existsSync(sessionPath)).toBe(true);
	expect(dirname(sessionPath).endsWith("/subagents")).toBe(true);
	const { SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const visible = await SessionManager.list(harness.cwd, dirname(dirname(sessionPath)));
	expect(visible.some((session: any) => session.path === sessionPath)).toBe(false);

	await harness.execute({ action: "kill", worker: "trace" });
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	expect(existsSync(sessionPath)).toBe(true);
});

test("供应商故障在无 fallback 时明确报告链已用尽", async () => {
	const harness = await setup();
	faux.setResponses([async () => { throw new Error("quota exhausted"); }]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "failed", prompt: "执行", role: "工程师",
	});
	await delivered;
	expect(harness.messages[0].message.content).toMatch(/^<firecode_master_event>\nfailed 失败\n错误：\nquota exhausted\n角色 工程师 的 fallback 链已用尽\n耗时：[^\n]+\n<\/firecode_master_event>$/u);
});

test.each([
	["insufficient_quota", "insufficient_quota"],
	["429 rate limit exceeded", "429 rate limit exceeded"],
	["Codex error: The usage limit has been reached", "Codex error: The usage limit has been reached"],
	[
		"Codex error: Our servers are currently overloaded. Please try again later.",
		"Codex error: Our servers are currently overloaded.",
	],
	[
		"Codex error: An error occurred while processing your request. You can retry your request.",
		"Codex error: An error occurred while processing your request.",
	],
])("宿主重试用尽的故障（%s）按角色 fallback 在同一会话续跑并更新实际模型", async (errorMessage, reason) => {
	const harness = await setup(true, {
		roles: {
			...TEST_ROLES,
			工程师: { ...TEST_ROLES.工程师, fallback: ["test/worker-2/high"] },
		},
	});
	faux.setResponses([fauxAssistantMessage("已启动")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "fallback", prompt: "初始化", role: "工程师",
	});
	await delivered;

	const session = harness.pool.getSession((started.details as any).worker.session);
	session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const fault = fauxAssistantMessage("", { stopReason: "error", errorMessage });
	const respond = (_context: any, _options: any, _state: any, model: any) =>
		(model.id.endsWith("worker-2") ? fauxAssistantMessage("降级后完成") : fault);
	faux.setResponses([respond, respond, respond, respond]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "fallback", prompt: "继续" });
	await delivered;

	const content = harness.messages.map((entry: any) => entry.message.content).join("\n");
	expect([...content.matchAll(/<firecode_master_event>\n([^\n]+)/gu)].map((match) => match[1]))
		.toEqual(["fallback 已返回", "fallback 已切换模型", "fallback 已返回"]);
	// 模型切换不是落定类事件：耗时行不带“本次运行”。
	expect(content).not.toMatch(/fallback 已切换模型\n[^\n]+\n耗时：本次运行/u);
	expect(content).toContain(`已切换 test/worker/medium→test/worker-2/high（${reason}）`);
	expect(content).toContain("同一会话自动续跑");
	expect(content).toContain("回复：\n降级后完成");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({
		role: "工程师", model: "test/worker-2", thinking: "high", session: (started.details as any).worker.session,
	});
});

test("溢出恢复删除运行时消息后仍落定供应商错误而非过期回复", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("上一回合回复")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "overflow", prompt: "初始化", role: "工程师",
	});
	await delivered;

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const providerError = "maximum context length is 128 tokens";
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: providerError });
	}]);
	const session = harness.pool.getSession((started.details as any).worker.session);
	const deleted = new Promise<void>((resolve) => session.subscribe((event: any) => {
		if (event.type !== "agent_end") return;
		session.messages.splice(-1, 1);
		resolve();
	}));
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "overflow", prompt: "继续" });
	release();
	await deleted;
	await delivered;

	const content = harness.messages.at(-1).message.content;
	expect(content).toContain(`错误：\n${providerError}`);
	expect(content).not.toContain("上一回合回复");
	expect(content).not.toContain("（无回复）");
});

test("非显式中断的 aborted 终态落定明确原因", async () => {
	const harness = await setup();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "upstream connection closed" }),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "aborted", prompt: "执行", role: "工程师",
	});
	await delivered;

	expect(harness.messages[0].message.content).toContain("错误：\n回合意外中止：upstream connection closed");
	expect(harness.messages[0].message.content).not.toContain("（无回复）");
});

test("进程内池拒绝同一 sessionPath 的第二个持有者，恢复缺失文件明确失败", async () => {
	const harness = await setup();
	const module = await loadFirecodeModule("master/spawn.js") as any;
	const sessionPath = join(directory!, "sessions", "subagents", "worker.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	const options = {
		cwd: harness.cwd,
		model: faux.getModel(),
		thinking: "medium",
		tools: [],
		systemPrompt: { mode: "replace", text: "test" },
		contextFiles: false,
		persistence: { type: "file", sessionPath },
	};
	const pool = new module.InProcessSessionPool();
	const first = await pool.spawn(options);
	await expect(pool.spawn(options)).rejects.toThrow("已有进程内会话持有");
	await first.dispose();
	await expect(pool.spawn({ ...options, persistence: { ...options.persistence, resume: true } }))
		.rejects.toThrow("会话文件不存在");
	pool.disposeAll();
});

test("池不自判空闲：只有 markIdle 后才起释放计时，释放前会话扩展先收到 session_shutdown", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10, shutdownProbe: true });
	const sessionPath = join(directory!, "sessions", "subagents", "pool-idle.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const spawned = await harness.pool.spawn({
		cwd: harness.cwd, model: faux.getModel(), thinking: "medium", tools: [], role: "worker",
		systemPrompt: { mode: "replace", text: "test" }, contextFiles: false,
		persistence: { type: "file", sessionPath },
	});
	await spawned.prompt("回合");
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(harness.pool.has(sessionPath)).toBe(true);
	harness.pool.markIdle(sessionPath);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(harness.pool.has(sessionPath)).toBe(false);
	expect(await readFile(join(directory!, "shutdown.log"), "utf8")).toBe("quit\n");
});

test("reviewing 中的 Worker 回合早已落定也不会被 idle 超时释放", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10, mockReview: true, review: true, reviewProgressOnly: true, reviewFixTurn: true });
	faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("修复完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const result = await harness.execute({ action: "start", worker: "review-hot", prompt: "完成", role: "工程师" });
	await settled;
	const path = (result.details as any).worker.session;
	await harness.execute({ action: "review", worker: "review-hot" });
	// 修复回合由 faux 即时回复，80ms 足够它落定并越过 10ms 的 idle 超时。
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(harness.pool.has(path)).toBe(true);
	expect((await harness.list().then((listed) => listed.details as any)).workers[0].status).toBe("reviewing");
});

test("kill 等 Worker 的 session_shutdown 收口完成后才返回", async () => {
	const harness = await setup(true, { shutdownProbe: true });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "shutdown-order", prompt: "完成", role: "工程师" });
	await settled;
	expect((await harness.execute({ action: "kill", worker: "shutdown-order" })).details).toEqual({ killed: true });
	expect(await readFile(join(directory!, "shutdown.log"), "utf8")).toBe("quit\n");
});

test("空闲会话自动释放后 kill 仍只删档案并保留会话文件", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "cold-kill", prompt: "完成", role: "工程师",
	});
	await settled;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);
	await harness.execute({ action: "kill", worker: "cold-kill" });
	expect(existsSync(sessionPath)).toBe(true);
});

test("空闲前门投递未完成时替换会话，旧投递不得确认到新 runtime", async () => {
	const harness = await setup(true, { holdWake: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("旧会话结果")]);
	await harness.execute({
		action: "start", worker: "old-delivery", prompt: "执行", role: "工程师",
	});
	await harness.userMessageStarted;
	const appendedBeforeReplacement = harness.appended.length;

	await harness.replaceSession();
	await harness.wake();
	await Bun.sleep(0);

	expect(harness.appended).toHaveLength(appendedBeforeReplacement);
	expect(harness.appended.map(([type]) => type)).toEqual(["firecode-master-pending-event"]);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("审查结算中替换会话，旧 continuation 不得写入新 runtime", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "old-review", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	const session = harness.pool.getSession((started.details as any).worker.session);
	let releaseReview!: () => void;
	const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
	const prompt = session.prompt.bind(session);
	session.prompt = (text: string) => text === "/fire-review" ? reviewGate : prompt(text);
	await harness.execute({ action: "review", worker: "old-review" });
	await harness.replaceSession();
	const appendedBeforeSettlement = harness.appended.length;
	const noticesBeforeSettlement = harness.notices.length;

	releaseReview();
	await Bun.sleep(0);

	expect(harness.appended).toHaveLength(appendedBeforeSettlement);
	expect(harness.notices).toHaveLength(noticesBeforeSettlement);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("主回合空闲时，并发落定合并走前门用户消息，投递前写 pending、成功后写 ack", async () => {
	const harness = await setup();
	harness.idle = true;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([
		async () => { await gate; return fauxAssistantMessage("结果 A"); },
		async () => { await gate; return fauxAssistantMessage("结果 B"); },
	]);
	await Promise.all([
		harness.execute({ action: "start", worker: "merge-a", prompt: "A", role: "工程师" }),
		harness.execute({ action: "start", worker: "merge-b", prompt: "B", role: "工程师" }),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	// 前门消息发出后，唤醒回合稍后才开始；ack 在回合开始之后写。
	await Bun.sleep(5);
	expect(harness.messages).toEqual([]);
	expect(harness.userMessages).toHaveLength(1);
	expect(harness.userMessages[0]).toContain("结果 A");
	expect(harness.userMessages[0]).toContain("结果 B");
	expect(harness.appended.map(([type]) => type)).toEqual([
		"firecode-master-pending-event",
		"firecode-master-pending-event",
		"firecode-master-event-ack",
	]);
});

test("本次运行耗时读子代理会话自己写的轮记录：子代理没装轮记录器时事件不带本次运行，不拿指挥官这边的计时冒充", async () => {
	const harness = await setup(true, { workerRecorder: false });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "bare", prompt: "执行", role: "工程师" });
	await delivered;
	expect(harness.messages.at(-1).message.content).not.toContain("本次运行");
});

test("子代理视图里的补话走 send 同一入口：落定事件标题注明是你在视图里直接派的，正文带你说的原话，其余与普通 send 相同", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("按你说的改好了")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "viewed", prompt: "初始化", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "viewed", prompt: "把标题改短", origin: "view" });
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("viewed 已返回（你在子代理视图里直接派的）");
	expect(content).toContain("你说：把标题改短");
	expect(content).toContain("回复：\n按你说的改好了");
	expect(content).toMatch(/耗时：本次运行 /u);
	// 指挥官回合在跑：照常经 steer 队列在句缝送达。
	expect(harness.messages.at(-1).options).toMatchObject({ deliverAs: "steer" });
	await Bun.sleep(0);
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", disposition: "pending" });
});

const inFlightCounts = (harness: { emitted: [string, any][] }) =>
	harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);

test("视图里直接派的运行指挥官并不在等：不计入在飞数（主会话不因此进入进行中），指挥官歇透时结果作为会话记录追加、不唤醒", async () => {
	const harness = await setup();
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("按你说的改好了")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "viewed", prompt: "初始化", role: "工程师" });
	await delivered;
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	const wakes = harness.userMessages.length;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "viewed", prompt: "把标题改短", origin: "view" });
	await delivered;
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	expect(harness.userMessages).toHaveLength(wakes);
	const { message, options } = harness.messages.at(-1);
	expect(titleOf(message.content)).toBe("viewed 已返回（你在子代理视图里直接派的）");
	expect(options?.deliverAs).toBeUndefined();
	expect(options?.triggerTurn).toBeFalsy();
	// 发落规则不变：结果交给指挥官后同样待发落。
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", disposition: "pending" });
});

test("视图派的运行进行中指挥官又 send 给同一子代理：来源转为指挥官，从此算在飞，落定照常唤醒指挥官", async () => {
	const harness = await setup();
	harness.idle = true;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([
		fauxAssistantMessage("初始完成"),
		async () => { await gate; return fauxAssistantMessage("第一段"); },
		fauxAssistantMessage("按补充改好了"),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "shared", prompt: "初始化", role: "工程师" });
	await delivered;
	await Bun.sleep(5);
	const wakes = harness.userMessages.length;

	await harness.execute({ action: "send", worker: "shared", prompt: "视图里说的", origin: "view" });
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	await harness.execute({ action: "send", worker: "shared", prompt: "指挥官补充" });
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0, 1]);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	await Bun.sleep(5);
	expect(harness.userMessages).toHaveLength(wakes + 1);
	expect(titleOf(harness.userMessages.at(-1)!)).toBe("shared 已返回（你在子代理视图里直接派的）");
	expect(harness.userMessages.at(-1)).toContain("你说：视图里说的");
	expect(inFlightCounts(harness)).toEqual([1, 0, 1, 0]);
});

test("子代理被 kill 时通知订阅方（全过程视图据此显示已移除）；之后视图补话报明确错误", async () => {
	process.env.PI_CODING_AGENT_DIR = directory = await mkdtemp(join(tmpdir(), "firecode-master-kill-"));
	const [{ MasterRuntime }, { ACTION_HANDLERS }] = await Promise.all([
		loadFirecodeModule("master/runtime.js"),
		loadFirecodeModule("master/actions.js"),
	]) as any[];
	const ctx = {
		sessionManager: { getSessionId: () => "kill-notify" },
		ui: { setWidget() {}, setStatus() {}, notify() {} },
		isIdle: () => true,
	};
	const pool = { onRelease: () => () => {}, dispose: async () => {}, markIdle() {}, getSession: () => undefined };
	const active = new MasterRuntime({ pi: fakePi().pi, pool, roster: [], exclusions: [], publishInFlight() {}, publishRoster() {} }, ctx);
	active.store.upsert({
		name: "quick", role: "哨兵", model: "test/worker", thinking: "low", status: "idle", sessionPath: join(directory, "quick.jsonl"), launch: 1,
	});
	const removed: string[] = [];
	active.onWorkerRemoved((name: string) => removed.push(name));
	await ACTION_HANDLERS.kill(active, { worker: "quick" }, ctx);
	expect(removed).toEqual(["quick"]);
	await expect(ACTION_HANDLERS.send(active, { worker: "quick", prompt: "还在吗", origin: "view" }, ctx)).rejects.toThrow("子代理不存在：quick");
	active.close();
});

test("在飞 send 拒绝；指挥官 interrupt 落中断标记但不补发“待续跑”，首次 send 自动注入现场自检", async () => {
	const harness = await setup(true, { interruptResumeMs: 10 });
	let resumedPrompt = "";
	faux.setResponses([
		async (_context: any, options: any) => {
			await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("已中断");
		},
	]);
	at(0);
	await harness.emit("input", { source: "interactive" });
	at(10);
	await harness.execute({
		action: "start", worker: "interrupted", prompt: "开始", role: "工程师",
	});
	await expect(harness.execute({ action: "send", worker: "interrupted", prompt: "换角色", role: "设计师" }))
		.rejects.toThrow("先 interrupt");
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	at(40);
	await harness.execute({ action: "interrupt", worker: "interrupted" });
	await delivered;
	at(400);
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("interrupted 被中断");
	// 中断是指挥官自己发起的，它知道现场：过了提醒时限也不补发“待续跑”。
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.messages.map((entry: any) => titleOf(entry.message.content))).toEqual(["interrupted 被中断"]);

	faux.setResponses([(context: any) => {
		resumedPrompt = context.messages.filter((message: any) => message.role === "user")
			.map((message: any) => typeof message.content === "string" ? message.content : message.content?.map((part: any) => part.text).join(""))
			.join("\n");
		return fauxAssistantMessage("续跑完成");
	}]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "interrupted", prompt: "继续" });
	await delivered;
	expect(resumedPrompt).toContain("<firecode_master_event>");
	expect(resumedPrompt).toContain("上次被外部中断");
	expect(resumedPrompt).toContain("git status");
	expect(resumedPrompt).toContain("</firecode_master_event>");
	const listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed.interruptedAt).toBeUndefined();
});

test("会话重载打断的回合：恢复后补挂续跑提醒，提醒说清是重载打断而不是“外部中断后无人接手”", async () => {
	const harness = await setup(false, { interruptResumeMs: 10 });
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 9, workers: [{
		name: "reloaded", role: "工程师", model: "test/worker", thinking: "medium", status: "working", sessionPath: join(harness.cwd, "w.jsonl"), launch: 1,
	}] }));
	await harness.command("");
	await new Promise((resolve) => setTimeout(resolve, 30));
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("reloaded 待续跑");
	expect(content).toContain("重载");
	expect(content).not.toMatch(/外部中断|无人接手/u);
	await harness.command("");
});

test("向 working Worker 的普通 send 经 steer 在句缝送达，不打断也不报错", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let secondContext = "";
	const entered = Promise.withResolvers<void>();
	faux.setResponses([
		async () => { entered.resolve(); await gate; return fauxAssistantMessage("第一段"); },
		(context: any) => { secondContext = userText(context); return fauxAssistantMessage("吸收补充"); },
	]);
	await harness.execute({ action: "start", worker: "steered", prompt: "开始", role: "工程师" });
	await entered.promise;
	await harness.execute({ action: "send", worker: "steered", prompt: "补充说明" });
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("working");
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(secondContext).toContain("补充说明");
	expect(harness.messages.at(-1).message.content).toContain("吸收补充");
});

test("steer 入队后回合被中断而滞留的补充说明，落定时回报指挥官重发，不静默滞留", async () => {
	const harness = await setup();
	const entered = Promise.withResolvers<void>();
	faux.setResponses([async (_context: any, options: any) => {
		entered.resolve();
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中断");
	}]);
	await harness.execute({ action: "start", worker: "stranded", prompt: "开始", role: "工程师" });
	await entered.promise;
	await harness.execute({ action: "send", worker: "stranded", prompt: "迟到的补充" });
	const has = () => harness.messages.some((m: any) => String(m.message.content).includes("迟到的补充"));
	const seen = new Promise<void>((resolve) => { harness.onMessage = () => { if (has()) resolve(); }; });
	await harness.execute({ action: "interrupt", worker: "stranded" });
	await seen;
	const stranded = harness.messages.find((m: any) => String(m.message.content).includes("迟到的补充"));
	expect(stranded.message.content).toContain("<firecode_master_event>\nstranded 补充说明未送达\n");
});

test("send 带 cwd 以新目录重开同一会话：上下文保留，bash 以新目录为准，档案记新 cwd", async () => {
	const harness = await setup();
	const [first, second] = [join(directory!, "co-a"), join(directory!, "co-b")];
	await Promise.all([mkdir(first), mkdir(second)]);
	const realSecond = await realpath(second);
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "mover", prompt: "初始任务", role: "工程师", cwd: first });
	await delivered;
	const sessionPath = (started.details as any).worker.session;

	const pwdRun = (results: string[]) => [
		fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
		(context: any) => {
			results.push(JSON.stringify(context.messages.findLast((m: any) => m.role === "toolResult")?.content));
			return fauxAssistantMessage("pwd 完成");
		},
	];
	const results: string[] = [];
	let history = "";
	faux.setResponses([
		(context: any) => { history = userText(context); return pwdRun(results)[0]; },
		pwdRun(results)[1],
	]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "mover", prompt: "换目录继续", cwd: second });
	await delivered;
	expect(history).toContain("初始任务");
	expect(results[0]).toContain(realSecond);

	await harness.pool.dispose(sessionPath);
	faux.setResponses(pwdRun(results));
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "mover", prompt: "冷启动再跑" });
	await delivered;
	expect(results[1]).toContain(realSecond);
	expect((await harness.list().then((result) => result.details as any)).workers[0].session).toBe(sessionPath);
});

test("Worker 的 cwd 已不存在且 send 没带 cwd：明确报错并提示带 cwd", async () => {
	const harness = await setup();
	const gone = join(directory!, "gone");
	await mkdir(gone);
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "orphan", prompt: "开始", role: "工程师", cwd: gone });
	await delivered;
	await rm(gone, { recursive: true });
	await expect(harness.execute({ action: "send", worker: "orphan", prompt: "继续" })).rejects.toThrow("带 cwd");
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("idle");
});

test("失败的 interrupt 不会把本回合或下一回合误记为中断", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("自然完成");
	}]);
	const started = await harness.execute({
		action: "start", worker: "abort-race", prompt: "执行", role: "工程师",
	});
	const session = harness.pool.getSession((started.details as any).worker.session);
	session.abort = async () => { throw new Error("abort failed"); };
	await expect(harness.execute({ action: "interrupt", worker: "abort-race" })).rejects.toThrow("abort failed");

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("自然完成");
	expect(harness.messages.at(-1).message.content).not.toContain("被中断");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker.interruptedAt).toBeUndefined();
});

test("同一空闲 Worker 的并发 send 只接收一票，另一票按在飞拒绝", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "single-flight", prompt: "初始化", role: "工程师",
	});
	await delivered;

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("唯一结果");
	}]);
	const sends = await Promise.allSettled([
		harness.execute({ action: "send", worker: "single-flight", prompt: "第一票" }),
		harness.execute({ action: "send", worker: "single-flight", prompt: "第二票" }),
	]);
	expect(sends.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const rejected = sends.find((result) => result.status === "rejected") as PromiseRejectedResult;
	expect(String(rejected.reason)).toContain("正在切换");
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("working");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("唯一结果");
});

test("kill 赢过正在准备的 send/review，异步写回不会复活已删档案", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("待审完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "kill-send", prompt: "初始化", role: "工程师",
	});
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "kill-review", prompt: "初始化", role: "工程师", review: true,
	});
	await delivered;

	faux.setResponses([fauxAssistantMessage("不应执行")]);
	const sending = harness.execute({
		action: "send", worker: "kill-send", prompt: "新任务", role: "设计师",
	});
	await harness.execute({ action: "kill", worker: "kill-send" });
	await expect(sending).rejects.toThrow("已被 kill");
	const reviewing = harness.execute({ action: "review", worker: "kill-review" });
	await harness.execute({ action: "kill", worker: "kill-review" });
	await expect(reviewing).rejects.toThrow("已被 kill");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	expect(harness.messages).toHaveLength(2);
});

test("start 准备期间被 kill：start 不报成功、不调模型、不留热会话", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("被 kill 的子代理不应执行")]);
	const gate = Promise.withResolvers<void>();
	(globalThis as any).__modelGate = gate.promise;
	const starting = harness.execute({ action: "start", worker: "racy", prompt: "做事", role: "工程师" });
	let workers: any[] = [];
	while (!workers.length) {
		await Bun.sleep(1);
		workers = (await harness.list()).details.workers;
	}
	const sessionPath = workers[0].session;
	await harness.execute({ action: "kill", worker: "racy" });
	gate.resolve();
	await expect(starting).rejects.toThrow("已被 kill");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(1);
	expect(harness.pool.getSession(sessionPath)).toBeUndefined();
	expect((await harness.list()).details.workers).toEqual([]);
});

test("steer 越过 await 后按最新档案写回：期间落定不被改回 working，期间被 kill 不复活", async () => {
	const harness = await setup(true, { review: true, inputGate: true });
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	const gateInput = () => {
		const entered = Promise.withResolvers<void>();
		const open = Promise.withResolvers<void>();
		(globalThis as any).__inputGate = { entered: entered.resolve, open: open.promise };
		return { entered: entered.promise, open: open.resolve };
	};
	const startHeld = async (name: string) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("先完成了"); }]);
		await harness.execute({ action: "start", worker: name, prompt: "开始", role: "工程师" });
		await entered.promise;
		return release.resolve;
	};

	// 期间落定：补充说明没进回合，明确报未送达；档案保持落定后的 idle，在飞数归零。
	const finish = await startHeld("settles");
	let input = gateInput();
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const steering = harness.execute({ action: "send", worker: "settles", prompt: "INPUT-GATE 补充", review: true });
	await input.entered;
	finish();
	await delivered;
	input.open();
	await expect(steering).rejects.toThrow("未送达");
	await Bun.sleep(0);
	expect((await harness.list()).details.workers[0]).toMatchObject({ name: "settles", status: "idle" });
	expect(counts().at(-1)).toBe(0);

	// 期间被 kill：档案不复活。
	await startHeld("killed");
	input = gateInput();
	const killedSteer = harness.execute({ action: "send", worker: "killed", prompt: "INPUT-GATE 补充", review: true });
	await input.entered;
	await harness.execute({ action: "kill", worker: "killed" });
	input.open();
	await expect(killedSteer).rejects.toThrow("已被 kill");
	expect((await harness.list()).details.workers.map((worker: any) => worker.name)).toEqual(["settles"]);
});

test("活动列表：失败行留到 ack，完成的合进“✓ N 个已完成”留到 kill", async () => {
	const harness = await setup();
	faux.setResponses([async () => { throw new Error("quota exhausted"); }, fauxAssistantMessage("完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "broken", prompt: "执行", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "fine", prompt: "执行", role: "工程师" });
	await delivered;
	expect(harness.activity()).toEqual([
		expect.stringMatching(/^ {2}✗ broken /u),
		expect.stringMatching(/^ {2}✓ +1 个已完成/u),
	]);

	await harness.execute({ action: "ack", worker: "broken" });
	await harness.execute({ action: "ack", worker: "fine" });
	// 发落后的失败行离开置顶组，子代理仍在池里，合进“N 个空闲”。
	expect(harness.activity()).toEqual([expect.stringMatching(/^ {2}✓ +1 个已完成/u), expect.stringMatching(/^ {2}\S +1 个空闲/u)]);
	await harness.execute({ action: "kill", worker: "fine" });
	expect(harness.activity()).toEqual([expect.stringMatching(/^ {2}\S +1 个空闲/u)]);
});

test("活动列表：已完成展开显示结果首句，下一轮人类输入时自动收起；ctrl+o 不展开活动列表", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("刷新改为单飞。更多细节"), fauxAssistantMessage("清掉 4 处 lint。")]);
	for (const worker of ["fix-auth", "lint"]) {
		const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
		await harness.execute({ action: "start", worker, prompt: "执行", role: "工程师" });
		await delivered;
	}
	harness.toolsExpanded = true;
	expect(harness.activity()).toEqual([expect.stringMatching(/^ {2}✓ +2 个已完成/u)]);
	harness.clickActivity("2 个已完成");
	const opened = harness.activity();
	expect(opened[1]).toMatch(/fix-auth .*刷新改为单飞。/u);
	expect(opened[2]).toMatch(/lint .*清掉 4 处 lint。/u);
	await harness.emit("input", { source: "interactive" });
	expect(harness.activity()).toHaveLength(1);
	await harness.command("");
});

test("resume 后池里仍有空闲子代理：活动列表显示一行“N 个空闲”", async () => {
	const harness = await setup(false);
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 9, workers: ["writer", "slow"].map((name, index) => ({
		name, role: "哨兵", model: "test/worker", thinking: "low", status: "idle", sessionPath: join(harness.cwd, `${name}.jsonl`), launch: index + 1,
	})) }));
	await harness.command("");
	expect(harness.activity()).toEqual([expect.stringMatching(/2 个空闲/u)]);
	await harness.command("");
});

test("恢复后按档案里的启动序列出子代理（并行 start 的落盘先后不可靠）；新 start 的启动序接在已有之后", async () => {
	const harness = await setup(false);
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	const archived = [["mid", 3], ["zeta", 1], ["alpha", 2]] as const;
	await writeFile(path, JSON.stringify({ version: 9, workers: archived.map(([name, launch]) => ({
		name, role: "哨兵", model: "test/worker", thinking: "low", status: "idle", sessionPath: join(harness.cwd, `${name}.jsonl`), launch,
	})) }));
	await harness.command("");
	harness.clickActivity("3 个空闲");
	expect(harness.activity().slice(1).map((line) => line.match(/ (zeta|alpha|mid) /u)?.[1])).toEqual(["zeta", "alpha", "mid"]);

	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "fresh", prompt: "执行", role: "工程师" });
	await delivered;
	const saved = JSON.parse(await readFile(path, "utf8")).workers.find((worker: any) => worker.name === "fresh");
	expect(saved.launch).toBe(4);
	await harness.command("");
});

test("第 16 个在飞 Worker 被 admission 拒绝并回报当前清单", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses(Array.from({ length: 15 }, (_, index) => async () => {
		await gate;
		return fauxAssistantMessage(`完成 ${index}`);
	}));
	const starts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => harness.execute({
		action: "start", worker: `slot-${index}`, prompt: "等待", role: "工程师",
	})));
	const rejected = starts.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
	expect(rejected).toHaveLength(1);
	expect(String(rejected[0].reason)).toMatch(/并发上限 15.*slot-/);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
});

test("fire-review 不可用时拒绝 start/send 挂审查义务", async () => {
	const harness = await setup();
	await expect(harness.execute({
		action: "start", worker: "blocked-review", prompt: "实现", role: "工程师", review: true,
	})).rejects.toThrow("fire-review 已关闭");
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "plain", prompt: "实现", role: "工程师",
	});
	await delivered;
	await expect(harness.execute({ action: "send", worker: "plain", prompt: "加审查义务", review: true }))
		.rejects.toThrow("fire-review 已关闭");
});

test("list 展开投影 reviewing 的轮次与审查者进度", async () => {
	const harness = await setup(true, { review: true, mockReview: true, reviewProgressOnly: true });
	faux.setResponses([fauxAssistantMessage("实现完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "under-review", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	await harness.execute({ action: "review", worker: "under-review" });

	const listed = await harness.list();
	expect(listed.content[0].text).not.toContain("currentAction");
	expect((listed.details as any).workers[0].currentAction).toEqual({
		kind: "review", round: 1, settled: 0, total: 1,
	});
	const expanded = harness.renderResult(listed, true).join("\n");
	expect(expanded).toContain("第 1 轮");
	expect(expanded).toContain("审查者 0/1");
});

test("审查义务只能经显式 review 履行，未履行拒绝 ack，kill 随票删除", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("待删除")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "obligation", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("此票有审查义务");
	await expect(harness.execute({ action: "ack", worker: "obligation" })).rejects.toThrow("完成 review 后才能 ack");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "obligation" });
	await delivered;
	expect(harness.messages).toHaveLength(2);
	expect(titleOf(harness.messages[1].message.content)).toBe("obligation 审查通过（1 轮）");
	await harness.execute({ action: "ack", worker: "obligation" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "discard-obligation", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	await harness.execute({ action: "kill", worker: "discard-obligation" });
	expect((await harness.list().then((result) => result.details as any)).workers)
		.not.toContainEqual(expect.objectContaining({ name: "discard-obligation" }));
});

test("审查以基础设施故障落定时把该轮原因带给指挥官", async () => {
	const harness = await setup(true, { review: true, mockReview: true, reviewTimeout: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("审查未完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "timed-out", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "timed-out" });
	await delivered;

	expect(titleOf(harness.messages[1].message.content)).toBe("timed-out 审查未完成");
	expect(harness.messages[1].message.content).toContain("timed-out 审查未完成\n错误：\n");
	expect(harness.messages[1].message.content).toContain(TIMEOUT_DETAILS);
});

test("review 命令未启动时明确失败结算并保留审查义务", async () => {
	const harness = await setup(true, { review: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("未启动审查")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "review-missing", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "review-missing" });
	await Promise.race([
		delivered,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("审查失败未回传")), 100)),
	]);
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("review-missing 审查未完成");
	expect(harness.messages.at(-1).message.content).toContain("review-missing 审查未完成\n错误：\n");
	expect(harness.messages.at(-1).message.content).toContain("审查未启动");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", reviewNeeded: true, disposition: "pending" });
});

// 实际案例：配置里残留 review.language 被判未知字段，Worker 里没有 UI，拒绝原因曾无处可读，指挥官只看到“审查未启动”。
test("review 命令因配置问题拒绝启动时，拒绝原因原样回到指挥官", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: { ...TEST_REVIEW_CONFIG, language: "zh" } } });
	faux.setResponses([fauxAssistantMessage("实现完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "refused", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "refused" });
	await Promise.race([
		delivered,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("拒绝原因未回传")), 500)),
	]);
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("refused 审查未完成");
	expect(content).toContain("未知字段 review.language");
	expect(content).not.toContain("审查未启动");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", reviewNeeded: true, disposition: "pending" });
});

const CLOCK = Date.UTC(2030, 0, 1);
const at = (seconds: number) => setSystemTime(new Date(CLOCK + seconds * 1_000));
const elapsedTail = (content: string) => content.split("\n").at(-2);
/** 信封正文第一行：给人看的“<名字> <结果词>”标题。 */
const titleOf = (content: string) => content.split("\n")[1];

test("事件末尾给指挥官时间信号：落定事件带 Worker 本次运行与当前任务（会话进行中起点，与上边框同一事实）", async () => {
	const harness = await setup();
	at(0);
	await harness.emit("agent_start", {});
	at(20);
	faux.setResponses([() => { at(85); return fauxAssistantMessage("完成"); }]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "clock", prompt: "开始", role: "工程师" });
	await delivered;
	expect(elapsedTail(harness.messages.at(-1).message.content as string)).toBe("耗时：本次运行 1m5s · 当前任务 1m25s");
});

test("中断事件带耗时", async () => {
	const harness = await setup();
	faux.setResponses([async (_context: any, options: any) => {
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中断");
	}]);
	at(0);
	await harness.emit("input", { source: "interactive" });
	at(10);
	await harness.execute({ action: "start", worker: "clock", prompt: "开始", role: "工程师" });
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	at(40);
	await harness.execute({ action: "interrupt", worker: "clock" });
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("clock 被中断");
	// 没有审查义务就不提审查义务。
	expect(content).not.toContain("审查义务");
	// 被中断不是失败：活动列表里不画 ✗，留在需要处理那一组直到 ack。
	expect(harness.activity()).toEqual([expect.stringMatching(/^ {2}[^✗\s] clock .*被中断/u)]);
	await harness.execute({ action: "ack", worker: "clock" });
	expect(harness.activity()).toEqual([expect.stringMatching(/^ {2}\S +1 个空闲/u)]);
	expect(elapsedTail(content)).toBe("耗时：本次运行 30s · 当前任务 30s");
});

test("审查终态事件带审查自身耗时", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("审查完成")]);
	at(0);
	await harness.emit("input", { source: "interactive" });
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "clock", prompt: "实现", role: "工程师", review: true });
	await delivered;

	at(50);
	(globalThis as any).__reviewTick = () => at(80);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "clock" });
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(content).toContain("审查通过");
	expect(elapsedTail(content)).toMatch(/^耗时：本次运行 30s · 当前任务 /);
});

test("crash 恢复只重投 pending 减 ack 的差集", async () => {
	const harness = await setup(false);
	harness.entries.push(
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e1", content: "未确认结果" } },
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e2", content: "已确认结果" } },
		{ type: "custom", customType: "firecode-master-event-ack", data: { ids: ["e2"] } },
	);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.emit("session_start", {});
	await delivered;
	await Bun.sleep(0);
	expect(harness.messages.map((entry) => entry.message.content)).toEqual([
		"<firecode_master_event>\n未确认结果\n</firecode_master_event>",
	]);
	expect(harness.appended).toEqual([["firecode-master-event-ack", { ids: ["e1"] }]]);
});

test("send 只覆盖 thinking 时沿用当前角色与模型", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("升档完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "thinking-only", prompt: "初始化", role: "工程师",
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "send", worker: "thinking-only", prompt: "继续", thinking: "high",
	});
	await delivered;

	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({
		status: "idle", role: "工程师", model: "test/worker", thinking: "high",
		session: (started.details as any).worker.session,
	});
	const sessionText = await Bun.file(worker.session).text();
	expect(sessionText.match(/"type":"model_change"/gu)).toHaveLength(1);
});

test("send 对冷 Worker 透明复活、省略角色沿用、显式角色原地切换并入会话记录", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([
		fauxAssistantMessage("第一轮"),
		fauxAssistantMessage("沿用完成"),
		fauxAssistantMessage("切换完成"),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "revive", prompt: "第一轮", role: "工程师",
	});
	await delivered;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "revive", prompt: "沿用" });
	await delivered;
	let listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", role: "工程师" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "send", worker: "revive", prompt: "切换", role: "设计师",
	});
	await delivered;
	listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", role: "设计师" });
	const sessionText = await Bun.file(sessionPath).text();
	expect(sessionText).toContain('"type":"model_change"');
	expect(sessionText).toContain('"type":"thinking_level_change"');
});

test("v7 状态由所有者丢弃并告知旧进程不纳入新池", async () => {
	const harness = await setup(false);
	const state = await loadFirecodeModule("master/state.js") as any;
	const path = state.masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 7, workers: [] }));
	try {
		await harness.command("");
		expect(harness.notices.join("\n")).toContain("旧版 v7 子代理池已丢弃");
		expect(harness.notices.join("\n")).toContain("旧运行时进程不会纳入新池");
		expect(await readdir(dirname(path))).not.toContain(path.split("/").pop());
	} finally {
		await rm(path, { force: true });
	}
});

test("显式 observer 角色不注册 Master 工具面", async () => {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({
			features: await featuresOnly("master"),
			review: TEST_REVIEW_CONFIG,
			master: { roles: { 工程师: TEST_ROLES.工程师 }, workerExcludeExtensions: [], autoActivate: true },
		}),
	}) as { registerFirecode(pi: unknown, role: string): void };
	const fake = fakePi();
	registerFirecode(fake.pi, "observer");
	expect(fake.commands.has("fire-master")).toBe(false);
	expect(fake.tools.has("subagents")).toBe(false);
	expect(fake.handlers.has("tool_call")).toBe(true);
});

test("子会话不注册只属于交互主会话的功能：横幅、工具渲染、预设、重命名与用量命令", async () => {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({
			features: await featuresOnly("header", "tools", "presets", "stats"),
		}),
	}) as { registerFirecode(pi: unknown, role: string): void };
	const fake = fakePi();
	registerFirecode(fake.pi, "worker");
	expect([fake.commands, fake.tools, fake.shortcuts, fake.entryRenderers].map((table) => table.size)).toEqual([0, 0, 0, 0]);
});

test("指挥官启用 codemode 时 Worker 也能经 codemode 脚本调用工具", async () => {
	const harness = await setup(true, { activeTools: ["read", "bash", "edit", "write", "codemode"] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.write({ path: "made.txt", content: "ok" });' }), { stopReason: "toolUse" }),
		fauxAssistantMessage("完成"),
	]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "scripted", prompt: "写文件", role: "工程师" });
	await settled;
	expect(await readFile(join(harness.cwd, "made.txt"), "utf8")).toBe("ok");
});

test("Worker 会话只注册 checkout 守卫，不暴露 Master 工具面", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const cwd = join(directory, "checkout");
	await mkdir(cwd);
	const module = await loadFirecodeModule("master/index.js", {
		configJsonc: JSON.stringify({
			features: { master: true, review: false },
			review: TEST_REVIEW_CONFIG,
			master: { roles: TEST_ROLES },
		}),
	}) as any;
	const register = (worker = false) => {
		const { pi, handlers, commands, tools } = fakePi();
		module.registerMaster(pi, {}, worker);
		return { handlers, commands, tools };
	};

	const workerRegistration = register(true);
	const ctx = { cwd };
	expect(workerRegistration.commands.size).toBe(0);
	expect(workerRegistration.tools.size).toBe(0);
	expect(workerRegistration.handlers.has("session_start")).toBe(false);
	const workerGuard = workerRegistration.handlers.get("tool_call")?.[0];
	const outside = join(homedir(), "firecode-guard-probe", "outside.ts");
	expect(await workerGuard({ toolName: "write", input: { path: outside } }, ctx)).toEqual({
		block: true,
		reason: `子代理只能修改当前 checkout 或系统临时目录：${outside}`,
	});
	expect(await workerGuard({ toolName: "edit", input: { path: "inside.ts" } }, ctx)).toBeUndefined();
	// 交付物（调研报告、评测产物）写到临时目录是正当用途，不该逼 Worker 改用 bash 绕过守卫。
	expect(await workerGuard({ toolName: "write", input: { path: join(tmpdir(), "fc-report", "notes.md") } }, ctx)).toBeUndefined();
	expect(await workerGuard({ toolName: "write", input: { path: "/tmp/fc-report/notes.md" } }, ctx)).toBeUndefined();

	const masterRegistration = register();
	expect(masterRegistration.commands.has("fire-master")).toBe(true);
	expect(masterRegistration.tools.has("subagents")).toBe(true);
	expect(masterRegistration.handlers.get("tool_call")).toBeUndefined();
});

async function setup(activate = true, options: {
	idleTimeoutMs?: number;
	interruptResumeMs?: number;
	review?: boolean;
	mockReview?: boolean;
	/** 子会话里装真实的 review，用这份顶层配置（含 review 节）加载：复现真实配置问题下的命令入口。 */
	workerReview?: Record<string, unknown>;
	reviewProgressOnly?: boolean;
	/** mock 审查停在 reviewing 相并唤起一个修复回合：复现审查期间 Worker 自己落定的现场。 */
	reviewFixTurn?: boolean;
	/** mock 审查以超时终态落定：复现基础设施故障轮次。 */
	reviewTimeout?: boolean;
	/** 在子会话里装一个慢速 session_shutdown 探针：收口完成才把 reason 追加到 shutdown.log。 */
	shutdownProbe?: boolean;
	/** 在子会话里装一个 input 闸门：含 INPUT-GATE 的输入卡在 globalThis.__inputGate 上，复现 steer 越过 await 的现场。 */
	inputGate?: boolean;
	autoActivate?: boolean;
	/** 指挥官空闲时合并唤醒的安静窗口；测试默认 0（立即唤醒）。 */
	wakeQuietMs?: number;
	/** 前门唤醒回合不自动开始：宿主 sendUserMessage 立即返回，agent_start 由测试 wake() 发出。 */
	holdWake?: boolean;
	/** 前 n 次 sendMessage 抛错：复现事件投递失败、等待重试的现场。 */
	failDeliveries?: number;
	/** 子会话加载 FireCode 的轮记录器（与真实安装一致）；false 复现 Worker 排除了 FireCode 扩展。 */
	workerRecorder?: boolean;
	promptFiles?: Record<string, string>;
	roles?: Record<string, { model: string; use: string; fallback?: string[] }>;
	/** 指挥官会话激活前的工具集。 */
	activeTools?: string[];
} = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-sdk-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	const extensions = join(agentDir, "extensions");
	await mkdir(extensions);
	if (options.workerRecorder !== false)
		await writeFile(join(extensions, "round-recorder.ts"),
			`export { registerRoundRecorder as default } from ${JSON.stringify(await firecodeModulePath("round-recorder.ts"))};`);
	if (options.inputGate)
		await writeFile(join(extensions, "input-gate.ts"), `export default function(pi) {
			pi.on("input", async (event) => {
				if (!event.text.includes("INPUT-GATE")) return;
				globalThis.__inputGate.entered();
				await globalThis.__inputGate.open;
			});
		}`);
	if (options.mockReview)
		await writeFile(join(extensions, "mock-review.ts"), mockReviewExtension({
			progressOnly: options.reviewProgressOnly === true,
			fixTurn: options.reviewFixTurn === true,
			timeout: options.reviewTimeout === true,
		}));
	if (options.workerReview) {
		const configJsonc = JSON.stringify({ features: await featuresOnly("review"), ...options.workerReview });
		await writeFile(join(extensions, "real-review.ts"),
			`import { registerReview } from ${JSON.stringify(await firecodeModulePath("review/index.ts", { configJsonc }))};\nexport default function(pi) { registerReview(pi); }`);
	}
	if (options.shutdownProbe)
		await writeFile(join(extensions, "shutdown-probe.ts"), shutdownProbeExtension(join(directory, "shutdown.log")));
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = registerFauxProvider();
	const { ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("master/spawn.js");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const fauxModel = faux.getModel();
	const alternateModel = { ...fauxModel, id: "worker-2", name: "Worker 2" };
	modelRuntime.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [fauxModel, alternateModel].map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	if (!modelRuntime.hasConfiguredAuth("faux")) throw new Error("测试 Faux 模型认证未载入");
	const pool = new (spawnModule as any).InProcessSessionPool({
		agentDir,
		modelRuntime,
		resolveModel: async (id: string) => {
			await (globalThis as any).__modelGate;
			return id === "test/worker-2" ? alternateModel : fauxModel;
		},
		...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
	});
	const module = await loadFirecodeModule("master/index.js", {
		extraFiles: options.promptFiles,
		configJsonc: JSON.stringify({
			features: { master: true, review: options.review === true },
			review: TEST_REVIEW_CONFIG,
			master: {
				roles: options.roles ?? TEST_ROLES,
				workerExcludeExtensions: [],
				...(options.autoActivate === undefined ? {} : { autoActivate: options.autoActivate }),
			},
		}),
	}) as any;
	const fake = fakePi();
	const { commands, tools, sent: messages, appended, userMessages, emitted } = fake;
	const notices: string[] = [];
	const entries: any[] = [];
	let failures = options.failDeliveries ?? 0;
	let onMessage: (() => void) | undefined;
	let idle = false;
	let markUserMessageStarted!: () => void;
	const userMessageStarted = new Promise<void>((resolve) => { markUserMessageStarted = resolve; });
	let activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
	const pi = Object.assign(fake.pi, {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		appendEntry: (type: string, data: any) => {
			appended.push([type, data]);
			entries.push({ type: "custom", customType: type, data });
		},
		sendMessage: (message: any, options: any) => {
			if (failures > 0) { failures--; throw new Error("投递失败"); }
			messages.push({ message, options });
			onMessage?.();
		},
		// 与宿主一致：扩展的 sendUserMessage 返回 void、不等唤醒回合；回合稍后才 agent_start。
		sendUserMessage: (content: string) => {
			userMessages.push(content);
			markUserMessageStarted();
			onMessage?.();
			if (!options.holdWake) setTimeout(() => void wake(), 0);
		},
	});
	/** 宿主开一个回合并记录它的第一条用户消息（与宿主事件顺序一致：agent_start 在前，message_start 在后）。 */
	const turn = async (text: string) => {
		await fake.fire("agent_start", {}, ctx);
		const message = { role: "user", content: [{ type: "text", text }] };
		await fake.fire("message_start", { message }, ctx);
	};
	/** 前门消息唤起的回合真正开始：宿主记录了这条信封消息本身。 */
	const wake = () => turn(userMessages.at(-1)!);
	const statuses = new Map<string, string>();
	const widgets = new Map<string, any>();
	const components = new Map<any, any>();
	let toolsExpanded = false;
	const activityList = () => {
		const factory = [...widgets.values()][0];
		if (!factory) return undefined;
		if (!components.has(factory)) components.set(factory, factory({ requestRender() {}, terminal: { rows: 24 } }, ctx.ui.theme));
		return components.get(factory);
	};
	let sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const ctx = {
		cwd,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, text: string | undefined) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
			setWidget: (key: string, factory: any) => { if (factory) widgets.set(key, factory); else widgets.delete(key); },
			getToolsExpanded: () => toolsExpanded,
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};
	module.registerMaster(pi, {
		pool,
		...(options.interruptResumeMs === undefined ? {} : { interruptResumeMs: options.interruptResumeMs }),
		wakeQuietMs: options.wakeQuietMs ?? 0,
	});
	const command = (args: string) => commands.get("fire-master").handler(args, ctx);
	if (activate) await command("");
	return {
		cwd,
		get sessionId() { return sessionId; },
		get activeTools() { return [...activeTools]; },
		notices,
		statuses,
		messages,
		userMessages,
		emitted,
		appended,
		entries,
		pool,
		/** 输入框上方活动列表当前的纯文本行（与宿主一致：组件只建一次，点击状态保留）。 */
		activity: () => activityList()?.render(80).map((line: string) => stripVTControlCharacters(line)) as string[] ?? [],
		/** 点活动列表里含 label 的那一行。 */
		clickActivity: (label: string) => {
			const list = activityList();
			const y = list.render(80).findIndex((line: string) => stripVTControlCharacters(line).includes(label));
			return list.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 80, height: 20, shift: false, alt: false, ctrl: false });
		},
		set toolsExpanded(value: boolean) { toolsExpanded = value; },
		set onMessage(value: (() => void) | undefined) { onMessage = value; },
		set idle(value: boolean) { idle = value; },
		userMessageStarted,
		wake,
		pi,
		ctx,
		/** 用户自己发消息开的回合（前门消息已被宿主拒绝、没进来）。 */
		userTurn: (text: string) => turn(text),
		command,
		emit: (name: string, event: any) => fake.fire(name, event, ctx),
		replaceSession: async () => {
			sessionId = crypto.randomUUID();
			entries.length = 0;
			await fake.fire("session_start", {}, ctx);
		},
		agentDir,
		model: fauxModel,
		modelRuntime,
		commandTool: tools.get("subagents"),
		listTool: tools.get("subagents_list"),
		systemPrompt: (initial: string) => fake.systemPrompt(initial, ctx),
		renderResult: (result: any, expanded: boolean) => tools.get("subagents_list").renderResult(
			result,
			{ expanded },
			ctx.ui.theme,
			{ state: {}, cwd, toolCallId: "list", isPartial: false, isError: false, expanded },
		).render(120),
		renderListLine: (result: any) => {
			const context = { state: {}, cwd, toolCallId: "list", isPartial: false, isError: false, expanded: false };
			tools.get("subagents_list").renderResult(result, { expanded: false }, ctx.ui.theme, context);
			return tools.get("subagents_list").renderCall({}, ctx.ui.theme, context).render(120);
		},
		list: () => tools.get("subagents_list").execute("list", {}, undefined, undefined, ctx),
		execute: (params: Record<string, unknown>) => tools.get("subagents").execute("call", params, undefined, undefined, ctx),
	};
}

function shutdownProbeExtension(logPath: string): string {
	return `import { appendFileSync } from "node:fs";
	export default function(pi) {
		pi.on("session_shutdown", async (event) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			appendFileSync(${JSON.stringify(logPath)}, event.reason + "\\n");
		});
	}`;
}

function mockReviewExtension(
	{ progressOnly, fixTurn, timeout }: { progressOnly: boolean; fixTurn: boolean; timeout: boolean },
): string {
	const base = {
		version: 5, runId: "mock-review-run", round: 1, focus: "", pending: null, repair: null, summary: null,
		consecutiveFailures: 0, startedAt: 1, roundStartedAt: 1,
	};
	const reviewing = {
		...base, seq: 1, phase: "reviewing", history: [], updatedAt: 1,
		active: { round: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "running", result: null }], settledCount: 0 },
	};
	const settled = {
		...base, seq: 2, phase: "settled", active: null, updatedAt: 2,
		history: [timeout
			? {
				round: 1, result: "error", details: TIMEOUT_DETAILS, elapsedMs: 1,
				reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "error", summary: "", details: TIMEOUT_DETAILS }],
			}
			: {
				round: 1, result: "passed", details: "verified", elapsedMs: 1,
				reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "passed", summary: "ok", details: "verified" }],
			}],
	};
	return `export default function(pi) {
		pi.registerCommand("fire-review", {
			description: "mock review",
			handler: () => {
				// 与真实 review 一致：审查期间持有占用，会话因此算进行中，审查时长计入子代理的轮记录。
				pi.events.emit("firecode:review", { active: true, progress: () => undefined });
				pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(reviewing)});
				globalThis.__reviewTick?.();
				${progressOnly ? "" : `pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(settled)}); pi.events.emit("firecode:review", { active: false });`}
				${fixTurn ? `pi.sendMessage({ customType: "mock-fix", content: "修复", display: false }, { triggerTurn: true });` : ""}
			},
		});
	}`;
}

function userText(context: any): string {
	return context.messages.filter((message: any) => message.role === "user")
		.map((message: any) => typeof message.content === "string" ? message.content : message.content?.map((part: any) => part.text).join(""))
		.join("\n");
}
