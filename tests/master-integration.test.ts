import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { dirname, join } from "node:path";
import { fakePi } from "./fake-pi.ts";
import type { Timing } from "../timing.ts";
import { installFaux } from "./faux-host.ts";
import { until } from "./until.ts";
import {
	featuresOnly,
	firecodeModulePath,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_AI_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
} from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall } = await import(PI_AI_COMPAT_URL) as any;
const { getCurrentSystemPrompt } = await import(PI_AI_URL) as any;
const TEST_ROLES = {
	工程师: { model: "test/worker/medium", use: "测试" },
	设计师: { model: "test/worker-2/high", use: "切换测试" },
};
const TIMEOUT_DETAILS = "模型 1 · test/reviewer\n审查会话超时，未在时限内返回有效输出。";
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

let faux: any;
let directory: string | undefined;
let stopSentenceBreaks: (() => void) | undefined;

afterEach(async () => {
	stopSentenceBreaks?.();
	stopSentenceBreaks = undefined;
	setSystemTime();
	delete (globalThis as any).__reviewTick;
	delete (globalThis as any).__loadGate;
	delete (globalThis as any).__inputGate;
	delete (globalThis as any).__masterActive;
	delete (globalThis as any).__pool;
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

test("省略供应商的模型原子能派给可用来源", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: "worker/medium", use: "实现" } } });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "short-name", prompt: "执行", role: "工程师" });
	await settled;
	expect(harness.messages.at(-1).message.content).toContain("完成");
});

test("不可用角色保留在枚举中、不进入角色表；派发它不在动作里挡，开会话解析不出模型作为失败事件告知", async () => {
	const harness = await setup(false, { confirmAnswer: true, roles: { 工程师: TEST_ROLES.工程师, 不可用: { model: "nokey/model/medium", use: "其他工作" } } });
	await harness.emit("session_start", {});
	const prompt = await harness.systemPrompt("主提示词");
	expect(prompt).toContain("工程师（测试）");
	expect(prompt).not.toContain("不可用");
	expect(harness.commandTool.parameters.properties.role.enum).toEqual(["工程师", "不可用"]);
	expect(harness.notices.join("\n")).toContain("不可用");
	faux.setResponses([fauxAssistantMessage("完成")]);
	expect((await harness.execute({ action: "start", worker: "missing", prompt: "执行", role: "不可用" })).details).toMatchObject({ started: true });
	await until(() => eventTitles(harness).includes("missing 失败"));
	expect(harness.messages.at(-1).message.content).toContain("nokey/model");
	expect((await harness.list()).details.workers.find((worker: any) => worker.name === "missing")).toMatchObject({ status: "idle" });
	expect(faux.getPendingResponseCount()).toBe(1);
});

test("角色的凭据在会话开始核对之后才配上：start 照常派发、照常返回结果，档案记下实际模型", async () => {
	const harness = await setup(false, { confirmAnswer: true, roles: { 工程师: TEST_ROLES.工程师, 迟到: { model: "nokey/model/low", use: "凭据后配" } } });
	await harness.emit("session_start", {});
	expect(harness.notices.join("\n")).toContain("迟到");
	process.env.FIRECODE_TEST_UNSET_API_KEY = "faux-key";
	try {
		faux.setResponses([fauxAssistantMessage("凭据到了就能跑")]);
		const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
		expect((await harness.execute({ action: "start", worker: "late", prompt: "执行", role: "迟到" })).details).toMatchObject({ started: true });
		await delivered;
		expect(titleOf(harness.messages.at(-1).message.content)).toBe("late 已返回");
		expect(harness.messages.at(-1).message.content).toContain("凭据到了就能跑");
		expect((await harness.list()).details.workers[0]).toMatchObject({ status: "idle", role: "迟到", model: "nokey/model" });
	} finally {
		delete process.env.FIRECODE_TEST_UNSET_API_KEY;
	}
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

test("/fire-master status 每个子代理一行，以角色为主、模型短名次之，状态词与活动列表同一相位", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("完成")]);
	for (const [worker, role] of [["scout", "工程师"], ["verify", "设计师"]]) {
		const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
		await harness.execute({ action: "start", worker, prompt: "执行", role });
		await settled;
	}
	await harness.command("status");
	expect(harness.notices.at(-1)).toBe("scout 工程师·完成 worker\nverify 设计师·完成 worker-2");
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

test("指挥官提示词作为系统提示段注入，附上已配置的角色表；停用后撤下", async () => {
	const harness = await setup();
	const prompt = await harness.systemPrompt("自定义系统提示");
	const master = (await readFile(new URL("../master/prompts/master.zh.md", import.meta.url), "utf8")).trim();
	expect(prompt).toBe(`自定义系统提示\n\n${master}\n\n角色表：工程师（测试）；设计师（切换测试）。`);
	expect(harness.commandTool.parameters.properties.role.enum).toEqual(["工程师", "设计师"]);
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

test("角色表配置有错时拒绝启动（具体问题文案由配置解析的测试守）", async () => {
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
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
});

test("角色表提示词与 role 枚举都只来自已配置角色", async () => {
	const harness = await setup(true, { roles: { 工程师: TEST_ROLES.工程师 } });
	const prompt = await harness.systemPrompt("主提示词");
	expect(prompt).toContain("角色表：工程师（测试）");
	expect(prompt).not.toContain("设计师：");
	expect(harness.commandTool.parameters.properties.role.enum).toEqual(["工程师"]);
	await expect(harness.execute({
		action: "start", worker: "missing-role", prompt: "执行",
	})).rejects.toThrow("start 必须指定 role");
});

test("list 展开投影 working 的当前动作与本次运行耗时，但模型正文不含动作", async () => {
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
	const session = await turnRunning(harness, "observed");
	const toolStarted = new Promise<void>((resolve) => session.subscribe(async (event: any) => {
		if (event.type !== "tool_execution_start") return;
		resolve();
		await toolGate;
	}));
	at(0);
	const toolEventBefore = Date.now();
	releaseResponse();
	await toolStarted;

	const listed = await harness.list();
	expect(JSON.parse(listed.content[0].text)).toEqual({ workers: [expect.objectContaining({ name: "observed", status: "working" })] });
	expect(listed.content[0].text).not.toContain("phase");
	const workingPhase = (listed.details as any).workers[0].phase;
	expect(workingPhase).toMatchObject({ kind: "running", action: "读取 AGENTS.md" });
	expect(workingPhase.startedAt <= toolEventBefore).toBe(true);
	const collapsed = harness.renderListLine(listed);
	expect(collapsed).toHaveLength(1);
	expect(collapsed[0]).toContain("池 1：observed 工程师·运行中");
	(listed.details as any).workers[0].phase.startedAt = Date.now() - 300;
	const expanded = harness.renderResult(listed, true).join("\n");
	expect(expanded).toContain("observed");
	expect(expanded).toMatch(/工程师·运行中 · 读取 AGENTS\.md · 已 0\.[34]s/u);

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const settledBefore = Date.now();
	releaseTool();
	await delivered;
	const settledAfter = Date.now();
	const done = await harness.list();
	const donePhase = (done.details as any).workers[0].phase;
	expect(donePhase).toMatchObject({ kind: "done", action: "完成" });
	expect(donePhase.settledAt >= settledBefore).toBe(true);
	expect(donePhase.settledAt <= settledAfter).toBe(true);
	donePhase.settledAt = Date.now() - 65_000;
	const doneLine = harness.renderResult(done, true).join("\n");
	expect(doneLine).toContain("工程师·完成 · 完成 · 落定 1m5s前");
});

test("Master 是在飞子代理数的唯一发布者：数量变化发布计数，停用时收口", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "pub", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await settled;
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	await until(() => counts().length === 2);
	expect(counts()).toEqual([1, 0]);

	faux.setResponses([fauxAssistantMessage("再来一次")]);
	const second = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "pub", prompt: "继续" });
	await second;
	await until(() => counts().length === 4);
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
	const rosters = () => harness.emitted.filter(([channel]) => channel === "firecode:subagents").map(([, payload]) => payload.workers);
	await until(() => rosters().at(-1)?.[0]?.state === "done");
	const running = rosters().flat().find((worker: any) => worker.action.includes("AGENTS.md"));
	expect(running).toMatchObject({ name: "roster", role: "工程师", model: "test/worker", thinking: "off", state: "running" });
	expect(typeof running.startedAt).toBe("number");
	expect(running).not.toHaveProperty("settledAt");
	const last = rosters().at(-1)![0];
	expect(last).toMatchObject({ name: "roster", state: "done", action: "完成", startedAt: running.startedAt });
	expect(last.settledAt).toBeGreaterThanOrEqual(running.startedAt);

	await harness.command("");
	expect(rosters().at(-1)).toEqual([]);
});

test("报告现场时序：最后一个子代理在指挥官空闲时返回，整段只歇下一次，且在唤醒回合落定之后", async () => {
	const harness = await setup(true, { holdWake: true });
	const { watchBusy } = await loadFirecodeModule("busy.ts") as any;
	const rounds: number[] = [];
	watchBusy(harness.pi, { onSettled: (elapsed: number) => rounds.push(elapsed) });
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
		await harness.turnRequested;
		await Bun.sleep(5);
		// 唤醒消息已发出、它开的回合还没 agent_start：不能歇下（报告里这里先写了一条整段记录）。
		expect(rounds).toEqual([]);

		await harness.wake();
		await Bun.sleep(5);
		expect(rounds).toEqual([]);
		at(376);
		harness.idle = true;
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		await harness.emit("agent_settled", {});
		expect(rounds).toEqual([376_000]);
	} finally {
		await harness.command("");
	}
});

test("指挥官空闲时陆续到达的一批结果合并成一次唤醒", async () => {
	// 窗口远大于两条结果之间的间隔：用例按条件推进，间隔只有几毫秒。
	const harness = await setup(true, { timing: { wakeQuietMs: 300 } });
	harness.idle = true;
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	faux.setResponses(gates.map((gate, index) => async () => { await gate.promise; return fauxAssistantMessage(`结果 ${index}`); }));
	await harness.execute({ action: "start", worker: "batch-a", prompt: "A", role: "工程师" });
	await harness.execute({ action: "start", worker: "batch-b", prompt: "B", role: "工程师" });
	const arrived = () => harness.appended.filter(([type]) => type === "firecode-master-pending-event").length;
	gates[0].resolve();
	await until(() => arrived() === 1);
	// 第一条到达后安静窗口内不唤醒，等同批的下一条。
	expect(harness.messages).toEqual([]);
	gates[1].resolve();
	await until(() => harness.appended.some(([type]) => type === "firecode-master-event-ack"));
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual({ triggerTurn: true });
	expect(harness.turns).toHaveLength(1);
	expect(harness.turns[0]).toContain("结果 0");
	expect(harness.turns[0]).toContain("结果 1");
	// 每条结果投递前各写一条 pending，整批送达后只写一条 ack。
	expect(harness.appended.map(([type]) => type)).toEqual([
		"firecode-master-pending-event",
		"firecode-master-pending-event",
		"firecode-master-event-ack",
	]);

	await harness.command("");
});

test("在跑的回合到卡住时限没有任何输出就唤醒指挥官：带命令与已用时长，同一段无输出只报一次，有输出后可再报", async () => {
	const harness = await setup(true, { timing: { stallMs: 300 } });
	harness.idle = true;
	const command = "sleep 0.8; echo tick; sleep 0.8";
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
		fauxAssistantMessage("完成"),
	]);
	await harness.execute({ action: "start", worker: "quiet", prompt: "盯着跑", role: "工程师" });
	await until(() => harness.turns.some((turn) => turn.includes("quiet 已返回")), 5_000);
	const stalls = harness.turns.filter((turn) => turn.includes("无输出"));
	// 两段无输出（echo 前后）各唤醒一次：每段远长于时限，仍只报一次。
	expect(stalls).toHaveLength(2);
	for (const stall of stalls) {
		expect(stall).toMatch(/^<firecode_master_event>\nquiet 0 分钟无输出\n/u);
		expect(stall).toContain(`正在跑：操作 $ ${command}`);
		expect(stall).toMatch(/本次运行已跑 \d/u);
	}

	await harness.command("");
});

/**
 * faux 的响应队列是进程内共用的 FIFO：进展行的调用与 Worker 的请求交错出队，所以每一步都按系统提示分流。
 * 返回进展行实际发出的调用数：每次生成都是一次付费调用，“没有新输出就不调用”按它核对。
 */
