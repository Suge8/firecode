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

test("新会话默认激活 subagents；autoActivate false 时不注入，仍可手动启动", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	expect(harness.activeTools).toEqual(["read", "bash", "edit", "write", "subagents", "subagents_list"]);
	const off = await setup(false, { autoActivate: false });
	await off.emit("session_start", {});
	expect(off.activeTools).toEqual(["read", "bash", "edit", "write"]);
	await expect(off.list()).rejects.toThrow("只在 Master 中可用");
	await off.command("");
	expect(off.activeTools).toContain("subagents");
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

test("裸 /fire-master 来回翻转当前会话", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	await harness.command("");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
	await harness.command("");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("指挥官提示词作为系统提示段注入，附上已配置的角色表；停用后撤下", async () => {
	const harness = await setup();
	const prompt = await harness.systemPrompt("自定义系统提示");
	expect(prompt).toStartWith("自定义系统提示");
	expect(prompt).toContain("工程师（测试）");
	expect(prompt).toContain("设计师（切换测试）");
	await harness.command("");
	expect(await harness.systemPrompt("自定义系统提示")).toBe("自定义系统提示");
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

	await harness.command("");
	faux.setResponses([async (_context: any, options: any) => {
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage("已中断");
	}]);
	await harness.execute({ action: "start", worker: "slow", prompt: "慢", role: "工程师", thinking: "low" });
	expect(counts()).toEqual([1, 0, 1, 0, 1]);
	await harness.command("");
	expect(counts()).toEqual([1, 0, 1, 0, 1, 0]);
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

test("subagents 完成 start→结果送达→list→tail→kill；会话文件不进用户的会话列表", async () => {
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
	expect(worker).toMatchObject({ status: "working", role: "工程师" });
	await settled;
	await until(async () => (await harness.list()).details.workers[0]?.status === "idle");

	expect((await harness.list()).details.workers[0]).toMatchObject({ status: "idle", model: "test/worker" });
	expect(harness.messages[0]).toMatchObject({
		message: { customType: "firecode-master-event", content: expect.stringContaining("确定性完成") },
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
	expect(switched).toContain("test/worker-2");
	expect(switched).toContain("insufficient_quota");
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

test("角色解析不出模型（没有凭据）：派发以失败事件告知指挥官", async () => {
	const harness = await setup(false, { confirmAnswer: true, roles: { 工程师: TEST_ROLES.工程师, 不可用: { model: "nokey/model/medium", use: "其他工作" } } });
	await harness.emit("session_start", {});
	faux.setResponses([fauxAssistantMessage("完成")]);
	expect((await harness.execute({ action: "start", worker: "missing", prompt: "执行", role: "不可用" })).details).toMatchObject({ started: true });
	await until(() => eventTitles(harness).includes("missing 失败"));
	expect(harness.messages.at(-1).message.content).toContain("nokey/model");
	expect(faux.getPendingResponseCount()).toBe(1);
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
	await harness.emit("session_start", {});
	await harness.emit("session_start", {});
	await until(() => eventTitles(harness).includes("reload 已返回"));
	await Bun.sleep(300);
	expect(eventTitles(harness)).toEqual(["reload 已暂停", "reload 已返回"]);
	expect(calls).toBe(2);
	await harness.command("");
}, 20_000);

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
	expect(harness.turns[0]).toContain("event 已返回");
	for (const turn of harness.turns.slice(1)) expect(turn).toContain("Connection error.");
	await harness.command("");
});

for (const [name, stop, error, expected] of [
	["truncated", "length", undefined, "截断"],
	["aborted", "aborted", "upstream connection closed", "upstream connection closed"],
] as const) {
	test(`${stop} 终态（即使已有正文）按失败投递，不能报告正常返回`, async () => {
		const harness = await setup();
		faux.setResponses([fauxAssistantMessage("看似完整的结果", { stopReason: stop, ...(error ? { errorMessage: error } : {}) })]);
		const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
		await harness.execute({ action: "start", worker: name, prompt: "执行", role: "工程师" });
		await delivered;
		const content = harness.messages[0].message.content;
		expect(content).toContain("错误：");
		expect(content).toContain(expected);
		expect(content).not.toContain("已返回");
	});
}

/** 子会话每建一次（session_start）就在 log 里记一行它的会话路径；shutdownGate 为真时 session_shutdown 卡在 globalThis.__shutdownGate 上。 */
async function sessionProbe(agentDir: string, log: string, shutdownGate = false): Promise<() => Promise<string[]>> {
	await writeFile(join(agentDir, "extensions", "session-probe.ts"), `import { appendFileSync } from "node:fs";
	export default function(pi) {
		pi.on("session_start", (_event, ctx) => appendFileSync(${JSON.stringify(log)}, (ctx.sessionManager.getSessionFile() ?? "") + "\\n"));
		${shutdownGate ? `pi.on("session_shutdown", async () => { globalThis.__shutdownGate?.entered(); await globalThis.__shutdownGate?.open; });` : ""}
	}`);
	return async () => existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : [];
}


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

test("视图里直接派的运行落定后：事件注明视图来源并带原话，只告知不唤醒指挥官", async () => {
	const harness = await setup();
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("按你说的改好了")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "viewed", prompt: "初始化", role: "工程师" });
	await delivered;
	await Bun.sleep(20);
	const wakes = harness.turns.length;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.viewSend("viewed", "把标题改短");
	await delivered;
	const { message, options } = harness.messages.at(-1);
	expect(message.content).toContain("你在子代理视图里直接派的");
	expect(message.content).toContain("你说：把标题改短");
	expect(message.content).toContain("按你说的改好了");
	expect(options).toEqual({ triggerTurn: false });
	await Bun.sleep(20);
	expect(harness.turns).toHaveLength(wakes);
});

test("会话重载时在跑的子代理：恢复后指挥官收到一次提醒，ack 后不再来", async () => {
	const harness = await setup(false, { timing: { interruptResumeMs: 10 } });
	const { masterStatePath } = await loadFirecodeModule("master/state.js") as any;
	const path = masterStatePath(harness.agentDir, harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 10, workers: [{
		name: "reloaded", role: "工程师", model: "test/worker", thinking: "medium", status: "working", sessionPath: join(harness.cwd, "w.jsonl"), cwd: harness.cwd, launch: 1,
	}] }));
	await harness.command("");
	await until(() => harness.messages.length > 0);
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("reloaded");
	await harness.execute({ action: "ack", worker: "reloaded" });
	await Bun.sleep(50);
	expect(harness.messages).toHaveLength(1);
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

test("send 对冷 Worker 透明复活、省略角色沿用、显式角色原地切换", async () => {
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
	// 换角色是指挥官自己的决定，不是故障切换：不发“已切换模型”。
	expect(eventTitles(harness).filter((title: string) => title.includes("已切换模型"))).toEqual([]);
});

test("Worker 会话只注册 checkout 守卫：不暴露 Master 工具面，也没有横幅、工具渲染、用量命令等交互主会话功能", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const cwd = join(directory, "checkout");
	await mkdir(cwd);
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({
			features: await featuresOnly("master", "header", "tools", "stats"),
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
	expect([workerRegistration.commands, workerRegistration.tools, workerRegistration.shortcuts, workerRegistration.entryRenderers].map((table) => table.size)).toEqual([0, 0, 0, 0]);
	// 守卫之外的 tool_call 处理器（截断写入拦截）对这些输入不出声，fire 取到的就是守卫的裁决。
	const workerGuard = (event: unknown, context: unknown) => workerRegistration.fire("tool_call", event, context);
	const outside = join(homedir(), "firecode-guard-probe", "outside.ts");
	expect(await workerGuard({ toolName: "write", input: { path: outside } }, ctx)).toMatchObject({ block: true });
	expect(await workerGuard({ toolName: "edit", input: { path: "inside.ts" } }, ctx)).toBeUndefined();
	// 交付物（调研报告、评测产物）写到临时目录是正当用途，不该逼 Worker 改用 bash 绕过守卫。
	expect(await workerGuard({ toolName: "write", input: { path: join(tmpdir(), "fc-report", "notes.md") } }, ctx)).toBeUndefined();
	expect(await workerGuard({ toolName: "write", input: { path: "/tmp/fc-report/notes.md" } }, ctx)).toBeUndefined();
});

test("有子代理在跑时关闭指挥官模式先确认：拒绝则保持原样，同意才中断；无界面直接关", async () => {
	const decline = await setup(true, { confirmAnswer: false });
	faux.setResponses([async () => { await Bun.sleep(5_000); return fauxAssistantMessage("不会等到"); }]);
	await decline.execute({ action: "start", worker: "busy", prompt: "慢", role: "工程师", thinking: "low" });
	await decline.command("");
	expect(decline.confirmations).toHaveLength(1);
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

const REVIEW_FAIL = "核对了 a.ts。\n证据：文件=a.ts；命令=bun test\n## 发现 1\n- 发生条件: 每次\n- 频率: 10\n- 影响: 5\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test";
const REVIEW_PASS = "PASS\n核对完毕。\n证据：文件=a.ts；命令=bun test";

test.each([
	["审查的修复回合", [REVIEW_FAIL]],
	["审查者整轮", []],
])("%s撞上 429 限流：审查暂停，到时自动重新发起审查并通过，审查义务消除，指挥官只收到一次审查终态", async (_where, beforeLimit) => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		...beforeLimit.map((text) => fauxAssistantMessage(text)),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 Too Many Requests {"resets_in_seconds": 0.05}` }),
		fauxAssistantMessage(REVIEW_PASS),
		fauxAssistantMessage("审查通过"),
	]);
	await harness.execute({ action: "start", worker: "limit", prompt: "实现", role: "工程师", review: true });
	await until(() => eventTitles(harness).includes("limit 已返回"));
	await harness.execute({ action: "review", worker: "limit" });
	await until(() => eventTitles(harness).some((title) => title.startsWith("limit 审查通过")), 15_000);
	expect(eventTitles(harness)).toEqual(["limit 已返回", "limit 审查已暂停", "limit 审查通过（1 轮）"]);
	expect((await harness.list().then((result) => result.details as any)).workers[0].reviewNeeded).toBeUndefined();
	await harness.execute({ action: "ack", worker: "limit" });
	await harness.command("");
}, 20_000);

test("修复回合最终错误向 Master 报告原文并保留审查轮", async () => {
	const harness = await setup(true, { review: true, workerReview: { review: TEST_REVIEW_CONFIG } });
	await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	const error = "供应商认证失败 401";
	faux.setResponses([
		fauxAssistantMessage("实现完成"),
		fauxAssistantMessage(REVIEW_FAIL),
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
	const { readReviewOutcome } = await loadFirecodeModule("review/outcome.js") as any;
	expect(readReviewOutcome((started.details as any).worker.session)).toMatchObject({ status: "failed", rounds: 1, reason: expect.stringContaining(error) });
	await harness.command("");
}, 20_000);

test("审查中的子代理被 interrupt：审查以取消收场，子代理回到 idle 带中断标记，审查义务仍在，可再 review", async () => {
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
	// 审查以取消收场，终态 checkpoint 已写在子代理会话里。
	expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "cancelled" });
	// 义务仍在：未履行不能 ack，但可以再 review，新一场审查是新的 run。
	await expect(harness.execute({ action: "ack", worker: "judged" })).rejects.toThrow("审查义务");
	started = new Promise<void>((resolve) => { reviewerStarted = resolve; });
	await harness.execute({ action: "review", worker: "judged" });
	await started;
	expect(await state()).toMatchObject({ status: "reviewing" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "judged" });
	await delivered;
	expect(titleOf(harness.messages.at(-1).message.content)).toBe("judged 审查被中断");
	await harness.command("");
});

test("tail：错误在前，只取最后一条外部输入之后；热会话与已释放的冷会话读到同一份", async () => {
	const harness = await setup(true, { timing: { idleSessionMs: 30 } });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md", offset: 1 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("第一段完成"),
		fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md", note: "x".repeat(200) }), { stopReason: "toolUse" }),
		async () => { throw new Error("quota exhausted"); },
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({ action: "start", worker: "trace", prompt: "旧输入", role: "工程师" });
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "trace", prompt: "新输入" });
	await delivered;
	const hot = (await harness.execute({ action: "tail", worker: "trace" })).content[0].text as string;
	expect(hot).toContain("quota exhausted");
	expect(hot).toContain("新输入");
	expect(hot).not.toContain("旧输入");

	const first = (await harness.execute({ action: "tail", worker: "trace" })).content[0].text as string;
	await until(() => harness.pool.getSession((started.details as any).worker.session) === undefined);
	expect((await harness.execute({ action: "tail", worker: "trace" })).content[0].text).toBe(first);
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
