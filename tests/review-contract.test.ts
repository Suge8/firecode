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

/** 提示词定义的完整发现；默认分数过门槛。 */
function finding(issue: string, { condition = "每次重启", frequency = "10", impact = "6", title = "" } = {}) {
	return [
		`## 发现 1${title ? `：${title}` : ""}`,
		...(condition ? [`- 发生条件: ${condition}`] : []),
		`- 频率: ${frequency}`,
		`- 影响: ${impact}`,
		`- 问题: ${issue}`,
		"- 证据: checkpoint.ts",
		"- 违反的约定与期望行为: 终态必须可持久化",
		"- 验证命令: bun test",
	].join("\n");
}

describe("review output contract", () => {
	test("the verdict comes from the scores; a stray verdict word on the first line is ignored", async () => {
		await loadAll();
		expect(await vote(`FAIL\n${HEAD}`)).toMatchObject({ status: "passed", summary: "核对了 checkpoint 写入。" });
		expect((await vote(`PASS\n${HEAD}\n\n${finding("x")}`)).status).toBe("failed");
	});

	test("a passing report requires the evidence anchor line with files and commands", async () => {
		await loadAll();
		const ok = await vote("验证命令 exit 0，核心逻辑已核对。\n证据：文件=src/auth.ts；命令=npm test");
		expect(ok.status).toBe("passed");
		expect(ok.summary).toBe("验证命令 exit 0，核心逻辑已核对。");
		// 缺摘要行曾让 summary=undefined 流进多模型汇总对 undefined 调 replace，审查循环悬挂到超时。
		for (const [body, issue] of [
			["没有证据行", "格式无效"],
			["ok\n证据：文件=src/auth.ts；命令=", "格式无效"],
			["结论如下\n随便写", "格式无效"],
			["证据：文件=a.ts；命令=bun test", "缺少摘要行"],
		]) {
			const outcome = await vote(body);
			expect(`${body}:${outcome.status}`).toBe(`${body}:error`);
			expect(outcome.details).toContain(issue);
		}
	});

	// 发现模板的字段全是粗体，模型会把粗体带进证据行；两种行的容忍度必须一致。
	test("the evidence line tolerates the same bold and bullet decoration as the finding fields", async () => {
		await loadAll();
		for (const line of [
			"**证据**：文件=a.ts；命令=bun test",
			"**证据：**文件=a.ts；命令=bun test",
			"- **证据**: 文件=a.ts; 命令=bun test",
			"**Evidence**: files=a.ts; commands=bun test",
		]) expect(`${line}:${(await vote(`核心逻辑已核对。\n${line}`)).status}`).toBe(`${line}:passed`);
	});

});

