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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 真实 SDK 会话：faux 模型每轮把 batches 里的一批调用同时发出，返回每批的工具结果（文本与是否带图）。 */
async function run(batches: [string, Record<string, unknown>][][]) {
	directory = await mkdtemp(join(tmpdir(), "firecode-sibling-read-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly() }),
	}) as { registerFirecode(pi: unknown): void };
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: unknown) => registerFirecode(pi), createCodemodeExtension()],
	});
	await resourceLoader.reload();
	faux = registerFauxProvider();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const results: { text: string; isError: boolean; image: boolean }[][] = [];
	const reply = (next: unknown) => (context: any) => {
		const batch = [];
		for (let i = context.messages.length - 1; context.messages[i].role === "toolResult"; i--) batch.unshift(context.messages[i]);
		if (batch.length) results.push(batch.map((message) => ({
			text: message.content.map((block: any) => block.text ?? "").join(""),
			isError: message.isError,
			image: message.content.some((block: any) => block.type === "image"),
		})));
		return next;
	};
	faux.setResponses([
		...batches.map((calls) => reply(fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" }))),
		reply(fauxAssistantMessage("done")),
	]);
	const { session } = await createAgentSession({
		cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["bash", "read", "codemode"],
	});
	await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(error.error); } });
	try {
		await session.prompt("go");
	} finally {
		session.dispose();
	}
	return results;
}

// 模型常把生成文件的命令和读它放在同一批：并行执行时 read 先跑完得 ENOENT，模型再花一整轮重读（近两周读图失败约 550 次）。
test("同一批里读兄弟调用稍后写出的文件：read 等兄弟跑完拿到内容，两个 read 同时等也不互相卡住", async () => {
	const [[make, text, image]] = await run([[
		["bash", { command: `sleep 0.5 && printf made > gen.txt && echo ${PNG} | base64 -d > gen.png` }],
		["read", { path: "gen.txt" }],
		["read", { path: "gen.png" }],
	]]);
	expect(make.isError).toBe(false);
	expect(text).toEqual({ text: "made", isError: false, image: false });
	expect(image.isError).toBe(false);
	expect(image.text).toContain("Read image file");
	expect(image.image).toBe(true);
}, 30_000);

test("codemode 脚本里同层并发的生成与读取：嵌套 read 只等同层兄弟、不等父调用，拿到内容", async () => {
	const [[script]] = await run([[
		["codemode", { code: 'const [, read] = await Promise.all([tools.bash({ command: "sleep 0.5 && printf nested > gen.txt" }), tools.read({ path: "gen.txt" })]); return read;' }],
	]]);
	expect(script.isError).toBe(false);
	expect(script.text).toContain("nested");
}, 30_000);

test("真不存在的文件、同层没有兄弟在跑时，read 仍报 ENOENT", async () => {
	const [[sibling, withSibling], [alone]] = await run([
		[["bash", { command: "sleep 0.2" }], ["read", { path: "missing.txt" }]],
		[["read", { path: "missing.txt" }]],
	]);
	expect(sibling.isError).toBe(false);
	for (const read of [withSibling, alone]) {
		expect(read.isError).toBe(true);
		expect(read.text).toContain("ENOENT");
	}
}, 30_000);
