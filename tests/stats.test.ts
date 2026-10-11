import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

const usage = { input: 10, output: 20, cost: { total: 0.3 } };
const now = new Date().toISOString();
const assistant = (provider: string, model: string, timestamp = Date.now()) =>
	({ type: "message", message: { role: "assistant", provider, model, usage, timestamp } });

const notices: string[] = [];

/** 经 /tokens 命令（无界面模式打印到 stdout）观察统计：真实会话 jsonl 进，Markdown 报告出。 */
async function report(lines: unknown[], args: string, arrange?: (agentDir: string) => void): Promise<string> {
	const agentDir = mkdtempSync(join(tmpdir(), "firecode-stats-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const log = console.log;
	let output = "";
	notices.length = 0;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(join(agentDir, "sessions"));
		writeFileSync(join(agentDir, "sessions", "a.jsonl"), [...lines.map((line) => JSON.stringify(line)), "not json"].join("\n"));
		arrange?.(agentDir);
		const { registerStats } = await loadFirecodeModule("session/stats.ts") as { registerStats: (pi: unknown) => void };
		const fake = fakePi();
		registerStats(fake.pi);
		console.log = (text: string) => { output += text; };
		await fake.commands.get("tokens").handler(args, { mode: "print", hasUI: false, ui: { notify: (message: string) => notices.push(message) } });
	} finally {
		console.log = log;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		// 解开权限才删得掉。
		try { chmodSync(join(agentDir, "sessions", "locked"), 0o700); } catch { /* 没有这个目录 */ }
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

test("/tokens：旧文件里没有时间戳的记录照常计入，指向目录的软链接照常遍历", async () => {
	const undated = { type: "message", message: { role: "assistant", provider: "undated", model: "m", usage } };
	const out = await report([undated], "7", (agentDir) => {
		const old = new Date(0);
		utimesSync(join(agentDir, "sessions", "a.jsonl"), old, old);
		const elsewhere = join(agentDir, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "b.jsonl"), JSON.stringify(assistant("linked", "m")));
		symlinkSync(elsewhere, join(agentDir, "sessions", "link"));
	});
	expect(out).toContain("`undated/m` | 1 |");
	expect(out).toContain("`linked/m` | 1 |");
});

test("/tokens：超过一个读块的超长单行照常统计，其后的行也不丢；读不了的目录计数并写进报告", async () => {
	const huge = { type: "message", message: { role: "assistant", provider: "huge", model: "m", usage, timestamp: Date.now(), content: "x".repeat(3 << 20) } };
	const out = await report([huge, assistant("after", "m")], "", (agentDir) => {
		const locked = join(agentDir, "sessions", "locked");
		mkdirSync(locked);
		chmodSync(locked, 0);
	});
	expect(out).toContain("`huge/m` | 1 |");
	expect(out).toContain("`after/m` | 1 |");
	expect(out).toContain("无法读取：1 个文件或目录");
});

test("/tokens：参数只认纯数字天数，其余提示用法、不统计", async () => {
	expect(await report([assistant("a", "m")], "7 days")).toBe("");
	expect(notices).toEqual(["用法：/tokens [天数]，天数为整数，省略为 30，0 表示全部"]);
});