describe("advisor verdict parsing", () => {
	test("tolerates a model preamble before the verdict line and keeps it as advice", async () => {
		await loadAll();
		// fable 实际产出过的形状：前言句 + 裁决行 + 正文。
		expect(await advise("我已核实关键文件与 Pi 类型定义，裁决如下。\ncontinue\n核实结论：发现属实")).toMatchObject({
			verdict: "continue",
			advice: "我已核实关键文件与 Pi 类型定义，裁决如下。\n核实结论：发现属实",
		});
		// 正文里出现的裁决词不得被误识别：扫描只覆盖前几个非空行。
		const body = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段分析`).join("\n");
		expect((await advise(`${body}\nstop`)).verdict).toBe("continue");
	});

	test("accepts an unambiguous verdict wrapped by markdown or a verdict label", async () => {
		await loadAll();
		expect(await advise("```text\nstop\n别修了\n```")).toMatchObject({
			verdict: "stop",
			advice: "别修了",
		});
		expect(await advise("裁决：narrow\n只修阻塞项")).toMatchObject({
			verdict: "narrow",
			advice: "只修阻塞项",
		});
		expect(await advise("Verdict: continue\nkeep fixing")).toMatchObject({
			verdict: "continue",
			advice: "keep fixing",
		});
		// 提示词里裁决词带反引号展示，模型照抄是真实发生过的解析失败根因。
		expect(await advise("`stop`\n别修了")).toMatchObject({
			verdict: "stop",
			advice: "别修了",
		});
		expect((await advise("裁决：`narrow`\n只修阻塞项")).verdict).toBe("narrow");
		// 与审查者的判定行同一套装饰容忍。
		for (const first of ["## stop", "**`stop`**", "stop。", "**stop**.", "**裁决：stop**"]) expect(`${first}:${(await advise(`${first}\n别修了`)).verdict}`).toBe(`${first}:stop`);
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

describe("evidence assembly", () => {
	function user(text: string) {
		return { type: "message", message: { role: "user", content: text } };
	}
	function assistant(text: string) {
		return { type: "message", message: { role: "assistant", content: text } };
	}

	test("超长消息的截断处写明是证据截断、原文多少字、完整原文在哪个会话文件，不留裸“[…]”让审查者误判回复不完整", async () => {
		await loadAll();
		const essay = "冬".repeat(5_000);
		const text = buildEvidence([user("写一篇散文"), assistant(essay)], { sessionFile: "/tmp/s/main.jsonl" });
		expect(text).not.toContain("[…]");
		expect(text).toContain("证据截断");
		expect(text).toContain("5000 字");
		expect(text).toContain("/tmp/s/main.jsonl");
	});

	test("超长命令的轨迹行截断同样写明原文长度与会话文件路径", async () => {
		await loadAll();
		const command = `echo ${"x".repeat(400)}`;
		const text = buildEvidence([user("需求"), {
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command } }] },
		}], { sessionFile: "/tmp/s/main.jsonl" });
		expect(text).toMatch(new RegExp(`截断，原文 ${command.length} 字`, "u"));
		expect(text).toContain("/tmp/s/main.jsonl");
	});

	test("assistant toolCall trail is kept as attribution evidence, including tool-call-only turns", async () => {
		await loadAll();
		const entries = [
			user("需求"),
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "改卡片" },
						{ type: "toolCall", id: "1", name: "edit", arguments: { path: "review/card.ts", edits: [] } },
						{ type: "toolCall", id: "2", name: "bash", arguments: { command: "bun  test\n tests" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "3", name: "write", arguments: { path: "a/b.ts", content: "x" } }],
				},
			},
		];
		const text = buildEvidence(entries);
		expect(text).toContain("改卡片");
		expect(text).toContain("[edit] review/card.ts");
		expect(text).toContain("[bash] bun test tests");
		expect(text).toContain("[write] a/b.ts");
	});

	test("failed tool calls are marked and cannot pose as actual edits", async () => {
		await loadAll();
		const entries = [
			user("需求"),
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "ok", name: "edit", arguments: { path: "a/ok.ts", edits: [] } },
						{ type: "toolCall", id: "bad", name: "edit", arguments: { path: "a/bad.ts", edits: [] } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolCallId: "ok", isError: false, content: "done" } },
			{ type: "message", message: { role: "toolResult", toolCallId: "bad", isError: true, content: "oldText not found" } },
		];
		const text = buildEvidence(entries);
		expect(text).toContain("[edit] a/bad.ts（失败）");
		expect(text).toContain("[edit] a/ok.ts");
		expect(text).not.toContain("a/ok.ts（失败）");
	});

	// 预算超出后曾继续往前塞更小的旧消息：被省略的消息留在中间，省略标记却写在锚点后面，指错了位置。
	test("the evidence keeps a contiguous recent suffix, so the omission marker sits where messages are missing", async () => {
		await loadAll();
		const big = (name: string) => assistant(`${name} ${"字".repeat(2_900)}`);
		const text = buildEvidence([user("ANCHOR"), assistant("old-small"), big("BIG-A"), big("BIG-B"), assistant("recent")], { budgetTokens: 4_000 });
		expect(text).toContain("recent");
		expect(text).toContain("BIG-B");
		expect(text).not.toContain("BIG-A");
		expect(text).not.toContain("old-small");
		expect(text.indexOf("省略")).toBeLessThan(text.indexOf("BIG-B"));
	});

	// 锚点曾取「第一个可渲染块」：用户消息之前若有别的扩展发的可显示消息，
	// 原始需求就会失去固定席位，在长会话里被预算裁掉。
	test("anchors on the first user message even when a custom message precedes it", async () => {
		await loadAll();
		const entries = [
			{ type: "custom_message", display: true, customType: "other-ext", content: "扩展横幅" },
			user("原始需求锚点"),
			...Array.from({ length: 30 }, (_, index) => assistant(`中间 ${index}`)),
			assistant("最新改动"),
		];
		const text = buildEvidence(entries, { budgetTokens: 60 });
		expect(text).toContain("原始需求锚点");
		expect(text).toContain("最新改动");
		expect(text).toContain("省略");
	});
});

describe("blocking threshold", () => {
	test("frequency × impact ≥ 20, or frequency ≥ 1 with impact ≥ 8, blocks; everything else does not", async () => {
		await loadAll();
		for (const [frequency, impact, blocks] of [["10", "2", true], ["4", "5", true], ["3", "6", false], ["1", "8", true], ["0", "10", false], ["2", "7", false]] as const)
			expect(`${frequency}×${impact}:${(await vote(`${HEAD}\n\n${finding("x", { frequency, impact })}`)).status}`).toBe(`${frequency}×${impact}:${blocks ? "failed" : "passed"}`);
	});

	test("a finding under the threshold or without a condition becomes one suggestion line", async () => {
		await loadAll();
		const low = await vote(`${HEAD}\n\n${finding("命名", { title: "命名不一致", impact: "1" })}`);
		expect(low.status).toBe("passed");
		expect(low.details).toContain("## 建议（非阻塞）\n- 命名不一致（发生条件：每次重启；频率 10 · 影响 1）");
		expect(low.details).not.toContain("## 发现");
		const vague = await vote(`${HEAD}\n\n${finding("可能丢数据", { title: "可能丢数据", condition: "", frequency: "9", impact: "9" })}`);
		expect(vague.status).toBe("passed");
		expect(vague.details).toContain("可能丢数据（发生条件未说明；频率 0 · 影响 9）");
	});

	test("needs-decision items are kept apart and never block", async () => {
		await loadAll();
		const outcome = await vote(`${HEAD}\n\n## 需用户裁决\n- 要求兼容旧快照与“不兼容就升版本”的约定冲突\n\n## 建议（非阻塞）\n- 随手写的建议`);
		expect(outcome.status).toBe("passed");
		expect(outcome.details).toContain("## 需用户裁决\n- 要求兼容旧快照");
		expect(outcome.details).toContain("## 建议（非阻塞）\n- 随手写的建议");
	});

	// 过了门槛就是审查者提出的阻断意见：格式再差也不能当缺席，否则另一票的 PASS 会让整轮通过。
	// 原文留作修复反馈与卡片正文，违例说明作为前注。
	test("a blocking finding with a broken format still fails and keeps the original text", async () => {
		await loadAll();
		const outcome = await vote("## 发现 1\n- 发生条件: 每次\n- 频率: 10\n- 影响: 6\n- 问题: 没有证据锚点");
		expect(outcome.status).toBe("failed");
		expect(outcome.details).toContain("未满足格式契约");
		expect(outcome.details).toContain("缺少证据锚点行");
		expect(outcome.details).toContain("- 问题: 没有证据锚点");
	});

	test("accepts a finding whose field values start on the next line", async () => {
		await loadAll();
		const multilineBody = `${HEAD}\n## 发现 1：结算态丢失完整结果\n- **发生条件**:\n每次结算\n- **频率**:\n10\n- **影响**:\n6\n- **问题**:\n大屏仍只显示标题，不展示这段核心问题说明。\n- **违反的约定与期望行为**:\n应按预算展示自然语言结果。\n- **证据**:\nreview/ui.ts\n- **验证命令**:\nbun test`;
		const outcome = await vote(multilineBody);
		expect(outcome.status).toBe("failed");
		expect(outcome.details).not.toContain("格式契约");
		expect(outcome.summary).toBe("大屏仍只显示标题，不展示这段核心问题说明。");
	});

	test("score and field decoration is tolerated; full-width punctuation and the English contract are accepted", async () => {
		await loadAll();
		const status = async (body: string) => (await vote(body)).status;
		const tail = ["- 问题: x", "- 证据: a.ts", "- 违反的约定与期望行为: y", "- 验证命令: bun test"].join("\n");
		for (const score of ["- 频率: 10", "- 频率: **10**", "- **频率：** 10", "- 频率: 10（一直存在）", "- 频率：10/10"])
			expect(`${score}:${await status(`${HEAD}\n## 发现 1\n- 发生条件: 每次\n${score}\n- 影响: 6\n${tail}`)}`).toBe(`${score}:failed`);
		expect(await status("Checked.\nEvidence: files=a.ts; commands=bun test\n## Finding 1\n- Condition: always\n- Frequency: 10\n- Impact: 6\n- Issue: x\n- Evidence: a.ts\n- Violated agreement & expected behavior: y\n- Verification command: bun test")).toBe("failed");
	});
});

test("总结回合的材料超长时写明省略了多少字，不留裸省略号", async () => {
	const { buildSummaryPrompt } = await loadFirecodeModule("review/prompt.js") as any;
	const prompt = buildSummaryPrompt({ kind: "passed", rounds: 2, material: "结论".repeat(3_000) });
	expect(prompt).toMatch(/材料截断：省略 2000 字/u);
	expect(prompt).not.toMatch(/\n…\n/u);
});
