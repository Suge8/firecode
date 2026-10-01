import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule, PI_AI_URL, PI_CODING_AGENT_URL } from "./loader.ts";

const { createAgentSession, ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
const { fauxProvider, fauxAssistantMessage } = await import(PI_AI_URL) as any;

// Anthropic 换发后吊销旧令牌时返回的原文，request_id 不含会被宿主误判为可重试的状态码数字。
const REVOKED = '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_rotation"}';
const FAR_FUTURE = Date.now() + 3_600_000;
const bridges: string[] = [];
let directory: string | undefined;

afterEach(async () => {
	for (const bridge of bridges.splice(0)) delete (globalThis as any)[Symbol.for(bridge)];
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	await cleanupFirecodeModules();
});

type Credential = { type: "oauth"; access: string; refresh: string; expires: number } | { type: "api_key"; key: string };

/** 真实 SDK 会话：anthropic 由 faux 应答，凭据走真实令牌文件与宿主解析；responses 拿到本次请求所用令牌。 */
async function claudeSession(credential: Credential, responses: Array<(token: string, authPath: string) => Promise<unknown>>) {
	directory = await mkdtemp(join(tmpdir(), "firecode-token-rotation-"));
	const agentDir = join(directory, "agent");
	const authPath = join(agentDir, "auth.json");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await writeFile(authPath, JSON.stringify({ anthropic: credential }));
	const { registerClaudeSub } = await loadFirecodeModule("provider/claude-sub.ts") as any;
	const bridge = `firecode-token-rotation-${crypto.randomUUID()}`;
	bridges.push(bridge);
	(globalThis as any)[Symbol.for(bridge)] = registerClaudeSub;
	await writeFile(join(agentDir, "extensions", "claude-sub.ts"),
		`export default (pi) => globalThis[Symbol.for(${JSON.stringify(bridge)})](pi);`);

	const faux = fauxProvider({ provider: "anthropic" });
	const runtime = await ModelRuntime.create({ authPath, modelsPath: join(agentDir, "models.json") });
	const tokens: string[] = [];
	faux.setResponses(responses.map((respond) => async (_context: unknown, options: { apiKey: string }) => {
		tokens.push(options.apiKey);
		return respond(options.apiKey, authPath);
	}));
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir,
		model: faux.getModel(),
		modelRuntime: runtime,
		sessionManager: SessionManager.inMemory(directory),
		tools: [],
	});
	// 注册在会话之后：归因模块给 anthropic 补请求头的注册会覆盖先注册的原生供应商。
	runtime.registerNativeProvider({
		...faux.provider,
		auth: {
			...faux.provider.auth,
			oauth: {
				name: "Claude Pro/Max",
				isSubscription: true,
				login: async () => { throw new Error("login is not part of this scenario"); },
				refresh: async () => { throw new Error("tokens in this scenario never expire"); },
				toAuth: async (stored: { access: string }) => ({ apiKey: stored.access }),
			},
		},
	});
	return { session, tokens };
}

const oauth = (access: string): Credential => ({ type: "oauth", access, refresh: `${access}-refresh`, expires: FAR_FUTURE });
const revoked = async () => fauxAssistantMessage([], { stopReason: "error", errorMessage: REVOKED });

test("Claude 订阅令牌在请求途中被换发：自动用新令牌重试一次，会话正常落定", async () => {
	const { session, tokens } = await claudeSession(oauth("old-token"), [
		async (_token, authPath) => {
			// 另一个进程在本请求途中换发了令牌，旧令牌随即被吊销。
			await writeFile(authPath, JSON.stringify({ anthropic: oauth("new-token") }));
			return revoked();
		},
		async () => fauxAssistantMessage("done"),
	]);
	try {
		await session.prompt("start");
		expect(tokens).toEqual(["old-token", "new-token"]);
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	} finally {
		session.dispose();
	}
}, 10_000);

test.each([
	["重试仍被拒：登录真失效", oauth("dead-token"), 2],
	["API key 被拒：配置错误", { type: "api_key", key: "wrong-key" } as Credential, 1],
])("%s，不再重试，以 error 落定", async (_name, credential, requestCount) => {
	const { session, tokens } = await claudeSession(credential, [revoked, revoked, async () => fauxAssistantMessage("unreachable")]);
	try {
		await session.prompt("start");
		expect(tokens).toHaveLength(requestCount);
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: REVOKED });
	} finally {
		session.dispose();
	}
}, 10_000);
