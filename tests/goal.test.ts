import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFaux } from "./faux-host.ts";
import { featuresOnly, firecodeModulePath, loadFirecodeModule, PI_AI_COMPAT_URL, PI_AI_URL, PI_CODING_AGENT_URL, TEST_REVIEW_CONFIG } from "./loader.ts";
import { until } from "./until.ts";

const { fauxAssistantMessage, fauxToolCall } = await import(PI_AI_COMPAT_URL) as any;
const { getCurrentSystemPrompt, getCurrentTools } = await import(PI_AI_URL) as any;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(PI_CODING_AGENT_URL) as any;

const directories: string[] = [];
let faux: any;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	faux?.unregister();
	faux = undefined;
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const workTool = {
	name: "work",
	label: "Work",
	description: "Does one unit of work",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: async () => ({ content: [{ type: "text", text: "worked" }], details: {} }),
};
const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });
const PASS = "逐条核对完毕。\n证据：文件=a.ts；命令=bun test";
const FAIL = [
	"有一条要求未达成。",
	"证据：文件=a.ts；命令=bun test",
	"## 发现 1：第二条要求没做",
	"- **发生条件**: 一直存在",
	"- **频率**: 10",
	"- **影响**: 5",
	"- **问题**: 第二条要求没做",
	"- **违反的约定与期望行为**: 目标第二条",
	"- **证据**: a.ts 里没有",
	"- **验证命令**: bun test",
].join("\n");

interface Seen { system: string; tools: string[]; text: string }

/**
 * 真实主会话（registerFirecode）+ 真实池 + faux 供应商。executor 按顺序回答会话模型的每次请求，reviewer 回答审查者的；
 * 每次请求记下系统提示、声明的工具与消息正文。
 */
async function setup(options: { review?: boolean; goal?: unknown; executor: (index: number, seen: Seen, signal?: AbortSignal) => unknown; reviewer?: (index: number) => string }) {
	const directory = await mkdtemp(join(tmpdir(), "firecode-goal-"));
	directories.push(directory);
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
	faux = await installFaux(agentDir, ["test/session", "test/reviewer", "test/advisor"]);
	const executor: Seen[] = [];
	const reviewer: Seen[] = [];
	const step = (context: any, request: { signal?: AbortSignal } | undefined, _state: unknown, model: any) => {
		const seen: Seen = { system: getCurrentSystemPrompt(context.messages) ?? "", tools: getCurrentTools(context.messages).map((tool: any) => tool.name), text: JSON.stringify(context.messages) };
		if (model.id === "session") return options.executor(executor.push(seen) - 1, seen, request?.signal);
		return fauxAssistantMessage(options.reviewer!(reviewer.push(seen) - 1));
	};
	faux.setResponses(Array.from({ length: 60 }, () => step));

	const features = await featuresOnly("goal", ...(options.review ? ["review"] : []));
	const moduleOptions = { configJsonc: JSON.stringify({ features, review: TEST_REVIEW_CONFIG, ...(options.goal ? { goal: options.goal } : {}) }) };
	const { registerFirecode } = await loadFirecodeModule("index.ts", moduleOptions) as any;
	const { InProcessSessionPool } = await import(await firecodeModulePath("spawn.ts", moduleOptions)) as any;
	const pool = new InProcessSessionPool({ firecode: (child: any) => registerFirecode(child, true, pool) });
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [{ name: "firecode", factory: (pi: any) => registerFirecode(pi, false, pool) }],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const { session } = await createAgentSession({
		cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), modelRuntime,
		model: modelRuntime.getModel("test", "session"), tools: ["work", "goal_complete"], customTools: [workTool],
	});
	const notices: string[] = [];
	const errors: string[] = [];
	// 宿主把界面上下文逐个方法包一层，所以审查用到的方法要真的在对象上。
	const ui = { notify: (text: string) => notices.push(text), setStatus() {}, setTitle() {}, setWidget() {}, setEditorComponent() {}, getEditorComponent: () => undefined };
	await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error: any) => errors.push(error.error) });
	cleanups.push(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const goal = () => session.sessionManager.getBranch().findLast((entry: any) => entry.customType === "firecode-goal")?.data;
	const cards = () => session.sessionManager.getBranch()
		.filter((entry: any) => entry.type === "custom_message" && entry.customType === "firecode-goal-card").map((entry: any) => entry.content as string);
	return { session, executor, reviewer, notices, errors, goal, cards };
}

test("设了目标：回合结束自动续跑，模型声明完成后停下；规则与完成工具只在目标进行时出现", async () => {
	const replies = [call("work"), fauxAssistantMessage("第一部分做完了"), call("goal_complete"), fauxAssistantMessage("全部完成"), fauxAssistantMessage("好的")];
	const { session, executor, goal, cards, errors } = await setup({ executor: (index) => replies[index] });

	await session.prompt("/goal 把两部分都做完");
	await until(() => goal()?.status === "complete");
	await session.waitForIdle();

	expect(errors).toEqual([]);
	// 开工、工具结果后、续跑、完成工具结果后：四次请求，之后不再续跑。
	expect(executor).toHaveLength(4);
	expect(executor[0].system).toContain("把两部分都做完");
	expect(executor[0].tools).toContain("goal_complete");
	expect(executor[2].text).toContain("继续朝目标推进");
	expect(cards().at(-1)).toContain("目标已完成");

	await session.prompt("之后的普通消息");
	expect(executor).toHaveLength(5);
	expect(executor[4].tools).not.toContain("goal_complete");
	expect(executor[4].system).not.toContain("把两部分都做完");
}, 20_000);