function progressScript(options: { summary: (user: string, call: number) => any; worker: any[] }) {
	let calls = 0;
	const worker = [...options.worker];
	const step = (context: any) => {
		if (JSON.stringify(context).includes("你为终端界面写一行子代理的进展")) {
			const user = context.messages.findLast((message: any) => message.role === "user").content;
			return options.summary(typeof user === "string" ? user : JSON.stringify(user), ++calls);
		}
		return worker.shift() ?? fauxAssistantMessage("完成");
	};
	faux.setResponses(Array.from({ length: 40 }, () => step));
	return () => calls;
}

test("进展行：运行满时限出第一句（只取首行），没有新输出不再调用，新输出到间隔再生成，落定后停止", async () => {
	const harness = await setup(true, { progress: ["test/summary/low"], timing: { progressFirstMs: 250, progressEveryMs: 700 } });
	const calls = progressScript({
		summary: (user) => fauxAssistantMessage(user.includes("sleep 0.9") ? "「在补跑测试，确认修复没有回归」" : "「正在跑构建，确认改动能编译」\n多余的一行"),
		worker: [
			fauxAssistantMessage([{ type: "text", text: "先看一下构建脚本。" }, fauxToolCall("bash", { command: "sleep 1.4; echo ONE" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.9; echo TWO" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("构建通过"),
		],
	});
	await harness.execute({ action: "start", worker: "builder", prompt: "修复构建", role: "工程师" });
	await until(() => harness.activity().some((line) => line.includes("正在跑构建，确认改动能编译")), 3_000);
	expect(harness.activity().join("\n")).not.toMatch(/多余的一行|「/u);
	// 名册（CuePad 等扩展读的）与活动列表同一句。
	await until(() => harness.emitted.some(([channel, payload]) => channel === "firecode:subagents" && payload.workers[0]?.action === "正在跑构建，确认改动能编译"), 1_000);
	// 第一条命令还在跑、没有任何新输出：过了一个间隔也不再调用。
	await Bun.sleep(800);
	expect(calls()).toBe(1);
	// 第二条命令是新输出：到了间隔就生成新的一句。
	await until(() => harness.activity().some((line) => line.includes("在补跑测试，确认修复没有回归")), 3_000);
	expect(calls()).toBe(2);
	await until(() => harness.messages.some((entry: any) => String(entry.message.content).includes("builder 已返回")), 4_000);
	// 落定后不再调用（最终回复也不算触发），行上不再挂着进展句。
	await Bun.sleep(900);
	expect(calls()).toBe(2);
	expect(harness.activity().join("\n")).not.toContain("在补跑测试");
	await harness.command("");
});

test("进展行：生成失败时那一句撤下、回到工具动作；连续失败只提示一次", async () => {
	const harness = await setup(true, { progress: ["test/summary/low"], timing: { progressFirstMs: 100, progressEveryMs: 150 } });
	progressScript({
		summary: (_user, call) => call === 1
			? fauxAssistantMessage("正在反复构建")
			: fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid key" }),
		worker: Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(fauxToolCall("bash", { command: `sleep 0.3; echo ${index}` }), { stopReason: "toolUse" })),
	});
	await harness.execute({ action: "start", worker: "flaky", prompt: "反复构建", role: "工程师" });
	await until(() => harness.activity().some((line) => line.includes("正在反复构建")), 3_000);
	await until(() => harness.activity().some((line) => line.includes("操作 $ sleep 0.3")), 3_000);
	expect(harness.activity().join("\n")).not.toContain("正在反复构建");
	await until(() => harness.messages.some((entry: any) => String(entry.message.content).includes("flaky 已返回")), 8_000);
	expect(harness.notices.filter((notice) => notice.includes("进展行"))).toHaveLength(1);
	await harness.command("");
});

test("指挥官在跑时结果不等合并窗口，立即经 steer 句缝送达", async () => {
	// 窗口远大于用例超时：送达若等了窗口，用例会超时失败，不靠墙钟阈值判断。
	const harness = await setup(true, { timing: { wakeQuietMs: 60_000 } });
	harness.idle = false;
	faux.setResponses([fauxAssistantMessage("忙时结果")]);
	const steered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "busy", prompt: "做", role: "工程师" });
	await steered;
	// 宿主忙时 triggerTurn 的自定义消息进 steer 队列，不另开回合。
	expect(harness.messages.at(-1).options).toEqual({ triggerTurn: true });
	expect(harness.turns).toEqual([]);
	await harness.command("");
});

test("事件投递失败等待重试期间仍计入在飞", async () => {
	const harness = await setup(true, { failDeliveries: 1 });
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "retry", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await until(() => harness.notices.some((notice) => notice.includes("投递失败")));
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
	// start 写档就返回：实际模型要等第一次请求路由选定，此刻还没有。
	expect(worker).toMatchObject({ status: "working", role: "工程师" });
	expect(worker.model).toBeUndefined();
	await settled;
	await until(async () => (await harness.list()).details.workers[0]?.status === "idle");

	const listed = await harness.list();
	const landed = { ...worker, status: "idle", model: "test/worker", thinking: "off" };
	expect(JSON.parse(listed.content[0].text).workers).toEqual([landed]);
	expect((listed.details as any).workers).toEqual([
		{ ...landed, phase: expect.objectContaining({ kind: "done" }) },
	]);
	expect(harness.messages[0]).toMatchObject({
		message: { customType: "firecode-master-event", content: expect.stringMatching(/^<firecode_master_event>\ntrace 已返回\n回复：\n确定性完成\n耗时：[^\n]+\n<\/firecode_master_event>$/u) },
		options: { triggerTurn: true },
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

test("可重试错误由宿主在原模型重试，不切换模型", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: ["test/worker/medium", "test/worker-2/high"], use: "实现" } } });
	faux.setResponses([fauxAssistantMessage("初始化")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "retry-chain", prompt: "初始化", role: "工程师" });
	await delivered;
	const session = harness.pool.getSession((started.details as any).worker.session);
	session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const models: string[] = [];
	const respond = (_context: any, _options: any, _state: any, model: any) => {
		models.push(model.id);
		return models.length === 1
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" })
			: fauxAssistantMessage("重试完成");
	};
	faux.setResponses([respond, respond]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "retry-chain", prompt: "继续" });
	await delivered;
	expect(models).toEqual(["worker", "worker"]);
	expect(harness.messages.at(-1).message.content).toContain("重试完成");
	expect(harness.messages.some((entry: any) => entry.message.content.includes("已切换模型"))).toBe(false);
});

test("首选额度用尽时同一回合切换到下一模型并返回", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: ["test/worker/medium", "test/worker-2/high"], use: "实现" } } });
	const fault = fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" });
	const respond = (_context: any, _options: any, _state: any, model: any) =>
		model.id === "worker-2" ? fauxAssistantMessage("切换后完成") : fault;
	faux.setResponses([respond, respond, respond]);
	const started = await harness.execute({ action: "start", worker: "chain", prompt: "执行", role: "工程师" });
	await until(() => harness.messages.some((entry: any) => entry.message.content.includes("切换后完成")));
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ model: "test/worker-2", thinking: "off" });
	const session = harness.pool.getSession((started.details as any).worker.session);
	expect(session.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
	// 故障切换照常告知指挥官，带上原因。
	const switched = harness.messages.map((entry: any) => String(entry.message.content)).find((content) => content.includes("chain 已切换模型"));
	expect(switched).toContain("已切换 test/worker/off→test/worker-2/off（insufficient_quota）");
});

test("Claude 订阅 5 小时额度用尽（报错写明当地重置时刻）：子代理暂停到那一刻，指挥官只收到一条不唤醒的暂停说明，不是失败", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const limit = `429: {"message":"Claude Code: You've hit your 5-hour limit · resets 5:10am (Asia/Singapore)","type":"rate_limit_error"}`;
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: limit })]);
	const before = Date.now();
	const noticed = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "limit", prompt: "执行", role: "工程师" });
	await noticed;
	// 新加坡全年 UTC+8：当地 5:10 是 UTC 21:10，取 before 之后最近的一次。
	const today = new Date(before);
	let reset = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 21, 10);
	if (reset <= before) reset += 86_400_000;
	const { clockText } = await loadFirecodeModule("format.js") as any;
	const notice = harness.messages.at(-1);
	expect(titleOf(notice.message.content)).toBe("limit 已暂停");
	expect(notice.message.content).toContain(`${clockText(reset)}（约 `);
	expect(notice.message.content).toContain("You've hit your 5-hour limit");
	expect(notice.options).toEqual({ triggerTurn: false });
	expect(harness.activity().join("\n")).toContain(`暂停至 ${clockText(reset)}`);
	await harness.execute({ action: "kill", worker: "limit" });
});

/** 指挥官收到的事件标题，按到达顺序。 */
const eventTitles = (harness: { messages: any[] }) => harness.messages.flatMap((entry: any) =>
	[...String(entry.message.content).matchAll(/<firecode_master_event>\n(.*)/gu)].map((match) => match[1]));

test("Worker 回合断网失败：暂停后到时自动续跑，网络恢复后完成，指挥官只收到一次最终落定；断网期间不在同一回合里死循环重试", async () => {
	const harness = await setup(true, { timing: { cooldownMs: [40, 80] }, roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
	// 先是宿主认得的 “Connection error.”，再是 Bun 断网时宿主不认的 “Unable to connect”，然后网络恢复。
	const offline = ["Connection error.", "Connection error.", "Unable to connect. Is the computer able to access the url?"];
	let calls = 0;
	const respond = () => {
		const error = offline[calls++];
		return error ? fauxAssistantMessage("", { stopReason: "error", errorMessage: error }) : fauxAssistantMessage("网络恢复后完成");
	};
	faux.setResponses(Array.from({ length: 10 }, () => respond));
	await harness.execute({ action: "start", worker: "net", prompt: "执行", role: "工程师" });
	await until(() => eventTitles(harness).includes("net 已返回"));
	expect(eventTitles(harness)).toEqual(["net 已暂停", "net 已返回"]);
	expect(harness.messages[0].options).toEqual({ triggerTurn: false });
	expect(harness.messages.at(-1).message.content).toContain("网络恢复后完成");
	// 每段断网只有宿主的一次重试，两次续跑各一次调用：同一回合里没有反复打网络。
	expect(calls).toBe(offline.length + 1);
	await harness.command("");
}, 20_000);

test("链上全部模型限流：按冷却到期续跑；期间指挥官收到一条写明暂停到何时、为何的说明，不唤醒、不当失败", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: ["test/worker/medium", "test/worker-2/high"], use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const limited = (seconds: number) => fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 Too Many Requests {"resets_in_seconds": ${seconds}}` });
	const models: string[] = [];
	let recovered = false;
	const respond = (_context: any, _options: any, _state: any, model: any) => {
		models.push(model.id);
		if (recovered) return fauxAssistantMessage("额度恢复后完成");
		return model.id === "worker" ? limited(0.6) : limited(0.3);
	};
	faux.setResponses(Array.from({ length: 6 }, () => respond));
	await harness.execute({ action: "start", worker: "quota", prompt: "执行", role: "工程师" });
	await until(() => eventTitles(harness).includes("quota 已暂停"));
	const notice = harness.messages.find((entry: any) => entry.message.content.includes("quota 已暂停"));
	expect(notice.message.content).toContain("自动续跑");
	expect(notice.message.content).toContain("原因：429 Too Many Requests");
	expect(notice.options).toEqual({ triggerTurn: false });
	// 暂停中的子代理在池查询与 status 里与活动列表同一相位：暂停到续跑时刻，不是“落定”或“空闲”。
	const paused = await harness.list();
	const pausedPhase = (paused.details as any).workers[0].phase;
	expect(pausedPhase.kind).toBe("paused");
	expect(pausedPhase.action).toStartWith("暂停至 ");
	expect(harness.renderResult(paused, true).join("\n")).toContain("工程师·暂停 · 暂停至");
	await harness.command("status");
	expect(harness.notices.at(-1)).toStartWith("quota 工程师·暂停 ");
	recovered = true;
	await until(() => eventTitles(harness).includes("quota 已返回"));
	// 换模型与暂停都只告知不唤醒；唯一唤醒指挥官的是最终落定。
	expect(eventTitles(harness)).toEqual(["quota 已切换模型", "quota 已暂停", "quota 已返回"]);
	for (const entry of harness.messages)
		expect(entry.options.triggerTurn).toBe(entry.message.content.includes("quota 已返回"));
	// 续跑时刻取链上最早恢复的 worker-2（0.3 秒）：那时首选 worker 还在冷却，续跑从链首选起落到 worker-2。
	// 若按晚恢复的 worker 续跑，首选已恢复，最后一次会是 worker。
	expect(models).toEqual(["worker", "worker-2", "worker-2"]);
	await harness.command("");
}, 20_000);

test("指挥官关再开（reload）后池查询与 status 不展示上次运行的落定：与活动列表一样只剩空闲", async () => {
	const harness = await setup(true);
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "old", prompt: "执行", role: "工程师" });
	await delivered;
	expect((await harness.list()).details.workers[0].phase.kind).toBe("done");
	await harness.command("");
	await harness.command("");
	const listed = await harness.list();
	expect(listed.details.workers[0].phase).toEqual({ kind: "idle", action: "" });
	expect(harness.renderResult(listed, true).join("\n")).not.toContain("落定");
	await harness.command("status");
	expect(harness.notices.at(-1)).toBe("old 工程师·空闲 worker");
});

test("等待续跑期间 reload：恢复后按档案里的时刻只续跑一次", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	let calls = 0;
	faux.setResponses(Array.from({ length: 4 }, () => () => (calls++ === 0
		? fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 0.5}` })
		: fauxAssistantMessage("重载后续跑完成"))));
	const noticed = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "reload", prompt: "执行", role: "工程师" });
	await noticed;
	await until(() => harness.appended.some(([type]: [string]) => type === "firecode-master-event-ack"));
	// 两次重载：旧运行时的计时随会话关闭作废，只有最后一个运行时按档案重挂。
	await harness.emit("session_start", {});
	await harness.emit("session_start", {});
	await until(() => eventTitles(harness).includes("reload 已返回"));
	await Bun.sleep(300);
	expect(eventTitles(harness)).toEqual(["reload 已暂停", "reload 已返回"]);
	expect(calls).toBe(2);
	await harness.command("");
}, 20_000);

