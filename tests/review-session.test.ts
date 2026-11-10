import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFaux } from "./faux-host.ts";
import { loadFirecodeModule, PI_AI_COMPAT_URL, PI_AI_URL } from "./loader.ts";

const { fauxAssistantMessage } = await import(PI_AI_COMPAT_URL) as any;
const { getCurrentSystemPrompt, getCurrentTools } = await import(PI_AI_URL) as any;

type RunReviewSession = (pool: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
let faux: any;
let agentDir: string;
let cwd: string;
let runReviewSession: RunReviewSession;
let pool: unknown;
beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "firecode-review-session-agent-"));
	cwd = await mkdtemp(join(tmpdir(), "firecode-review-session-cwd-"));
	await writeFile(join(cwd, "AGENTS.md"), "PROJECT RULES");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = await installFaux(agentDir, ["p/one"]);
	({ runReviewSession } = await loadFirecodeModule("review/session.js") as { runReviewSession: RunReviewSession });
	pool = new ((await loadFirecodeModule("spawn.js")) as any).InProcessSessionPool();
});
afterAll(async () => {
	faux.unregister();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

const config = { models: [{ model: "p/one", thinking: "low" }], tools: ["read", "bash"], timeoutMs: 10_000 };
const request = (extra: Record<string, unknown> = {}) => ({ config, prompt: { system: "policy", user: "evidence" }, cwd, ...extra });

describe("review in-process session", () => {
	test("the reviewer sees only the review policy and the configured tools", async () => {
		let seen: any;
		faux.setResponses([(context: any) => { seen = context; return fauxAssistantMessage("PASS\n完整结论"); }]);
		expect(await runReviewSession(pool, request())).toMatchObject({ kind: "output", text: "PASS\n完整结论" });
		const system: string = getCurrentSystemPrompt(seen.messages);
		expect(system.startsWith("policy")).toBe(true);
		expect(system).not.toContain("PROJECT RULES");
		expect(getCurrentTools(seen.messages).map((tool: { name: string }) => tool.name).sort()).toEqual(["bash", "read"]);
	});

	// 模型流卡在半开连接上时 pi 的 abort 永不返回：取消与超时都不能等它。
	test.each([
		["caller cancellation", "aborted"],
		["deadline expiry", "timeout"],
	] as const)("%s returns without waiting for a stuck model stream", async (_name, kind) => {
		const started = Promise.withResolvers<void>();
		faux.setResponses([() => { started.resolve(); return new Promise<never>(() => {}); }]);
		const controller = new AbortController();
		const pending = runReviewSession(pool, request(kind === "aborted"
			? { signal: controller.signal }
			: { config: { ...config, timeoutMs: 50 } }));
		await started.promise;
		controller.abort();
		expect(await pending).toEqual({ kind });
	});

	test("an extension failing inside the reviewer session ends that vote with an error", async () => {
		let options: Record<string, any> = {};
		const fakePool = {
			resolveChain: async (models: unknown[]) => models[0],
			async spawn(next: Record<string, any>) {
				options = next;
				return {
					session: { subscribe: () => () => {} },
					prompt: async () => options.onExtensionError({ extensionPath: "ext.ts", event: "tool_call", error: "boom" }),
					dispose() {},
				};
			},
		};
		expect(await runReviewSession(fakePool, request())).toMatchObject({ kind: "error" });
	});
});
