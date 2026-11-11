import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featuresOnly, loadFirecodeModule, PI_AI_COMPAT_URL, PI_CODING_AGENT_URL } from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(PI_CODING_AGENT_URL) as any;
let directory: string | undefined;
let faux: any;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

/** 真实 SDK 会话：faux 模型依次发出 calls 里的工具调用，返回每次调用的工具结果文本。 */
async function run(subsession: boolean, calls: [string, Record<string, unknown>][]) {
	directory = await mkdtemp(join(tmpdir(), "firecode-sleep-guard-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly() }),
	}) as { registerFirecode(pi: unknown, subsession: boolean): void };
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: unknown) => registerFirecode(pi, subsession), createCodemodeExtension()],
	});
	await resourceLoader.reload();
	faux = registerFauxProvider();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const results: string[] = [];
	const reply = (next: unknown) => (context: any) => {
		const last = context.messages.at(-1);
		if (last.role === "toolResult") results.push(last.content.map((block: any) => block.text ?? "").join(""));
		return next;
	};
	faux.setResponses([
		...calls.map(([name, args]) => reply(fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }))),
		reply(fauxAssistantMessage("done")),
	]);
	const { session } = await createAgentSession({
		cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["bash", "codemode"],
	});
	await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(error.error); } });
	try {
		await session.prompt("go");
	} finally {
		session.dispose();
	}
	return results;
}

// 提示词写了五处不准裸 sleep 轮询，审计仍见约 6,000 次不带条件的长 sleep：主会话与子代理会话都由机制拦下。
test("bash 里超过 30 秒的 sleep 被拦且模型拿到改法，条件循环里的短 sleep 放行，codemode 脚本里的 bash 同样被拦", async () => {
	for (const subsession of [false, true]) {
		const [direct, loop, script] = await run(subsession, [
			["bash", { command: "sleep 120" }],
			["bash", { command: "until true; do sleep 10; done; echo loop-ran" }],
			["codemode", { code: 'await tools.bash({ command: "sleep 120" }); return "slept";' }],
		]);
		expect(direct).toContain("已拦下：命令里有超过 30 秒");
		expect(direct).toContain("until <条件>; do sleep 10; done");
		expect(direct).not.toContain("timeout <秒>");
		expect(loop).toContain("loop-ran");
		expect(script).toContain("已拦下：命令里有超过 30 秒");
		expect(script).not.toContain("slept");
	}
}, 30_000);

// timeout 另开进程组，回合中止时漏下：timeout 3600 go test 在中止后又跑了 50 分钟。长的拦下并给改法，短的与引号里的放行。
test("bash 里超过 120 秒或算不出时长的 timeout 被拦且模型拿到改法，短的 timeout 与引号里提到的放行", async () => {
	const [long, withOptions, unknown, short, quoted] = await run(false, [
		["bash", { command: "timeout 3600 go test ./... && echo long-ran" }],
		["bash", { command: "timeout -k 5 --foreground 1h make; echo options-ran" }],
		["bash", { command: "timeout $LIMIT make; echo unknown-ran" }],
		["bash", { command: "timeout 5 echo short-ran" }],
		["bash", { command: 'echo "timeout 3600" quoted-ran' }],
	]);
	for (const blocked of [long, withOptions, unknown]) {
		expect(blocked).toContain("已拦下：命令里有超过 120 秒");
		expect(blocked).toContain("bash 工具的 timeout 参数");
		expect(blocked).not.toContain("-ran");
	}
	expect(short).toContain("short-ran");
	expect(quoted).toContain("quoted-ran");
}, 30_000);