test("自动续跑的回合进行中被 reload 打断：恢复后仍自动再续，不变成等指挥官处理的中断，最终只落定一次", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 0.2}` }),
		async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("被打断的旧回复"); },
		fauxAssistantMessage("重载后续跑完成"),
	]);
	await harness.execute({ action: "start", worker: "midway", prompt: "执行", role: "工程师" });
	await entered.promise;
	await harness.emit("session_start", {});
	await until(() => eventTitles(harness).includes("midway 已返回"));
	gate.resolve();
	await Bun.sleep(200);
	expect(eventTitles(harness)).toEqual(["midway 已暂停", "midway 已返回"]);
	expect(harness.messages.at(-1).message.content).toContain("重载后续跑完成");
	expect((await harness.list().then((result) => result.details as any)).workers[0].interruptedAt).toBeUndefined();
	await harness.command("");
}, 20_000);

test("暂停期间指挥官 send 换检出：立即接手（自动续跑作废），新会话开不成作为失败告知", async () => {
	const harness = await setup(true, { loadGate: true, roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const other = join(harness.cwd, "other");
	await mkdir(other);
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 0.2}` }),
		fauxAssistantMessage("send 失败后续跑完成"),
	]);
	await harness.execute({ action: "start", worker: "handover", prompt: "执行", role: "工程师" });
	await until(() => eventTitles(harness).includes("handover 已暂停"));
	const load = Promise.withResolvers<void>();
	(globalThis as any).__loadGate = load.promise;
	// 换 cwd 的 send 写档接手就返回；后台释放热会话后重开，卡在加载上，期间原定的续跑时刻已过也不续。
	expect((await harness.execute({ action: "send", worker: "handover", prompt: "换个检出", cwd: other })).details).toEqual({ sent: true });
	expect((await harness.list()).details.workers[0]).toMatchObject({ status: "working" });
	expect((await harness.list()).details.workers[0].resume).toBeUndefined();
	await Bun.sleep(400);
	(globalThis as any).__loadGate = undefined;
	load.reject(new Error("加载失败"));
	await until(() => eventTitles(harness).includes("handover 失败"));
	expect(eventTitles(harness)).toEqual(["handover 已暂停", "handover 失败"]);
	expect(harness.messages.at(-1).message.content).toContain("加载失败");
	expect(faux.getPendingResponseCount()).toBe(1);
	await harness.command("");
}, 20_000);

test("链上另一个模型还在瞬时冷却、这次实际调用的模型鉴权失败：照常以失败送达，不被冷却盖成暂停", async () => {
	const harness = await setup(true, { roles: {
		工程师: { model: "test/worker/medium", use: "实现" },
		设计师: { model: ["test/worker/medium", "test/worker-2/high"], use: "切换测试" },
	} });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 600}` }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" }),
	]);
	await harness.execute({ action: "start", worker: "cooling", prompt: "执行", role: "工程师" });
	await until(() => eventTitles(harness).includes("cooling 已暂停"));
	await harness.execute({ action: "start", worker: "badkey", prompt: "执行", role: "设计师" });
	await until(() => eventTitles(harness).includes("badkey 失败"));
	expect(harness.messages.find((entry: any) => entry.message.content.includes("badkey 失败")).message.content).toContain("401 Unauthorized");
	await harness.execute({ action: "kill", worker: "cooling" });
	await harness.command("");
});

test("非瞬时错误（鉴权失败）照常以失败送达，不暂停、不重试；指挥官回合遇到鉴权错误也不被补唤醒", async () => {
	const harness = await setup(true, { timing: { cooldownMs: [20] }, failTurns: { count: 1, error: "401 Unauthorized: invalid x-api-key" }, roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	harness.idle = true;
	let calls = 0;
	faux.setResponses(Array.from({ length: 3 }, () => () => (calls++, fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" }))));
	await harness.execute({ action: "start", worker: "auth", prompt: "执行", role: "工程师" });
	await until(() => harness.turns.length === 1);
	await Bun.sleep(200);
	expect(eventTitles(harness)).toEqual(["auth 失败"]);
	expect(harness.messages[0].message.content).toContain("401 Unauthorized");
	expect(calls).toBe(1);
	expect(harness.turns).toHaveLength(1);
	await harness.command("");
});

test("指挥官自己的回合断网失败、手上的子代理事件还没处理：恢复后被重新唤起一次，回合成功后不再补", async () => {
	const harness = await setup(true, { timing: { cooldownMs: [30, 60] }, failTurns: { count: 2, error: "Connection error." } });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "event", prompt: "执行", role: "工程师" });
	await until(() => harness.turns.length === 3);
	await Bun.sleep(200);
	expect(harness.turns).toHaveLength(3);
	expect(titleOf(harness.turns[0])).toBe("event 已返回");
	for (const turn of harness.turns.slice(1)) {
		expect(titleOf(turn)).toBe("指挥官 续跑");
		expect(turn).toContain("Connection error.");
	}
	await harness.command("");
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
	expect(content).toContain(providerError);
	expect(content).not.toContain("上一回合回复");
	expect(content).not.toContain("（无回复）");
});

test("输出截断后同回合切换模型，后续派活仍可使用首选", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: ["test/worker/medium", "test/worker-2/high"], use: "实现" } } });
	const respond = (_context: any, _options: any, _state: any, model: any) => model.id === "worker"
		? fauxAssistantMessage("部分内容", { stopReason: "length" })
		: fauxAssistantMessage("完整结果");
	faux.setResponses([respond, respond]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "truncated-chain", prompt: "执行", role: "工程师" });
	await delivered;
	await until(() => harness.messages.some((entry: any) => /完整结果|截断/u.test(entry.message.content)));
	expect(harness.messages.map((entry: any) => entry.message.content).join("\n")).toContain("完整结果");
	const session = harness.pool.getSession((started.details as any).worker.session);
	expect(session.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
	const models: string[] = [];
	const next = (_context: any, _options: any, _state: any, model: any) => {
		models.push(model.id);
		return fauxAssistantMessage(models.length === 1 ? "新会话完成" : "续派完成");
	};
	faux.setResponses([next, next]);
	await harness.execute({ action: "start", worker: "another", prompt: "执行", role: "工程师" });
	await until(() => harness.messages.some((entry: any) => entry.message.content.includes("新会话完成")));
	await harness.execute({ action: "send", worker: "truncated-chain", prompt: "继续" });
	await until(() => harness.messages.some((entry: any) => entry.message.content.includes("续派完成")));
	expect(models).toEqual(["worker", "worker"]);
});

test("输出截断即使已有正文也按失败投递，不能报告正常返回", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("看似完整的结果", { stopReason: "length" })]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "truncated", prompt: "执行", role: "工程师" });
	await delivered;
	const content = harness.messages[0].message.content;
	expect(content).toContain("错误：");
	expect(content).toContain("截断");
	expect(content).not.toContain("已返回");
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
	const module = await loadFirecodeModule("spawn.js") as any;
	const sessionPath = join(directory!, "sessions", "subagents", "worker.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	const options = {
		cwd: harness.cwd,
		chain: [{ model: "test/worker", thinking: "medium" }],
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
	pool.disposeWorkers();
});

test("池不自判空闲：只有 markIdle 后才起释放计时，释放前会话扩展先收到 session_shutdown", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 10 }, shutdownProbe: true });
	const sessionPath = join(directory!, "sessions", "subagents", "pool-idle.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const spawned = await harness.pool.spawn({
		cwd: harness.cwd, chain: [{ model: "test/worker", thinking: "medium" }], tools: [],
		systemPrompt: { mode: "replace", text: "test" }, contextFiles: false,
		persistence: { type: "file", sessionPath },
	});
	await spawned.prompt("回合");
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(harness.pool.getSession(sessionPath)).toBeDefined();
	harness.pool.markIdle(sessionPath);
	await until(() => harness.pool.getSession(sessionPath) === undefined);
	await until(() => existsSync(join(directory!, "shutdown.log")));
	expect(await readFile(join(directory!, "shutdown.log"), "utf8")).toBe("quit\n");
});

test("reviewing 中的 Worker 回合早已落定也不会被 idle 超时释放", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 10 }, mockReview: true, review: true, reviewProgressOnly: true, reviewFixTurn: true });
	faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("修复完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const result = await harness.execute({ action: "start", worker: "review-hot", prompt: "完成", role: "工程师" });
	await settled;
	const path = (result.details as any).worker.session;
	await harness.execute({ action: "review", worker: "review-hot" });
	// 修复回合的回复被取走后，再等过 10ms 的 idle 超时数倍，热会话仍应在。
	await until(() => faux.getPendingResponseCount() === 0);
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(harness.pool.getSession(path)).toBeDefined();
	expect((await harness.list().then((listed) => listed.details as any)).workers[0].status).toBe("reviewing");
});

/** 子会话每建一次（session_start）就在 log 里记一行它的会话路径；shutdownGate 为真时 session_shutdown 卡在 globalThis.__shutdownGate 上。 */
async function sessionProbe(agentDir: string, log: string, shutdownGate = false): Promise<() => Promise<string[]>> {
	await writeFile(join(agentDir, "extensions", "session-probe.ts"), `import { appendFileSync } from "node:fs";
	export default function(pi) {
		pi.on("session_start", (_event, ctx) => appendFileSync(${JSON.stringify(log)}, (ctx.sessionManager.getSessionFile() ?? "") + "\\n"));
		${shutdownGate ? `pi.on("session_shutdown", async () => { globalThis.__shutdownGate?.entered(); await globalThis.__shutdownGate?.open; });` : ""}
	}`);
	return async () => existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : [];
}

test("send 换检出、后台还在释放旧会话时 kill：之后才轮到的开会话不再新建", async () => {
	const harness = await setup();
	const created = await sessionProbe(harness.agentDir, join(directory!, "created.log"), true);
	const other = join(harness.cwd, "other");
	await mkdir(other);
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "moved", prompt: "初始", role: "工程师" });
	await delivered;
	const path = (await harness.list()).details.workers[0].session;
	const before = (await created()).filter((line) => line === path).length;
	const entered = Promise.withResolvers<void>();
	const open = Promise.withResolvers<void>();
	(globalThis as any).__shutdownGate = { entered: entered.resolve, open: open.promise };
	try {
		faux.setResponses([fauxAssistantMessage("不应执行")]);
		// 换检出的 send 在后台先释放旧会话（session_shutdown 卡住），释放完才开新会话；kill 落在这中间。
		expect((await harness.execute({ action: "send", worker: "moved", prompt: "换检出", cwd: other })).details).toEqual({ sent: true });
		await entered.promise;
		await harness.execute({ action: "kill", worker: "moved" });
		open.resolve();
		await Bun.sleep(300);
		expect((await created()).filter((line) => line === path).length - before).toBe(0);
		expect(harness.pool.getSession(path)).toBeUndefined();
		expect(faux.getPendingResponseCount()).toBe(1);
		expect((await harness.list()).details.workers).toEqual([]);
	} finally {
		open.resolve();
		delete (globalThis as any).__shutdownGate;
	}
});

test("send 已在等同一路径的空闲释放收口时 kill：收口完也不再新建会话", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 20 } });
	const created = await sessionProbe(harness.agentDir, join(directory!, "created.log"), true);
	const entered = Promise.withResolvers<void>();
	const open = Promise.withResolvers<void>();
	(globalThis as any).__shutdownGate = { entered: entered.resolve, open: open.promise };
	try {
		faux.setResponses([fauxAssistantMessage("初始完成")]);
		await harness.execute({ action: "start", worker: "parked", prompt: "初始", role: "工程师" });
		const path = (await harness.list()).details.workers[0].session;
		// 空闲到期释放，session_shutdown 卡住：send 的 spawn 在等这次释放。
		await entered.promise;
		const before = (await created()).filter((line) => line === path).length;
		faux.setResponses([fauxAssistantMessage("不应执行")]);
		expect((await harness.execute({ action: "send", worker: "parked", prompt: "接着做" })).details).toEqual({ sent: true });
		await harness.execute({ action: "kill", worker: "parked" });
		open.resolve();
		await Bun.sleep(300);
		expect((await created()).filter((line) => line === path).length - before).toBe(0);
		expect(harness.pool.getSession(path)).toBeUndefined();
		expect(faux.getPendingResponseCount()).toBe(1);
		expect((await harness.list()).details.workers).toEqual([]);
	} finally {
		open.resolve();
		delete (globalThis as any).__shutdownGate;
	}
});

test("kill 不等 Worker 的 session_shutdown（处理器没有时限）：立即返回，收口随后照常完成", async () => {
	const harness = await setup(true, { shutdownProbe: true });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "shutdown-order", prompt: "完成", role: "工程师" });
	await settled;
	expect((await harness.execute({ action: "kill", worker: "shutdown-order" })).details).toEqual({ killed: true });
	await until(() => existsSync(join(directory!, "shutdown.log")));
	expect(await readFile(join(directory!, "shutdown.log"), "utf8")).toBe("quit\n");
});

test("空闲会话自动释放后 kill 仍只删档案并保留会话文件", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 10 } });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "cold-kill", prompt: "完成", role: "工程师",
	});
	await settled;
	const sessionPath = (started.details as any).worker.session;
	await until(() => harness.pool.getSession(sessionPath) === undefined);
	await harness.execute({ action: "kill", worker: "cold-kill" });
	expect(existsSync(sessionPath)).toBe(true);
	// 池空了，档案文件随之删除。
	expect(await readdir(join(harness.agentDir, "tmp"))).not.toContain(`firecode-master-${harness.sessionId}.json`);
});

test("空闲投递唤起的回合还没开始时替换会话，旧投递不得确认到新 runtime", async () => {
	const harness = await setup(true, { holdWake: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("旧会话结果")]);
	await harness.execute({
		action: "start", worker: "old-delivery", prompt: "执行", role: "工程师",
	});
	await harness.turnRequested;
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

test("本次运行耗时读子代理会话自己写的轮记录：子代理没装轮记录器时事件不带本次运行，不拿指挥官这边的计时冒充", async () => {
	const harness = await setup(true, { workerRecorder: false });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "bare", prompt: "执行", role: "工程师" });
	await delivered;
	expect(harness.messages.at(-1).message.content).not.toContain("本次运行");
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
	await until(() => inFlightCounts(harness).length === 2);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	const wakes = harness.turns.length;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.viewSend("viewed", "把标题改短");
	await delivered;
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	expect(harness.turns).toHaveLength(wakes);
	const { message, options } = harness.messages.at(-1);
	expect(titleOf(message.content)).toBe("viewed 已返回（你在子代理视图里直接派的）");
	expect(message.content).toContain("回复：\n按你说的改好了");
	expect(options).toEqual({ triggerTurn: false });
});

test("视图派的运行暂停后 reload：续跑落定仍注明视图来源、带原话，只告知不唤醒指挥官", async () => {
	const harness = await setup(true, { roles: { 工程师: { model: "test/worker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "vv", prompt: "初始", role: "工程师" });
	await delivered;
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 0.4}` }),
		fauxAssistantMessage("视图续跑完成"),
	]);
	await harness.viewSend("vv", "视图里说的");
	await until(async () => (await harness.list()).details.workers[0]?.resume);
	await harness.command("");
	await harness.command("");
	await until(() => harness.messages.some((entry: any) => String(entry.message.content).includes("视图续跑完成")));
	const { message, options } = harness.messages.find((entry: any) => String(entry.message.content).includes("视图续跑完成"));
	expect(titleOf(message.content)).toBe("vv 已返回（你在子代理视图里直接派的）");
	expect(message.content).toContain("你说：视图里说的");
	expect(options).toEqual({ triggerTurn: false });
	expect(inFlightCounts(harness).at(-1)).toBe(0);
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
	await until(() => inFlightCounts(harness).length === 2);
	const wakes = harness.turns.length;

	await harness.viewSend("shared", "视图里说的");
	await Bun.sleep(5);
	expect(inFlightCounts(harness)).toEqual([1, 0]);
	await harness.execute({ action: "send", worker: "shared", prompt: "指挥官补充" });
	await until(() => inFlightCounts(harness).length === 3);
	expect(inFlightCounts(harness)).toEqual([1, 0, 1]);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	await until(() => inFlightCounts(harness).length === 4);
	expect(harness.turns).toHaveLength(wakes + 1);
	expect(titleOf(harness.turns.at(-1)!)).toBe("shared 已返回（你在子代理视图里直接派的）");
	expect(harness.turns.at(-1)).toContain("你说：视图里说的");
	expect(inFlightCounts(harness)).toEqual([1, 0, 1, 0]);
});