test("连续三个回合没有工具调用：目标暂停，不再续跑；/goal resume 接着干", async () => {
	const replies = [fauxAssistantMessage("我在想"), fauxAssistantMessage("还在想"), fauxAssistantMessage("仍在想"), call("goal_complete"), fauxAssistantMessage("完成")];
	const { session, executor, goal, cards } = await setup({ executor: (index) => replies[index] });

	await session.prompt("/goal 想清楚");
	await until(() => goal()?.status === "paused");
	await session.waitForIdle();
	expect(executor).toHaveLength(3);
	expect(cards().at(-1)).toContain("连续 3 个回合没有工具调用");

	await session.prompt("/goal resume");
	await until(() => goal()?.status === "complete");
	await session.waitForIdle();
	expect(executor).toHaveLength(5);
}, 20_000);

test("token 预算用完：回合中途提醒一次收尾，回合结束时目标暂停", async () => {
	const { session, executor, goal, cards } = await setup({
		goal: { tokenBudget: 1 },
		executor: (_index, seen) => (seen.text.includes("不再开始新的工作") ? fauxAssistantMessage("进展总结") : call("work")),
	});

	await session.prompt("/goal 一直干");
	await until(() => goal()?.status === "paused");
	await session.waitForIdle();
	expect(executor).toHaveLength(2);
	expect(cards().filter((text) => text.includes("不再开始新的工作"))).toHaveLength(1);
	expect(cards().at(-1)).toContain("token 预算（1）已用完。");
}, 20_000);

test("验收闸门：声明完成后审查者按验收立场核对目标原文，打回就修，通过才记完成", async () => {
	const replies = [call("goal_complete"), fauxAssistantMessage("交付说明"), call("work"), fauxAssistantMessage("修好了"), fauxAssistantMessage("总结")];
	const { session, executor, reviewer, goal, cards, errors } = await setup({
		review: true,
		executor: (index) => replies[index],
		reviewer: (index) => (index === 0 ? FAIL : PASS),
	});

	await session.prompt("/goal 做完第一条和第二条");
	await until(() => goal()?.status === "complete", 20_000);
	await session.waitForIdle();

	expect(errors).toEqual([]);
	expect(reviewer).toHaveLength(2);
	expect(reviewer[0].system).toContain("目标验收");
	expect(reviewer[0].system).toContain("输出契约");
	expect(reviewer[0].text).toContain("做完第一条和第二条");
	// 声明、交付说明、修复（工具 + 回复）、总结：验收期间没有续跑消息。
	expect(executor).toHaveLength(5);
	expect(executor.some((request) => request.text.includes("继续朝目标推进"))).toBe(false);
	expect(executor[2].text).toContain("第二条要求没做");
	expect(cards().at(-1)).toContain("目标已完成");
}, 30_000);

test("目标进行中手动开的审查：审查者被告知目标还没做完；审查结束后目标接着干", async () => {
	const replies = [call("work"), fauxAssistantMessage("做了一部分"), fauxAssistantMessage("总结"), call("goal_complete"), fauxAssistantMessage("完成"), fauxAssistantMessage("总结")];
	let session: any;
	let started = false;
	const context = await setup({
		review: true,
		executor: (index) => {
			// 第一个回合的回复之前排上一场普通审查：回合结束时它在排队，目标不续跑。
			if (index === 1 && !started) {
				started = true;
				void session.prompt("/fire-review");
			}
			return replies[index];
		},
		reviewer: () => PASS,
	});
	session = context.session;

	await session.prompt("/goal 做完全部");
	await until(() => context.goal()?.status === "complete", 20_000);
	await session.waitForIdle();

	expect(context.errors).toEqual([]);
	expect(context.reviewer).toHaveLength(2);
	expect(context.reviewer[0].system).toContain("对抗性审查");
	expect(context.reviewer[0].text).toContain("目标里还没做的部分不立案");
	expect(context.reviewer[1].system).toContain("目标验收");
}, 30_000);

test("Esc 中止回合：目标暂停，不再续跑", async () => {
	const { session, executor, goal, cards } = await setup({
		executor: (_index, _seen, signal) => new Promise((resolve) => {
			signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
		}),
	});

	void session.prompt("/goal 干到一半");
	await until(() => executor.length === 1);
	await session.abort();
	await until(() => goal()?.status === "paused");
	await session.waitForIdle();
	expect(executor).toHaveLength(1);
	expect(cards().at(-1)).toContain("回合被中断");
}, 20_000);

test("声称完成之后中止回合：目标暂停，排队的验收通过也不会把它记成完成", async () => {
	const { session, executor, reviewer, goal } = await setup({
		review: true,
		executor: (index, _seen, signal) => (index === 0 ? call("goal_complete") : index === 1
			? new Promise((resolve) => signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }))
			: fauxAssistantMessage("总结")),
		reviewer: () => PASS,
	});

	void session.prompt("/goal 做完");
	await until(() => executor.length === 2);
	await session.abort();
	await until(() => reviewer.length === 1 && executor.length === 3);
	await session.waitForIdle();
	expect(goal()?.status).toBe("paused");
}, 20_000);
