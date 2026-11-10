import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";
import { reviewVoter } from "./review-vote.ts";

type BuildEvidence = typeof import("../review/evidence.js").buildEvidence;

let buildEvidence: BuildEvidence;

// 输出契约经真实的审查者 / 顾问会话解析：faux 供应商给出文本，结果就是 runReviewer / runAdvisor 的返回。
let voter: Awaited<ReturnType<typeof reviewVoter>>;
beforeAll(async () => { voter = await reviewVoter(); });
beforeEach(() => {
	((globalThis as Record<symbol, unknown>)[Symbol.for("firecode.model-cooldowns")] as Map<string, unknown> | undefined)?.clear();
});
afterAll(() => voter.close());
const vote = (text: string) => voter.vote(text);
const advise = (text: string) => voter.advise(text);

async function loadAll() {
	const evidence = (await loadFirecodeModule("review/evidence.js")) as {
		buildEvidence: BuildEvidence;
	};
	buildEvidence = evidence.buildEvidence;
}

/** 摘要与证据锚点：每份审查输出的前两行。 */
const HEAD = "核对了 checkpoint 写入。\n证据：文件=checkpoint.ts；命令=bun test";

describe("review output parsing", () => {
	// 发现模板的字段全是粗体，模型会把粗体带进证据行；两种行的容忍度必须一致。
	test("the evidence line tolerates bold and bullet decoration", async () => {
		await loadAll();
		for (const line of [
			"**证据**：文件=a.ts；命令=bun test",
			"**证据：**文件=a.ts；命令=bun test",
			"- **证据**: 文件=a.ts; 命令=bun test",
			"**Evidence**: files=a.ts; commands=bun test",
		]) expect(`${line}:${(await vote(`核心逻辑已核对。\n${line}`)).status}`).toBe(`${line}:passed`);
	});

	test("finding fields tolerate decoration, next-line values and the English contract", async () => {
		await loadAll();
		const status = async (body: string) => (await vote(body)).status;
		const tail = ["- 问题: x", "- 证据: a.ts", "- 违反的约定与期望行为: y", "- 验证命令: bun test"].join("\n");
		for (const score of ["- 频率: 10", "- 频率: **10**", "- **频率：** 10", "- 频率: 10（一直存在）", "- 频率：10/10"])
			expect(`${score}:${await status(`${HEAD}\n## 发现 1\n- 发生条件: 每次\n${score}\n- 影响: 6\n${tail}`)}`).toBe(`${score}:failed`);
		const multiline = await vote(`${HEAD}\n## 发现 1：结算态丢失完整结果\n- **发生条件**:\n每次结算\n- **频率**:\n10\n- **影响**:\n6\n- **问题**:\n大屏仍只显示标题。\n- **违反的约定与期望行为**:\n应按预算展示。\n- **证据**:\nreview/ui.ts\n- **验证命令**:\nbun test`);
		expect(multiline.status).toBe("failed");
		expect(multiline.summary).toBe("大屏仍只显示标题。");
		expect(await status("Checked.\nEvidence: files=a.ts; commands=bun test\n## Finding 1\n- Condition: always\n- Frequency: 10\n- Impact: 6\n- Issue: x\n- Evidence: a.ts\n- Violated agreement & expected behavior: y\n- Verification command: bun test")).toBe("failed");
	});
});

describe("advisor verdict parsing", () => {
	test("accepts a preamble, markdown wrapping, labels and decoration around the verdict line", async () => {
		await loadAll();
		// fable 实际产出过的形状：前言句 + 裁决行 + 正文。
		expect(await advise("我已核实关键文件与 Pi 类型定义，裁决如下。\ncontinue\n核实结论：发现属实")).toMatchObject({
			verdict: "continue",
			advice: "我已核实关键文件与 Pi 类型定义，裁决如下。\n核实结论：发现属实",
		});
		expect(await advise("```text\nstop\n别修了\n```")).toMatchObject({ verdict: "stop", advice: "别修了" });
		expect(await advise("裁决：narrow\n只修阻塞项")).toMatchObject({ verdict: "narrow", advice: "只修阻塞项" });
		expect(await advise("Verdict: continue\nkeep fixing")).toMatchObject({ verdict: "continue", advice: "keep fixing" });
		for (const first of ["`stop`", "## stop", "**`stop`**", "stop。", "**stop**.", "**裁决：stop**"]) expect(`${first}:${(await advise(`${first}\n别修了`)).verdict}`).toBe(`${first}:stop`);
		expect((await advise("裁决：`narrow`\n只修阻塞项")).verdict).toBe("narrow");
	});

	test("ambiguous or unparseable output falls back to continue", async () => {
		await loadAll();
		for (const output of [
			"我不确定\n随便",
			"stop or continue",
			"stop / narrow",
			"Verdict: stop or continue",
			"stop, but continue fixing",
		]) {
			const result = (await advise(output));
			expect(`${output}:${result.verdict}`).toBe(`${output}:continue`);
			expect(result.advice).toContain("无法解析");
		}
	});
});

describe("truncation notes", () => {
	test("evidence truncation says it is truncated, the original length and which session file holds the full text", async () => {
		await loadAll();
		const sessionFile = "/tmp/s/main.jsonl";
		const essay = buildEvidence([
			{ type: "message", message: { role: "user", content: "写一篇散文" } },
			{ type: "message", message: { role: "assistant", content: "冬".repeat(5_000) } },
		], { sessionFile });
		expect(essay).not.toContain("[…]");
		expect(essay).toContain("证据截断");
		expect(essay).toContain("5000 字");
		expect(essay).toContain(sessionFile);
		const command = `echo ${"x".repeat(400)}`;
		const trail = buildEvidence([
			{ type: "message", message: { role: "user", content: "需求" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command } }] } },
		], { sessionFile });
		expect(trail).toMatch(new RegExp(`截断，原文 ${command.length} 字`, "u"));
		expect(trail).toContain(sessionFile);
	});

	test("总结回合的材料超长时写明省略了多少字，不留裸省略号", async () => {
		const { buildSummaryPrompt } = await loadFirecodeModule("review/prompt.js") as any;
		const prompt = buildSummaryPrompt({ kind: "passed", rounds: 2, material: "结论".repeat(3_000) });
		expect(prompt).toMatch(/材料截断：省略 2000 字/u);
		expect(prompt).not.toMatch(/\n…\n/u);
	});
});