test("子代理被 kill 时通知订阅方（全过程视图据此显示已移除）；之后视图补话报明确错误", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "quick", prompt: "执行", role: "工程师" });
	await delivered;
	const removed: string[] = [];
	(globalThis as any).__masterActive.onWorkerRemoved((name: string) => removed.push(name));
	await harness.execute({ action: "kill", worker: "quick" });
	expect(removed).toEqual(["quick"]);
	await expect(harness.viewSend("quick", "还在吗")).rejects.toThrow("子代理不存在：quick");
});

test("指挥官模式关掉后，还开着的全过程视图对在跑的子代理补话或中断：明确报会话已替换", async () => {
	const harness = await setup();
	const hold = Promise.withResolvers<void>();
	faux.setResponses([async () => { await hold.promise; return fauxAssistantMessage("完成"); }]);
	await harness.execute({ action: "start", worker: "orphan", prompt: "执行", role: "工程师" });
	await harness.command("");
	// 视图握着的是关闭前的运行时（__masterActive 停在它上面）。
	await expect(harness.viewSend("orphan", "视图补话")).rejects.toThrow("Master 会话已替换");
	await expect(harness.viewInterrupt("orphan")).rejects.toThrow("Master 会话已替换");
	hold.resolve();
});

test("在飞 send 拒绝；指挥官 interrupt 落中断标记但不补发“待续跑”，首次 send 自动注入现场自检", async () => {
	const harness = await setup(true, { timing: { interruptResumeMs: 10 } });
	let resumedPrompt = "";
	faux.setResponses([
		async (_context: any, options: any) => {
			await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("已中断");
		},
	]);
	await harness.execute({
		action: "start", worker: "interrupted", prompt: "开始", role: "工程师",
	});
	await expect(harness.execute({ action: "send", worker: "interrupted", prompt: "换角色", role: "设计师" }))
		.rejects.toThrow("先 interrupt");
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "interrupted" });
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("interrupted 被中断");
	// 中断是指挥官自己发起的，它知道现场：过了提醒时限也不补发“待续跑”。
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.messages.map((entry: any) => titleOf(entry.message.content))).toEqual(["interrupted 被中断"]);

	faux.setResponses([(context: any) => {
		resumedPrompt = userText(context);
		return fauxAssistantMessage("续跑完成");
	}]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "interrupted", prompt: "继续" });
	await delivered;
	expect(resumedPrompt).toContain("<firecode_master_event>");
	expect(resumedPrompt).toContain("上次被外部中断");
	expect(resumedPrompt).toContain("</firecode_master_event>");
	const listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed.interruptedAt).toBeUndefined();
});

test("会话重载打断的回合：恢复后补挂续跑提醒，提醒说清是重载打断而不是“外部中断后无人接手”", async () => {
	const harness = await setup(false, { timing: { interruptResumeMs: 10 } });
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 10, workers: [{
		name: "reloaded", role: "工程师", model: "test/worker", thinking: "medium", status: "working", sessionPath: join(harness.cwd, "w.jsonl"), cwd: harness.cwd, launch: 1,
	}] }));
	await harness.command("");
	await until(() => harness.messages.length > 0);
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
	const started = await harness.execute({ action: "start", worker: "steered", prompt: "开始", role: "工程师" });
	await entered.promise;
	expect((await harness.execute({ action: "send", worker: "steered", prompt: "补充说明" })).details).toEqual({ queued: true });
	const session = harness.pool.getSession((started.details as any).worker.session);
	await until(() => session.getSteeringMessages().length === 1);
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
	const started = await harness.execute({ action: "start", worker: "stranded", prompt: "开始", role: "工程师" });
	await entered.promise;
	await harness.execute({ action: "send", worker: "stranded", prompt: "迟到的补充" });
	const session = harness.pool.getSession((started.details as any).worker.session);
	await until(() => session.getSteeringMessages().length === 1);
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

test("中止失败的 interrupt 报给用户，不会把本回合或下一回合误记为中断", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("自然完成");
	}]);
	await harness.execute({ action: "start", worker: "abort-race", prompt: "执行", role: "工程师" });
	const session = await turnRunning(harness, "abort-race");
	session.abort = async () => { throw new Error("abort failed"); };
	expect((await harness.execute({ action: "interrupt", worker: "abort-race" })).details).toEqual({ interrupting: true });
	// 中止失败报给用户（interrupt 已经返回，没有调用方可抛），意图撤回。
	await until(() => harness.notices.some((notice: string) => notice.includes("abort failed")));

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("自然完成");
	expect(harness.messages.at(-1).message.content).not.toContain("被中断");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker.interruptedAt).toBeUndefined();
});

test("同一空闲 Worker 的并发 send 只开一次运行：后到的一票作为补话交给这次回合", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "single-flight", prompt: "初始化", role: "工程师",
	});
	await delivered;

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let seen = "";
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" });
		},
		(context: any) => {
			seen = userText(context);
			return fauxAssistantMessage("唯一结果");
		},
	]);
	const sends = await Promise.all([
		harness.execute({ action: "send", worker: "single-flight", prompt: "第一票" }),
		harness.execute({ action: "send", worker: "single-flight", prompt: "第二票" }),
	]);
	expect(sends.map((result) => result.details)).toEqual([{ sent: true }, { queued: true }]);
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("working");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const session = await turnRunning(harness, "single-flight");
	// 补话进了这次回合：还在宿主队列里，或已注入会话（宿主在第一次调模型前就会取走）。
	await until(() => session.getSteeringMessages().includes("第二票") || userText(session).includes("第二票"));
	release();
	await delivered;
	expect(seen).toContain("第二票");
	expect(harness.messages).toHaveLength(2);
	expect(harness.messages.at(-1).message.content).toContain("唯一结果");
	expect(faux.getPendingResponseCount()).toBe(0);
});

