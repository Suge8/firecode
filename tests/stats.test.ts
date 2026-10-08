import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

const usage = { input: 10, output: 20, cost: { total: 0.3 } };
const now = new Date().toISOString();
const assistant = (provider: string, model: string, timestamp = Date.now()) =>
	({ type: "message", message: { role: "assistant", provider, model, usage, timestamp } });

/** 经 /tokens 命令（无界面模式打印到 stdout）观察统计：真实会话 jsonl 进，Markdown 报告出。 */
async function report(lines: unknown[], args: string): Promise<string> {
	const agentDir = mkdtempSync(join(tmpdir(), "firecode-stats-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const log = console.log;
	let output = "";
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(join(agentDir, "sessions"));
		writeFileSync(join(agentDir, "sessions", "a.jsonl"), [...lines.map((line) => JSON.stringify(line)), "not json"].join("\n"));
		const { registerStats } = await loadFirecodeModule("session/stats.ts") as { registerStats: (pi: unknown) => void };
		const fake = fakePi();
		registerStats(fake.pi);
		console.log = (text: string) => { output += text; };
		await fake.commands.get("tokens").handler(args, { mode: "print", hasUI: false });
	} finally {
		console.log = log;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
	return output;
}

test("/tokens：assistant 按 provider/model 计请求，toolResult 与压缩/分支摘要归 tools/summaries 不计请求，无 usage 与坏行忽略，天数窗口之外不计", async () => {
	const lines = [
		assistant("openai", "gpt-5.5"),
		assistant("old", "model", 0),
		{ type: "message", message: { role: "toolResult", usage } },
		{ type: "compaction", timestamp: now, usage },
		{ type: "branch_summary", timestamp: now, usage },
		{ type: "message", message: { role: "assistant", provider: "openai", model: "none" } },
		{ type: "message", message: { role: "user", usage } },
		{ type: "compaction", timestamp: now },
	];
	const recent = await report(lines, "");
	expect(recent).toContain("| `tools/summaries` | 0 | 30 | 60 | 0 | 0 | 90 | $0.9000 |");
	expect(recent).toContain("| `openai/gpt-5.5` | 1 | 10 | 20 | 0 | 0 | 30 | $0.3000 |");
	expect(recent).not.toContain("old/model");
	expect(recent).not.toContain("openai/none");
	expect(await report(lines, "0")).toContain("| `old/model` | 1 |");
});
