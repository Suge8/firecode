import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFaux } from "./faux-host.ts";
import { loadFirecodeModule, PI_AI_COMPAT_URL } from "./loader.ts";

const { fauxAssistantMessage } = await import(PI_AI_COMPAT_URL) as any;

/** faux 供应商让会话以供应商错误收场。 */
export type SessionReply = string | { error: string };

/**
 * 经真实的审查者与顾问会话解析模型输出：faux 供应商按给定文本回答，输出契约由 runReviewer / runAdvisor 原样解析。
 * 会改 PI_CODING_AGENT_DIR，用完调 close 还原；配置（含语言）由 options 决定。
 */
export async function reviewVoter(options: Parameters<typeof loadFirecodeModule>[1] = {}) {
	const saved = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "firecode-vote-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = await installFaux(agentDir, ["p/one"]);
	const [{ runReviewer }, { runAdvisor }, { InProcessSessionPool }] = await Promise.all([
		loadFirecodeModule("review/reviewer.js", options),
		loadFirecodeModule("review/advisor.js", options),
		loadFirecodeModule("spawn.js", options),
	]) as any[];
	const pool = new InProcessSessionPool();
	const request = { config: { model: "p/one", thinking: "low", tools: [], timeoutMs: 10_000 }, prompt: { system: "policy", user: "input" }, cwd: tmpdir(), pool };
	const reply = (text: SessionReply) => faux.setResponses([typeof text === "string"
		? fauxAssistantMessage(text)
		: fauxAssistantMessage([], { stopReason: "error", errorMessage: text.error })]);
	return {
		/** 审查者这一票的结果（status、summary、details）。 */
		vote: (text: SessionReply) => { reply(text); return runReviewer({ index: 0, ...request }); },
		/** 顾问的裁决；会话没有产出时抛错。 */
		advise: (text: SessionReply) => { reply(text); return runAdvisor(request); },
		async close() {
			faux.unregister();
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}