test("kill 赢过还在开会话的 send/review：不调模型、异步写回不会复活已删档案、不留热会话", async () => {
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

	const paths = (await harness.list()).details.workers.map((worker: any) => worker.session);
	faux.setResponses([fauxAssistantMessage("不应执行")]);
	const sending = harness.execute({
		action: "send", worker: "kill-send", prompt: "新任务", role: "设计师",
	});
	await harness.execute({ action: "kill", worker: "kill-send" });
	expect((await sending).details).toEqual({ sent: true });
	const reviewing = harness.execute({ action: "review", worker: "kill-review" });
	await harness.execute({ action: "kill", worker: "kill-review" });
	expect((await reviewing).details).toEqual({ reviewing: true });
	await Bun.sleep(50);
	expect(faux.getPendingResponseCount()).toBe(1);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	expect(harness.pool.getSession(paths[0])).toBeUndefined();
	expect(harness.pool.getSession(paths[1])).toBeUndefined();
	expect(harness.messages).toHaveLength(2);
});

test("审查终态在子代理的 agent_settled 处理器里写下、后面还有慢处理器时立刻 send：等处理器跑完再开回合，结果照常返回，不误报失败", async () => {
	const harness = await setup(true, { review: true });
	await writeFile(join(harness.agentDir, "extensions", "slow-review.ts"), slowSettleReviewExtension(50));
	const events = () => harness.messages.flatMap((entry: any) => String(entry.message.content).split("<firecode_master_event>\n").slice(1));
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("修复回合完成"), fauxAssistantMessage("接着做完了")]);
	await harness.execute({ action: "start", worker: "sl", prompt: "初始", role: "工程师" });
	await until(() => events().some((event: string) => event.startsWith("sl 已返回")));
	await harness.execute({ action: "review", worker: "sl" });
	await until(() => events().some((event: string) => event.startsWith("sl 审查通过")));
	expect((await harness.list()).details.workers[0].status).toBe("idle");
	await harness.execute({ action: "send", worker: "sl", prompt: "立刻接着做" });
	await until(() => events().length === 3);
	expect(events()[2]).toStartWith("sl 已返回");
	expect(events()[2]).toContain("接着做完了");
	expect((await harness.list()).details.workers[0].status).toBe("idle");
});

test("start 开会话期间被 kill：不调模型、不留热会话、档案不复活", async () => {
	const harness = await setup(true, { loadGate: true });
	faux.setResponses([fauxAssistantMessage("被 kill 的子代理不应执行")]);
	const gate = Promise.withResolvers<void>();
	(globalThis as any).__loadGate = gate.promise;
	const starting = harness.execute({ action: "start", worker: "racy", prompt: "做事", role: "工程师" });
	let workers: any[] = [];
	await until(async () => (workers = (await harness.list()).details.workers).length > 0);
	const sessionPath = workers[0].session;
	await harness.execute({ action: "kill", worker: "racy" });
	gate.resolve();
	expect((await starting).details).toMatchObject({ started: true });
	await Bun.sleep(50);
	expect(faux.getPendingResponseCount()).toBe(1);
	expect(harness.pool.getSession(sessionPath)).toBeUndefined();
	expect((await harness.list()).details.workers).toEqual([]);
});

test("start 还在开会话时 interrupt：立即返回，会话开好后不调模型，直接落定为被中断", async () => {
	const harness = await setup(true, { loadGate: true });
	faux.setResponses([fauxAssistantMessage("被中断的子代理不应执行")]);
	const gate = Promise.withResolvers<void>();
	(globalThis as any).__loadGate = gate.promise;
	const starting = harness.execute({ action: "start", worker: "slow", prompt: "做事", role: "工程师" });
	await until(async () => (await harness.list()).details.workers[0]?.status === "working");
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	expect((await harness.execute({ action: "interrupt", worker: "slow" })).details).toEqual({ interrupting: true });
	gate.resolve();
	await starting;
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("slow 被中断");
	expect(faux.getPendingResponseCount()).toBe(1);
	expect((await harness.list()).details.workers[0]).toMatchObject({ status: "idle", interruptedAt: expect.any(Number) });
});

test("子会话的 input 处理器挂住时 start 与 send 都立即返回（档案已进 working），放开后照常落定、结果照常返回", async () => {
	const harness = await setup(true, { inputGate: true });
	const quick = <T>(pending: Promise<T>) => Promise.race([pending, Bun.sleep(1_000).then(() => ({ details: "仍未返回" }))]);
	const gate = () => {
		const entered = Promise.withResolvers<void>();
		const open = Promise.withResolvers<void>();
		(globalThis as any).__inputGate = { entered: entered.resolve, open: open.promise };
		return { entered: entered.promise, open: open.resolve };
	};

	let held = gate();
	faux.setResponses([fauxAssistantMessage("start 的结果")]);
	expect((await quick(harness.execute({ action: "start", worker: "gs", prompt: "INPUT-GATE 开工", role: "工程师" }))).details)
		.toMatchObject({ started: true, worker: { name: "gs", status: "working" } });
	await held.entered;
	expect((await harness.list()).details.workers[0].status).toBe("working");
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	held.open();
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("gs 已返回");
	expect(harness.messages.at(-1).message.content).toContain("start 的结果");

	held = gate();
	faux.setResponses([fauxAssistantMessage("send 的结果")]);
	expect((await quick(harness.execute({ action: "send", worker: "gs", prompt: "INPUT-GATE 接着做" }))).details).toEqual({ sent: true });
	await held.entered;
	expect((await harness.list()).details.workers[0].status).toBe("working");
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	held.open();
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("gs 已返回");
	expect(harness.messages.at(-1).message.content).toContain("send 的结果");
	expect((await harness.list()).details.workers[0].status).toBe("idle");
});

test("回合卡在宿主前置阶段（input 处理器不返回）时 interrupt 立即返回：期间 send 报正在中断，开闸后落定为被中断，任务没有被悄悄跑完", async () => {
	const harness = await setup(true, { inputGate: true });
	faux.setResponses([fauxAssistantMessage("初始化完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "pre", prompt: "初始化", role: "工程师" });
	await delivered;
	const entered = Promise.withResolvers<void>();
	const open = Promise.withResolvers<void>();
	(globalThis as any).__inputGate = { entered: entered.resolve, open: open.promise };
	faux.setResponses([fauxAssistantMessage("不该完成")]);
	const sending = harness.execute({ action: "send", worker: "pre", prompt: "INPUT-GATE 新任务" });
	await entered.promise;
	const interrupting = harness.execute({ action: "interrupt", worker: "pre" });
	expect(await Promise.race([interrupting.then((result) => result.details), Bun.sleep(1_000).then(() => "仍未返回")])).toEqual({ interrupting: true });
	await expect(harness.execute({ action: "send", worker: "pre", prompt: "改个说法" })).rejects.toThrow("正在中断");
	expect((await harness.list()).details.workers[0].status).toBe("working");
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	open.resolve();
	await sending;
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("pre 被中断");
	const session = harness.pool.getSession((await harness.list()).details.workers[0].session);
	expect(session.messages.filter((message: any) => message.role === "assistant").map((message: any) => JSON.stringify(message.content)).join("\n")).not.toContain("不该完成");
	expect((await harness.list()).details.workers[0]).toMatchObject({ status: "idle", interruptedAt: expect.any(Number) });
});

test("回合卡在宿主前置阶段时补话立即返回，开闸后在句缝送达；记下中断意图后才送的补话作为未送达回报", async () => {
	const harness = await setup(true, { inputGate: true });
	const gateInput = () => {
		const entered = Promise.withResolvers<void>();
		const open = Promise.withResolvers<void>();
		(globalThis as any).__inputGate = { entered: entered.resolve, open: open.promise };
		return { entered: entered.promise, open: open.resolve };
	};
	const within = (pending: Promise<any>) => Promise.race([pending.then((result) => result.details), Bun.sleep(1_000).then(() => "仍未返回")]);
	let session: any;
	faux.setResponses([
		// 句缝在补话交给宿主之后：首个回复等它进了队列（或已被宿主带进本回合）再交出工具调用。
		async () => {
			await until(() => session.getSteeringMessages().length || JSON.stringify(session.messages).includes("补充要求"));
			return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" });
		},
		(context: any) => fauxAssistantMessage(userText(context).includes("补充要求") ? "收到补充" : "没收到"),
	]);
	let input = gateInput();
	const starting = harness.execute({ action: "start", worker: "late", prompt: "INPUT-GATE 做事", role: "工程师" });
	await input.entered;
	session = harness.pool.getSession((await harness.list()).details.workers[0].session);
	expect(await within(harness.execute({ action: "send", worker: "late", prompt: "补充要求" }))).toEqual({ queued: true });
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	input.open();
	await starting;
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("收到补充");

	faux.setResponses([async (_context: any, options: any) => {
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中止");
	}]);
	input = gateInput();
	const sending = harness.execute({ action: "send", worker: "late", prompt: "INPUT-GATE 下一件" });
	await input.entered;
	expect(await within(harness.execute({ action: "send", worker: "late", prompt: "顺便补一句" }))).toEqual({ queued: true });
	expect(await within(harness.execute({ action: "interrupt", worker: "late" }))).toEqual({ interrupting: true });
	// 两条事件可能合并在同一次唤醒里：按每个信封的标题找。
	const events = () => harness.messages.flatMap((entry: any) => String(entry.message.content).split("<firecode_master_event>\n").slice(1));
	input.open();
	await sending;
	await until(() => events().some((event: string) => event.startsWith("late 被中断\n")) && events().some((event: string) => event.startsWith("late 补充说明未送达\n")));
	expect(events().find((event: string) => event.startsWith("late 补充说明未送达\n"))).toContain("顺便补一句");
});

test("补话越过 input 处理器后按最新档案写回：期间落定的作为未送达回报、不被改回 working、不挂审查义务，期间被 kill 不复活也不回报", async () => {
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

	// 期间落定：补充说明没进回合，作为未送达回报；档案保持落定后的 idle，不挂审查义务，在飞数归零。
	const finish = await startHeld("settles");
	let input = gateInput();
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	expect((await harness.execute({ action: "send", worker: "settles", prompt: "INPUT-GATE 补充", review: true })).details).toEqual({ queued: true });
	await input.entered;
	finish();
	await delivered;
	input.open();
	await until(() => harness.messages.some((entry: any) => titleOf(entry.message.content) === "settles 补充说明未送达"));
	expect(harness.messages.at(-1).message.content).toContain("INPUT-GATE 补充");
	expect((await harness.list()).details.workers[0]).toMatchObject({ name: "settles", status: "idle" });
	expect((await harness.list()).details.workers[0].reviewNeeded).toBeUndefined();
	expect(counts().at(-1)).toBe(0);

	// 期间被 kill：档案不复活。
	await startHeld("killed");
	input = gateInput();
	const before = harness.messages.length;
	await harness.execute({ action: "send", worker: "killed", prompt: "INPUT-GATE 补充", review: true });
	await input.entered;
	await harness.execute({ action: "kill", worker: "killed" });
	input.open();
	await Bun.sleep(50);
	expect(harness.messages.length).toBe(before);
	expect((await harness.list()).details.workers.map((worker: any) => worker.name)).toEqual(["settles"]);
});

test("活动列表：失败行留到 ack，完成的合进“✓ N 个已完成”留到 kill", async () => {
	const harness = await setup();
	faux.setResponses([async () => { throw new Error("quota exhausted"); }, fauxAssistantMessage("完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "broken", prompt: "执行", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "fine", prompt: "执行", role: "设计师" });
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

test("恢复后新 start 的启动序接在档案里已有的之后", async () => {
	const harness = await setup(false);
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	const archived = [["mid", 3], ["zeta", 1], ["alpha", 2]] as const;
	await writeFile(path, JSON.stringify({ version: 10, workers: archived.map(([name, launch]) => ({
		name, role: "哨兵", model: "test/worker", thinking: "low", status: "idle", sessionPath: join(harness.cwd, `${name}.jsonl`), cwd: harness.cwd, launch,
	})) }));
	await harness.command("");
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

	const expanded = harness.renderResult(await harness.list(), true).join("\n");
	expect(expanded).toContain("工程师·审查中 · 审查第 1 轮 · 0/1 通过");
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
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("review-missing 审查未完成");
	expect(harness.messages.at(-1).message.content).toContain("review-missing 审查未完成\n错误：\n");
	expect(harness.messages.at(-1).message.content).toContain("审查未启动");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", reviewNeeded: true });
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
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("refused 审查未完成");
	expect(content).toContain("未知字段 review.language");
	expect(content).not.toContain("审查未启动");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", reviewNeeded: true });
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
	await turnRunning(harness, "clock");
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	at(40);
	await harness.execute({ action: "interrupt", worker: "clock" });
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("clock 被中断");
	// 没有审查义务就不提审查义务。
	expect(content).not.toContain("审查义务");
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
		status: "idle", role: "工程师", model: "test/worker", thinking: "off",
		session: (started.details as any).worker.session,
	});
	const sessionText = await Bun.file(worker.session).text();
	expect(sessionText.match(/"type":"model_change"/gu)).toHaveLength(1);
});

test("send 对冷 Worker 透明复活、省略角色沿用、显式角色原地切换并入会话记录", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 10 } });
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
	await until(() => harness.pool.getSession(sessionPath) === undefined);

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
	expect(listed).toMatchObject({ status: "idle", role: "设计师", model: "test/worker-2" });
	const sessionText = await Bun.file(sessionPath).text();
	expect(sessionText).toContain('"type":"model_change"');
	expect(sessionText).toContain('"type":"thinking_level_change"');
	// 换角色是指挥官自己的决定，不是故障切换：不发“已切换模型”。
	expect(eventTitles(harness).filter((title: string) => title.includes("已切换模型"))).toEqual([]);
});

test("热会话里 send 换角色：档案记新角色实际用的模型，指挥官不收“已切换模型”", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("切换完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "swap", prompt: "第一轮", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "swap", prompt: "切换", role: "设计师" });
	await delivered;
	expect((await harness.list()).details.workers[0]).toMatchObject({ role: "设计师", model: "test/worker-2" });
	expect(eventTitles(harness)).toEqual(["swap 已返回", "swap 已返回"]);
});

test("子会话不注册只属于交互主会话的功能：横幅、工具渲染、预设、重命名与用量命令", async () => {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({
			features: await featuresOnly("header", "tools", "stats"),
		}),
	}) as { registerFirecode(pi: unknown, subsession: boolean): void };
	const fake = fakePi();
	registerFirecode(fake.pi, true);
	expect([fake.commands, fake.tools, fake.shortcuts, fake.entryRenderers].map((table) => table.size)).toEqual([0, 0, 0, 0]);
});

test("指挥官开着 codemode 时 Worker 也用 codemode：三个 Worker 各在脚本里跑长命令，指挥官自己的脚本照样立即执行", async () => {
	const harness = await setup(true, { activeTools: ["read", "bash", "edit", "write", "codemode"] });
	const limitBefore = process.env.PI_CODEMODE_MAX_WORKERS;
	const started = join(harness.cwd, "started");
	await mkdir(started);
	const respond = (context: any) => {
		const last = context.messages.at(-1);
		if (last.role === "toolResult") return fauxAssistantMessage("完成");
		const code = JSON.stringify(last.content).includes("MASTER")
			? 'return "master ok";'
			: 'await tools.bash({ command: "touch ' + started + '/$$; sleep 6" });';
		return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 8 }, () => respond));
	for (const worker of ["w1", "w2", "w3"]) await harness.execute({ action: "start", worker, prompt: "跑长命令", role: "工程师" });
	// 三个脚本同时在跑，不是排队轮流：长命令只睡 6 秒，3 秒内到齐才算。
	await until(async () => (await readdir(started)).length === 3, 3_000);

	// 主会话：与 CLI 一样自带内置 codemode，不经池，名额只用宿主缺省的那份。
	const host = await import(PI_CODING_AGENT_URL) as any;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const loader = new host.DefaultResourceLoader({
		cwd: harness.cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "codemode", factory: host.createCodemodeExtension() }],
	});
	await loader.reload();
	const { session } = await host.createAgentSession({ cwd: harness.cwd, agentDir, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(), tools: ["codemode"] });
	const begin = performance.now();
	await session.prompt("MASTER 查看进度");
	const elapsed = performance.now() - begin;
	const result = session.messages.find((message: any) => message.role === "toolResult");
	session.dispose();
	await harness.pool.disposeWorkers();
	expect(JSON.stringify(result.content)).toContain("master ok");
	expect(elapsed).toBeLessThan(3_000);
	// 名额随子会话释放收回：环境变量还原成进程原值。
	expect(process.env.PI_CODEMODE_MAX_WORKERS).toBe(limitBefore);
}, 20_000);

test("Worker 会话只注册 checkout 守卫，不暴露 Master 工具面", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const cwd = join(directory, "checkout");
	await mkdir(cwd);
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({
			features: await featuresOnly("master"),
			review: TEST_REVIEW_CONFIG,
			master: { roles: TEST_ROLES },
		}),
	}) as { registerFirecode(pi: unknown, subsession: boolean): void };
	const register = (subsession: boolean) => {
		const fake = fakePi();
		registerFirecode(fake.pi, subsession);
		return fake;
	};

	const workerRegistration = register(true);
	const ctx = { cwd };
	expect(workerRegistration.commands.has("fire-master")).toBe(false);
	expect(workerRegistration.tools.has("subagents")).toBe(false);
	// 守卫之外的 tool_call 处理器（截断写入拦截）对这些输入不出声，fire 取到的就是守卫的裁决。
	const workerGuard = (event: unknown, context: unknown) => workerRegistration.fire("tool_call", event, context);
	const outside = join(homedir(), "firecode-guard-probe", "outside.ts");
	expect(await workerGuard({ toolName: "write", input: { path: outside } }, ctx)).toEqual({
		block: true,
		reason: `子代理只能修改当前 checkout 或系统临时目录：${outside}`,
	});
	expect(await workerGuard({ toolName: "edit", input: { path: "inside.ts" } }, ctx)).toBeUndefined();
	// 交付物（调研报告、评测产物）写到临时目录是正当用途，不该逼 Worker 改用 bash 绕过守卫。
	expect(await workerGuard({ toolName: "write", input: { path: join(tmpdir(), "fc-report", "notes.md") } }, ctx)).toBeUndefined();
	expect(await workerGuard({ toolName: "write", input: { path: "/tmp/fc-report/notes.md" } }, ctx)).toBeUndefined();

	const masterRegistration = register(false);
	expect(masterRegistration.commands.has("fire-master")).toBe(true);
	expect(masterRegistration.tools.has("subagents")).toBe(true);
});

test("恢复会话时早已中断的子代理不再提醒；被会话重载打断的提醒后被 ack 也不会再来", async () => {
	const harness = await setup(false, { timing: { interruptResumeMs: 300 } });
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	const base = { role: "工程师", model: "test/worker", thinking: "medium", cwd: harness.cwd, launch: 1 };
	await writeFile(path, JSON.stringify({ version: 10, workers: [
		{ ...base, name: "old", status: "idle", interruptedAt: Date.now() - 3_600_000, sessionPath: join(harness.cwd, "old.jsonl") },
		{ ...base, name: "reloaded", status: "working", launch: 2, sessionPath: join(harness.cwd, "reloaded.jsonl") },
	] }));
	await harness.command("");
	await harness.execute({ action: "ack", worker: "reloaded" });
	// 提醒计时从激活起算 300ms；ack 必须先于它，等待则要越过它。
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(harness.messages).toEqual([]);
	await harness.command("");
});

test("投递失败后按退避自动重试：只提示一次，最终送达且只送达一次", async () => {
	const harness = await setup(true, { failDeliveries: 2, timing: { eventRetryMs: 150 } });
	faux.setResponses([fauxAssistantMessage("完成")]);
	await harness.execute({ action: "start", worker: "retry", prompt: "只回复完成", role: "工程师", thinking: "low" });
	await until(() => harness.notices.some((notice) => notice.includes("投递失败")));
	const counts = () => harness.emitted.filter(([channel]) => channel === "firecode:workers").map(([, payload]) => payload.inFlight);
	expect(harness.messages).toHaveLength(0);
	expect(counts()).toEqual([1]);
	await until(() => counts().length === 2);
	await Bun.sleep(150);
	expect(harness.messages).toHaveLength(1);
	expect(harness.notices.filter((notice) => notice.includes("投递失败"))).toHaveLength(1);
	expect(harness.appended.filter(([type]) => type === "firecode-master-event-ack")).toHaveLength(1);
	expect(counts()).toEqual([1, 0]);
	await harness.command("");
});

test("有子代理在跑时关闭指挥官模式先确认：拒绝则保持原样，同意才中断；无界面直接关", async () => {
	const decline = await setup(true, { confirmAnswer: false });
	faux.setResponses([async () => { await Bun.sleep(5_000); return fauxAssistantMessage("不会等到"); }]);
	await decline.execute({ action: "start", worker: "busy", prompt: "慢", role: "工程师", thinking: "low" });
	await decline.command("");
	expect(decline.confirmations).toHaveLength(1);
	expect(decline.confirmations[0][1]).toContain("1 个子代理在跑");
	expect(decline.activeTools).toContain("subagents");
	expect((await decline.list().then((result) => result.details as any)).workers).toHaveLength(1);
	await decline.execute({ action: "kill", worker: "busy" });
	await decline.command("");
	expect(decline.confirmations).toHaveLength(1);
	expect(decline.activeTools).not.toContain("subagents");
	await faux.unregister();

	const headless = await setup(true);
	faux.setResponses([async () => { await Bun.sleep(5_000); return fauxAssistantMessage("不会等到"); }]);
	await headless.execute({ action: "start", worker: "busy", prompt: "慢", role: "工程师", thinking: "low" });
	await headless.command("");
	expect(headless.activeTools).not.toContain("subagents");
});

test("有子代理在跑时同意关闭：确认后才关，子代理被中断，档案保留，重新启用后变为空闲；它还没写过会话文件，send 在同一路径新开会话续派", async () => {
	const harness = await setup(true, { confirmAnswer: true });
	faux.setResponses([async (_context: any, options: any) => {
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中断");
	}]);
	await harness.execute({ action: "start", worker: "busy", prompt: "慢", role: "工程师", thinking: "low" });
	await harness.command("");
	expect(harness.confirmations).toHaveLength(1);
	expect(harness.notices.at(-1)).toBe("指挥官模式已关闭");
	expect(harness.activeTools).not.toContain("subagents");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");

	await harness.command("");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ name: "busy", status: "idle", interruptedAt: expect.any(Number) });
	// 第一条回复之前被中断：宿主还没写会话文件，没有上下文可恢复。
	expect(existsSync(worker.session)).toBe(false);
	expect((await harness.execute({ action: "tail", worker: "busy" })).content[0].text).toContain("近况");

	faux.setResponses([fauxAssistantMessage("续派完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "busy", prompt: "重新来" });
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("busy 已返回\n回复：\n续派完成");
	expect(existsSync(worker.session)).toBe(true);
	expect((await harness.list().then((result) => result.details as any)).workers[0]).toMatchObject({ session: worker.session, status: "idle" });
	await harness.command("");
});

test("子代理在第一条回复前随会话关闭被打断（还没有会话文件）：review 在同一路径新开会话完成审查", async () => {
	const harness = await setup(true, { review: true, mockReview: true, confirmAnswer: true });
	faux.setResponses([async (_context: any, options: any) => {
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中断");
	}]);
	const started = await harness.execute({ action: "start", worker: "early", prompt: "开始", role: "工程师", review: true });
	await harness.command("");
	await harness.command("");
	expect(existsSync((started.details as any).worker.session)).toBe(false);

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "early" });
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("early 审查通过（1 轮）");
});

test("修复回合自动重试后继续下一轮审查", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } }));
	const fail = "核对了 a.ts。\n证据：文件=a.ts；命令=bun test\n## 发现 1\n- 发生条件: 每次\n- 频率: 10\n- 影响: 5\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test";
	const pass = "PASS\n核对完毕。\n证据：文件=a.ts；命令=bun test";
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		fauxAssistantMessage(fail),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		fauxAssistantMessage("修复完成"),
		fauxAssistantMessage(pass),
		fauxAssistantMessage("审查通过，修复完成"),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "retry-review", prompt: "实现", role: "工程师", review: true });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "retry-review" });
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("retry-review 审查通过（2 轮）");
	await harness.command("");
}, 20_000);

test("审查的修复回合撞上 429 限流：审查暂停，到时自动重新发起审查，通过后审查义务消除，指挥官只收到一次审查终态", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		fauxAssistantMessage(REVIEW_FAIL),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429: {"type":"rate_limit_error","resets_in_seconds": 0.3}` }),
		fauxAssistantMessage(REVIEW_PASS),
		fauxAssistantMessage("审查通过"),
	]);
	await harness.execute({ action: "start", worker: "fix-limit", prompt: "实现", role: "工程师", review: true });
	await until(() => eventTitles(harness).includes("fix-limit 已返回"));
	await harness.execute({ action: "review", worker: "fix-limit" });
	await until(() => eventTitles(harness).some((title) => title.startsWith("fix-limit 审查通过")), 15_000);
	expect(eventTitles(harness)).toEqual(["fix-limit 已返回", "fix-limit 审查已暂停", "fix-limit 审查通过（1 轮）"]);
	expect((await harness.list().then((result) => result.details as any)).workers[0].reviewNeeded).toBeUndefined();
	await harness.execute({ action: "ack", worker: "fix-limit" });
	await harness.command("");
}, 20_000);

test("start 指定了思考档的运行暂停后、会话已释放再自动续跑：冷启动续跑沿用同一思考档，档案的实际档也是它", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 15 }, roles: { 工程师: { model: "test/thinker/medium", use: "实现" } } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const levels: string[] = [];
	faux.setResponses([
		(_context: any, options: any) => { levels.push(String(options.reasoning)); return fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 rate limit {"resets_in_seconds": 0.15}` }); },
		(_context: any, options: any) => { levels.push(String(options.reasoning)); return fauxAssistantMessage("续跑完成"); },
	]);
	const started = await harness.execute({ action: "start", worker: "deep", prompt: "执行", role: "工程师", thinking: "high" });
	await until(async () => (await harness.list()).details.workers[0]?.resume);
	// 暂停期间热会话按空闲时限释放，续跑只能冷启动。
	await until(() => !harness.pool.getSession((started.details as any).worker.session));
	await until(() => harness.messages.some((entry: any) => String(entry.message.content).includes("续跑完成")));
	expect(levels).toEqual(["high", "high"]);
	expect((await harness.list()).details.workers[0]).toMatchObject({ thinking: "high" });
});

test("审查者撞上 429 限流整轮缺席：审查暂停后自动续审并通过", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 Too Many Requests {"resets_in_seconds": 0.3}` }),
		fauxAssistantMessage(REVIEW_PASS),
		fauxAssistantMessage("审查通过"),
	]);
	await harness.execute({ action: "start", worker: "seat-limit", prompt: "实现", role: "工程师", review: true });
	await until(() => eventTitles(harness).includes("seat-limit 已返回"));
	await harness.execute({ action: "review", worker: "seat-limit" });
	await until(() => eventTitles(harness).some((title) => title.startsWith("seat-limit 审查通过")), 15_000);
	expect(eventTitles(harness)).toEqual(["seat-limit 已返回", "seat-limit 审查已暂停", "seat-limit 审查通过（1 轮）"]);
	expect((await harness.list().then((result) => result.details as any)).workers[0].reviewNeeded).toBeUndefined();
	await harness.command("");
}, 20_000);

const REVIEW_FAIL = "核对了 a.ts。\n证据：文件=a.ts；命令=bun test\n## 发现 1\n- 发生条件: 每次\n- 频率: 10\n- 影响: 5\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test";
const REVIEW_PASS = "PASS\n核对完毕。\n证据：文件=a.ts；命令=bun test";

test("修复回合最终错误向 Master 报告原文并保留审查轮", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const fail = "核对了 a.ts。\n证据：文件=a.ts；命令=bun test\n## 发现 1\n- 发生条件: 每次\n- 频率: 10\n- 影响: 5\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test";
	const error = "供应商认证失败 401";
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		fauxAssistantMessage(fail),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "failed-review", prompt: "实现", role: "工程师", review: true });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "failed-review" });
	await delivered;
	const content = harness.messages.at(-1).message.content;
	expect(titleOf(content)).toBe("failed-review 审查未完成");
	expect(content).toContain(error);
	const session = harness.pool.getSession((started.details as any).worker.session);
	const { readCheckpoint } = await loadFirecodeModule("review/checkpoint.js") as any;
	const { readReviewOutcome } = await loadFirecodeModule("review/outcome.js") as any;
	expect(readReviewOutcome((started.details as any).worker.session)).toMatchObject({ status: "failed", rounds: 1, reason: expect.stringContaining(error) });
	expect(readCheckpoint(session)).toMatchObject({ phase: "settled", end: "error", error: expect.stringContaining(error), history: [{ result: "failed" }] });
	await harness.command("");
}, 20_000);

test("审查中的子代理被 interrupt：审查以取消收场（终态 checkpoint 已写），子代理回到 idle 带中断标记，审查义务仍在，可再 review", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	const { readReviewOutcome } = await loadFirecodeModule("review/outcome.js") as any;
	let reviewerStarted!: () => void;
	let started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	const hangingReviewer = async (_context: any, options: any) => {
		reviewerStarted();
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中止");
	};
	faux.setResponses([fauxAssistantMessage("实现完成"), hangingReviewer, hangingReviewer]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const startedWorker = await harness.execute({ action: "start", worker: "judged", prompt: "实现", role: "工程师", review: true });
	await delivered;
	const sessionPath = (startedWorker.details as any).worker.session;
	const state = async () => (await harness.list().then((result) => result.details as any)).workers[0];

	await harness.execute({ action: "review", worker: "judged" });
	await started;
	expect(await state()).toMatchObject({ status: "reviewing" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "judged" });
	await delivered;
	const content = harness.messages.at(-1).message.content as string;
	expect(titleOf(content)).toBe("judged 审查被中断");
	expect(content).toContain("审查义务均已保留");
	// 不是失败：没有错误分节，活动列表是被中断的黄行。
	expect(content).not.toContain("错误：");
	expect(await state()).toMatchObject({ status: "idle", reviewNeeded: true, interruptedAt: expect.any(Number) });
	expect(harness.activity()[0]).toMatch(/^ {2}‖ judged /u);
	// 审查以取消收场，终态 checkpoint 已写在子代理会话里。
	expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "cancelled" });
	// 义务仍在：未履行不能 ack，但可以再 review，新一场审查是新的 run。
	await expect(harness.execute({ action: "ack", worker: "judged" })).rejects.toThrow("审查义务");
	started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	const cancelledRun = readReviewOutcome(sessionPath).runId;
	await harness.execute({ action: "review", worker: "judged" });
	await started;
	expect(await state()).toMatchObject({ status: "reviewing" });
	expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "in_progress" });
	expect(readReviewOutcome(sessionPath).runId).not.toBe(cancelledRun);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "judged" });
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("judged 审查被中断");
	await harness.command("");
});

test("Master 关闭只释放落盘的子代理：同池里进行中的审查会话（内存会话）不受影响，照常出结果", async () => {
	const harness = await setup(true);
	const { runReviewSession } = await loadFirecodeModule("review/session.js") as any;
	let reviewerStarted!: () => void;
	const started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	let finishReview!: () => void;
	const gate = new Promise<void>((resolve) => { finishReview = resolve; });
	faux.setResponses([
		async (_context: any, options: any) => {
			await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("已中断");
		},
		async () => {
			reviewerStarted();
			await gate;
			return fauxAssistantMessage("审查者结论");
		},
	]);
	const startedWorker = await harness.execute({ action: "start", worker: "alongside", prompt: "慢", role: "工程师" });
	const workerPath = (startedWorker.details as any).worker.session;
	const review = runReviewSession(harness.pool, {
		config: { models: [{ model: "test/reviewer", thinking: "low" }], tools: [], timeoutMs: 30_000 },
		prompt: { system: "审查者", user: "审" },
		cwd: harness.cwd,
	});
	await started;

	await harness.command("");
	expect(harness.pool.getSession(workerPath)).toBeUndefined();
	finishReview();
	expect(await review).toMatchObject({ kind: "output", text: "审查者结论" });
});

test("tail：错误在前，只取最后一条外部输入之后，工具调用只留名字与简短参数；热会话与已释放的冷会话读到同一份", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 30 } });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md", offset: 1 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("第一段完成"),
		async () => { throw new Error("quota exhausted"); },
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "trace", prompt: "旧输入", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "trace", prompt: "新输入" });
	await delivered;
	const hot = (await harness.execute({ action: "tail", worker: "trace" })).content[0].text as string;
	expect(hot.split("\n")[1]).toContain("quota exhausted");
	expect(hot.split("\n")[2]).toBe("user: 新输入");
	expect(hot).not.toContain("旧输入");
	expect(hot).not.toContain("tool: read");

	const first = (await harness.execute({ action: "tail", worker: "trace" })).content[0].text as string;
	await until(() => harness.pool.getSession((started.details as any).worker.session) === undefined);
	expect((await harness.execute({ action: "tail", worker: "trace" })).content[0].text).toBe(first);
});

test("tail 的工具调用行：名字加截短的参数", async () => {
	const harness = await setup();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md", note: "x".repeat(200) }), { stopReason: "toolUse" }),
		fauxAssistantMessage("完成"),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "calls", prompt: "读", role: "工程师" });
	await delivered;
	const text = (await harness.execute({ action: "tail", worker: "calls" })).content[0].text as string;
	const call = text.split("\n").find((line) => line.startsWith("tool: read"))!;
	expect(call).toContain("path=AGENTS.md");
	expect(call.length).toBeLessThan(140);
});

test("子代理会话里的扩展出错：同一处错误只告知指挥官一次，不影响子代理照常完成", async () => {
	const harness = await setup(true, { throwingExtension: true });
	faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "flaky", prompt: "执行", role: "工程师" });
	await delivered;
	const returned = () => harness.messages.filter((entry: any) => entry.message.content.split("\n").includes("flaky 已返回")).length;
	await until(() => returned() === 1);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "flaky", prompt: "再来" });
	await delivered;
	await until(() => returned() === 2);
	const titles = harness.messages.map((entry: any) => entry.message.content.split("\n").filter((line: string) => line.startsWith("flaky ")));
	expect(titles.flat().filter((title: string) => title === "flaky 扩展出错")).toHaveLength(1);
	expect(harness.messages.map((entry: any) => entry.message.content).join("\n")).toContain("扩展炸了");
	expect(titles.flat().filter((title: string) => title === "flaky 已返回")).toHaveLength(2);
});

test("看过一眼（getSession）不改变空闲释放：空闲会话照常到期释放，释放后池档案与会话文件仍在", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 40 } });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "viewed", prompt: "执行", role: "工程师" });
	await settled;
	const sessionPath = (started.details as any).worker.session;
	expect(harness.pool.getSession(sessionPath)).toBeDefined();
	await until(() => harness.pool.getSession(sessionPath) === undefined);
	expect(existsSync(sessionPath)).toBe(true);
});

test("乙角色跑完后 send 换到解析不出模型的甲角色：档案没有模型，list 与 status 不再显示乙的模型", async () => {
	const harness = await setup(true, { roles: { 乙: { model: "test/worker-2/high", use: "先跑" }, 甲: { model: "nokey/model/low", use: "没有认证" } } });
	faux.setResponses([fauxAssistantMessage("乙完成")]);
	await harness.execute({ action: "start", worker: "swap", prompt: "执行", role: "乙" });
	await until(() => eventTitles(harness).includes("swap 已返回"));
	expect((await harness.list()).details.workers[0]).toMatchObject({ role: "乙", model: "test/worker-2" });
	expect((await harness.execute({ action: "send", worker: "swap", prompt: "换甲", role: "甲" })).details).toEqual({ sent: true });
	await until(() => eventTitles(harness).includes("swap 失败"));
	const worker = (await harness.list()).details.workers[0];
	expect(worker).toMatchObject({ status: "idle", role: "甲" });
	expect(worker.model).toBeUndefined();
	expect(worker.thinking).toBeUndefined();
	await harness.command("status");
	expect(harness.notices.at(-1)).toContain("swap");
	expect(harness.notices.at(-1)).not.toContain("worker-2");
});

test("send 换到解析不出模型的角色：立即返回，作为失败事件告知，失败后热会话仍按时释放", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 60 }, roles: { ...TEST_ROLES, 无密钥: { model: "nokey/model/low", use: "没有认证" } } });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "prep", prompt: "执行", role: "工程师" });
	await settled;
	const sessionPath = (started.details as any).worker.session;
	// 换到没有认证的 provider：热会话已被 hold 住，第一次请求路由才发现解析不出模型。
	expect((await harness.execute({ action: "send", worker: "prep", prompt: "换角色", role: "无密钥" })).details).toEqual({ sent: true });
	await until(() => eventTitles(harness).includes("prep 失败"));
	expect(harness.messages.at(-1).message.content).toContain("nokey/model");
	expect((await harness.list().then((result) => result.details as any)).workers[0]).toMatchObject({ status: "idle", role: "无密钥" });
	await until(() => harness.pool.getSession(sessionPath) === undefined);
});

test.each([[false, false], [true, true]])("子代理按目标 cwd 的项目信任起：信任存储里 trusted=%p 时，项目自带扩展加载=%p", async (trusted, loaded) => {
	const harness = await setup();
	const marker = join(harness.cwd, "project-extension-loaded");
	await mkdir(join(harness.cwd, ".pi", "extensions"), { recursive: true });
	await writeFile(join(harness.cwd, ".pi", "extensions", "marker.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function() { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`);
	await writeFile(join(harness.agentDir, "trust.json"), JSON.stringify({ [await realpath(harness.cwd)]: trusted }));
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "trust", prompt: "执行", role: "工程师" });
	await delivered;
	expect(existsSync(marker)).toBe(loaded);
});

async function setup(activate = true, options: {
	/** 缩短池的等待时限（pool.timing 是全插件唯一的时间注入点）。 */
	timing?: Partial<Timing>;
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
	/** 子会话加载扩展时卡在 globalThis.__loadGate 上：复现 start 准备期间被 kill 的现场。 */
	loadGate?: boolean;
	/** 后台模型链（background.model），进展行用它；省略即关闭。 */
	progress?: string[];
	/** 有界面：/fire-master 关闭时会弹确认，返回值由 confirmAnswer 决定。 */
	confirmAnswer?: boolean;
	/** 在子会话里装一个事件处理器抛错的扩展：复现子代理扩展出错。 */
	throwingExtension?: boolean;
	/** 唤起的回合不自动开始：宿主已置忙，agent_start 由测试 wake() 发出，回合何时结束也由测试决定。 */
	holdWake?: boolean;
	/** 前 n 次 sendMessage 抛错：复现事件投递失败、等待重试的现场。 */
	failDeliveries?: number;
	/** 前 n 个被唤起的指挥官回合以这条供应商错误收场（宿主自动重试已用完）：复现指挥官自己的回合断网。 */
	failTurns?: { count: number; error: string };
	/** 子会话加载 FireCode 的轮记录器（与真实安装一致）；false 复现 Worker 排除了 FireCode 扩展。 */
	workerRecorder?: boolean;
	roles?: Record<string, { model: string | string[]; use: string; fallback?: string[] }>;
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
			`export { registerRoundRecorder as default } from ${JSON.stringify(await firecodeModulePath("round.ts"))};`);
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
			`import { registerReview } from ${JSON.stringify(await firecodeModulePath("review/index.ts", { configJsonc }))};\nexport default function(pi) { registerReview(pi, globalThis.__pool); }`);
	}
	if (options.throwingExtension)
		await writeFile(join(extensions, "throwing.ts"), `export default function(pi) {
			pi.on("agent_start", () => { throw new Error("扩展炸了"); });
		}`);
	if (options.shutdownProbe)
		await writeFile(join(extensions, "shutdown-probe.ts"), shutdownProbeExtension(join(directory, "shutdown.log")));
	if (options.loadGate)
		await writeFile(join(extensions, "load-gate.ts"), "export default async function() { await globalThis.__loadGate; }");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = await installFaux(agentDir, ["test/worker", "test/worker-2", "test/thinker", "test/reviewer", "test/advisor", "test/summary", "nokey/model"], ["nokey"], {}, ["test/thinker"]);
	const { SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("spawn.js");
	// 测试默认立即唤醒指挥官、让事件重试远在测试之外；用例按需缩短别的等待。
	const pool = new (spawnModule as any).InProcessSessionPool({ timing: { wakeQuietMs: 0, eventRetryMs: 3_600_000, ...options.timing } });
	const moduleOptions = {
		configJsonc: JSON.stringify({
			features: { master: true, review: options.review === true },
			review: TEST_REVIEW_CONFIG,
			master: {
				roles: options.roles ?? TEST_ROLES,
				workerExcludeExtensions: [],
				...(options.autoActivate === undefined ? {} : { autoActivate: options.autoActivate }),
			},
			...(options.progress ? { background: { model: options.progress, idleCompaction: false } } : {}),
		}),
	};
	const module = await loadFirecodeModule("master/index.js", moduleOptions) as any;
	// 全过程视图补话直接调 send(active, …, "view")；运行时对象只在注册闭包里，这里在 render 上截一份引用（只在测试副本里，幂等）。
	const [{ MasterRuntime }, { commands: actionCommands }] = await Promise.all([
		loadFirecodeModule("master/runtime.js", moduleOptions),
		loadFirecodeModule("master/actions.js", moduleOptions),
	]) as any[];
	if (!MasterRuntime.prototype.capturesActive) {
		const render = MasterRuntime.prototype.render;
		MasterRuntime.prototype.render = function (this: unknown) { (globalThis as any).__masterActive = this; return render.call(this); };
		MasterRuntime.prototype.capturesActive = true;
	}
	(globalThis as any).__pool = pool;
	const fake = fakePi();
	const { commands, tools, sent: messages, appended, emitted } = fake;
	/** 指挥官被唤醒开的回合：各记它的起始消息正文。 */
	const turns: string[] = [];
	const notices: string[] = [];
	const confirmations: [string, string][] = [];
	const entries: any[] = [];
	let failures = options.failDeliveries ?? 0;
	let onMessage: (() => void) | undefined;
	let idle = false;
	const turnRequested = Promise.withResolvers<void>();
	let starting: any;
	let activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
	const pi = Object.assign(fake.pi, {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		appendEntry: (type: string, data: any) => {
			appended.push([type, data]);
			entries.push({ type: "custom", customType: type, data });
		},
		// 与宿主 sendCustomMessage 一致：忙时 triggerTurn 等同 steer；歇透时同步置忙、立即返回，回合稍后才 agent_start。
		sendMessage: (message: any, sendOptions: any) => {
			if (failures > 0) { failures--; throw new Error("投递失败"); }
			messages.push({ message, options: sendOptions });
			entries.push({ type: "custom_message", customType: message.customType, content: message.content });
			if (sendOptions?.triggerTurn === true && !idle) steered.push(message);
			if (sendOptions?.triggerTurn === true && idle) {
				idle = false;
				starting = message;
				turnRequested.resolve();
				if (!options.holdWake) setTimeout(() => void wake().then(finishTurn), 0);
			}
			onMessage?.();
		},
	});
	/**
	 * 指挥官回合在跑（idle 为 false）时宿主不断经过句缝：发 turn_end，处理器返回后取走 steer 队列，逐条发 message_start。
	 * 回合在跑时 ctx.signal 有值（宿主 agent 循环的中止信号）。
	 */
	const steered: any[] = [];
	const run = new AbortController();
	let breaking = false;
	const sentenceBreaks = setInterval(async () => {
		if (idle || breaking) return;
		breaking = true;
		try {
			await fake.fire("turn_end", {}, ctx);
			for (const { customType, content, display, details } of steered.splice(0))
				await fake.fire("message_start", { message: { role: "custom", customType, content, display, details } }, ctx);
		} finally {
			breaking = false;
		}
	}, 5);
	stopSentenceBreaks = () => clearInterval(sentenceBreaks);
	/** 唤起的回合真正开始：agent_start 在前，随后宿主记录这条自定义消息本身。 */
	const wake = async () => {
		const { customType, content, display, details } = starting;
		turns.push(content);
		await fake.fire("agent_start", {}, ctx);
		await fake.fire("message_start", { message: { role: "custom", customType, content, display, details } }, ctx);
	};
	let failedTurns = options.failTurns?.count ?? 0;
	const finishTurn = async () => {
		const failure = failedTurns > 0 ? (failedTurns--, options.failTurns!.error) : undefined;
		const reply = failure ? { role: "assistant", stopReason: "error", errorMessage: failure } : { role: "assistant", stopReason: "stop" };
		entries.push({ type: "message", message: reply });
		idle = true;
		await fake.fire("agent_end", { messages: [reply] }, ctx);
		await fake.fire("agent_settled", {}, ctx);
	};
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
		get signal() { return idle ? undefined : run.signal; },
		hasPendingMessages: () => false,
		hasUI: options.confirmAnswer !== undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async (title: string, message: string) => { confirmations.push([title, message]); return options.confirmAnswer === true; },
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
	// 与入口一致：会话进行中的状态机先于 Master 安装（入口最先注册轮记录器），Master 才拉得到起点。
	(await loadFirecodeModule("busy.ts") as any).busyView(pi);
	module.registerMaster(pi, pool);
	const command = (args: string) => commands.get("fire-master").handler(args, ctx);
	if (activate) await command("");
	return {
		cwd,
		get sessionId() { return sessionId; },
		get activeTools() { return [...activeTools]; },
		notices,
		confirmations,
		statuses,
		messages,
		turns,
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
		/** 歇透时的投递已让宿主置忙、回合尚未 agent_start。 */
		turnRequested: turnRequested.promise,
		wake,
		pi,
		ctx,
		command,
		emit: (name: string, event: any) => fake.fire(name, event, ctx),
		replaceSession: async () => {
			sessionId = crypto.randomUUID();
			entries.length = 0;
			await fake.fire("session_start", {}, ctx);
		},
		agentDir,
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
		viewSend: (worker: string, prompt: string) => actionCommands.send((globalThis as any).__masterActive, worker, { prompt }, "view"),
		viewInterrupt: (worker: string) => actionCommands.interrupt((globalThis as any).__masterActive, worker),
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
		version: 9, runId: "mock-review-run", round: 1, focus: "", consecutiveFailures: 0, startedAt: 1, roundStartedAt: 1,
	};
	const reviewing = {
		...base, phase: "reviewing", rounds: 0, last: null, updatedAt: 1,
		slots: [{ result: null }],
	};
	const settled = {
		...base, phase: "settled", end: timeout ? "error" : "passed", updatedAt: 2, rounds: 1,
		last: timeout
			? { round: 1, result: "error", error: TIMEOUT_DETAILS, elapsedMs: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "error", summary: "", details: "" }] }
			: { round: 1, result: "passed", elapsedMs: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "passed", summary: "", details: "" }] },
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

/**
 * 审查的修复回合在子代理里落定时，在 agent_settled 处理器里写终态 checkpoint 并放掉占用，之后处理器还要再跑 sleepMs：
 * 复现指挥官看到审查落定、子代理会话已报空闲，宿主却还在跑 agent_settled 处理器的窗口。
 */
function slowSettleReviewExtension(sleepMs: number): string {
	const base = { version: 9, runId: "slow-run", round: 1, focus: "", consecutiveFailures: 0, startedAt: 1, roundStartedAt: 1 };
	const reviewing = { ...base, phase: "reviewing", rounds: 0, last: null, updatedAt: 1, slots: [{ result: null }] };
	const settled = {
		...base, phase: "settled", end: "passed", updatedAt: 2, rounds: 1,
		last: { round: 1, result: "passed", elapsedMs: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "passed", summary: "", details: "" }] },
	};
	return `export default function(pi) {
		let armed = false;
		pi.registerCommand("fire-review", { description: "slow settle review", handler: () => {
			armed = true;
			pi.events.emit("firecode:review", { active: true, progress: () => undefined });
			pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(reviewing)});
			pi.sendMessage({ customType: "mock-fix", content: "修复", display: false }, { triggerTurn: true });
		}});
		pi.on("agent_settled", async () => {
			if (!armed) return;
			armed = false;
			pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(settled)});
			pi.events.emit("firecode:review", { active: false });
			await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));
		});
	}`;
}

/** start/send 写档就返回，会话与回合在后台开：要碰在跑回合（中止、看会话事件）的用例先等它真正在飞。 */
async function turnRunning(harness: any, name: string): Promise<any> {
	let session: any;
	await until(async () => {
		const worker = (await harness.list()).details.workers.find((candidate: any) => candidate.name === name);
		session = worker && harness.pool.getSession(worker.session);
		return session?.isStreaming;
	});
	return session;
}

function userText(context: any): string {
	return context.messages.filter((message: any) => message.role === "user")
		.map((message: any) => typeof message.content === "string" ? message.content : message.content?.map((part: any) => part.text).join(""))
		.join("\n");
}
