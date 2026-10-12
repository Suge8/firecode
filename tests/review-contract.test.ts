import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";
import { reviewVoter } from "./review-vote.ts";

type BuildEvidence = typeof import("../review/evidence.js").buildEvidence;

let buildEvidence: BuildEvidence;

// 输出契约经真实的审查者 / 顾问会话解析：faux 供应商给出文本，结果就是 runReviewer / runAdvisor 的返回。
let voter: Awaited<ReturnType<typeof reviewVoter>>;
beforeAll(async () => { voter = await reviewVoter(); });
afterAll(() => voter.close());
const vote = (text: string) => voter.vote(text);
const advise = (text: string) => voter.advise(text);

async function loadAll() {
	const evidence = (await loadFirecodeModule("review/evidence.js")) as {
		buildEvidence: BuildEvidence;
	};
	buildEvidence = evidence.buildEvidence;
}

/** 提示词定义的完整发现，供合法 FAIL 用例复用。 */
function finding(issue: string) {
	return [
		"## 发现 1",
		"- 严重程度: 高",
		`- 问题: ${issue}`,
		"- 证据: checkpoint.ts",
		"- 违反的约定与期望行为: 终态必须可持久化",
		"- 验证命令: bun test",
	].join("\n");
}

describe("PASS/FAIL output contract", () => {
	test("the verdict word tolerates markdown wrapping, backticks and case", async () => {
		await loadAll();
		const body = "\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		for (const first of ["PASS", "**PASS**", "__PASS__", "`PASS`", "  pass  ", "## PASS", "结论：**PASS**", "**`PASS`**", "PASS。", "**PASS**.", "**PASS**。", "**结论：PASS**"])
			expect(`${first}:${(await vote(first + body)).status}`).toBe(`${first}:passed`);
		expect((await vote("**FAIL**\n" + finding("x"))).status).toBe("failed");
		for (const first of ["**FAIL**.", "**FAIL**。", "**判定：FAIL**"]) expect(`${first}:${(await vote(first + "\n" + finding("x"))).status}`).toBe(`${first}:failed`);
		expect((await vote("maybe" + body)).status).toBe("error");
	});

	test("PASS whose only pre-evidence line is the suggestions heading is a contract violation", async () => {
		await loadAll();
		// 曾让 summary=undefined 流进多模型汇总对 undefined 调 replace，审查循环悬挂到超时。
		const result = (await vote("PASS\n## 建议（非阻塞）\n证据：文件=a.ts；命令=bun test"));
		expect(result.status).toBe("error");
		expect(result.details).toContain("缺少摘要行");
	});

	test("PASS requires summary + evidence anchor line with files and commands", async () => {
		await loadAll();
		const ok = (await vote("PASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=src/auth.ts；命令=npm test"));
		expect(ok.status).toBe("passed");
		expect(ok.summary).toBe("验证命令 exit 0，核心逻辑已核对。");
		expect((await vote("PASS\n没有证据行")).status).toBe("error");
		expect((await vote("PASS\n证据：文件=src/auth.ts；命令=npm test")).status).toBe("error");
		expect((await vote("PASS\nok\n证据：文件=src/auth.ts；命令=")).status).toBe("error");
	});

	// FAIL 模板的字段全是粗体，模型会把粗体带进 PASS 证据行；两种行的容忍度必须一致。
	test("the evidence line tolerates the same bold and bullet decoration as the FAIL fields", async () => {
		await loadAll();
		for (const line of [
			"**证据**：文件=a.ts；命令=bun test",
			"**证据：**文件=a.ts；命令=bun test",
			"- **证据**: 文件=a.ts; 命令=bun test",
			"**Evidence**: files=a.ts; commands=bun test",
		]) expect(`${line}:${(await vote(`PASS\n核心逻辑已核对。\n${line}`)).status}`).toBe(`${line}:passed`);
	});

	test("FAIL keeps the findings as details and pulls a one-line issue for the summary", async () => {
		await loadAll();
		const parsed = (await vote(`FAIL\n${finding("auth 没校验")}`));
		expect(parsed.status).toBe("failed");
		expect(parsed.summary).toBe("auth 没校验");
		expect(parsed.details).toContain("发现 1");
	});

	test("a non-PASS/FAIL first line or empty output is rejected as invalid format", async () => {
		await loadAll();
		const parsed = (await vote("结论如下\n随便写"));
		expect(parsed.status).toBe("error");
		expect(parsed.details).toContain("格式无效");
		expect((await vote("")).status).toBe("error");
	});
});

describe("advisor verdict parsing", () => {
	test("parses continue/stop/narrow on the first line", async () => {
		await loadAll();
		expect(await advise("continue\n继续修")).toEqual({ verdict: "continue", advice: "继续修" });
		expect((await advise("stop\n别修了")).verdict).toBe("stop");
		expect((await advise("narrow\n收窄范围")).verdict).toBe("narrow");
		expect((await advise("**stop**")).verdict).toBe("stop");
	});

	test("tolerates a model preamble before the verdict line and keeps it as advice", async () => {
		await loadAll();
		// fable 实际产出过的形状：前言句 + 裁决行 + 正文。
		expect(await advise("我已核实关键文件与 Pi 类型定义，裁决如下。\ncontinue\n核实结论：发现属实")).toEqual({
			verdict: "continue",
			advice: "我已核实关键文件与 Pi 类型定义，裁决如下。\n核实结论：发现属实",
		});
		// 正文里出现的裁决词不得被误识别：扫描只覆盖前几个非空行。
		const body = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段分析`).join("\n");
		expect((await advise(`${body}\nstop`)).verdict).toBe("continue");
	});

	test("accepts an unambiguous verdict wrapped by markdown or a verdict label", async () => {
		await loadAll();
		expect(await advise("```text\nstop\n别修了\n```")).toEqual({
			verdict: "stop",
			advice: "别修了",
		});
		expect(await advise("裁决：narrow\n只修阻塞项")).toEqual({
			verdict: "narrow",
			advice: "只修阻塞项",
		});
		expect(await advise("Verdict: continue\nkeep fixing")).toEqual({
			verdict: "continue",
			advice: "keep fixing",
		});
		// 提示词里裁决词带反引号展示，模型照抄是真实发生过的解析失败根因。
		expect(await advise("`stop`\n别修了")).toEqual({
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

	test("an advisor session that yields nothing raises, so the executor can skip the consultation", async () => {
		await expect(voter.advise({ error: "auth failed" })).rejects.toThrow("顾问会话不可用");
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

describe("FAIL output contract", () => {
	// 以 FAIL 开头就是审查者提出的阻断意见：格式再差也不能当缺席，否则另一票的 PASS 会让整轮通过。
	// 原文留作修复反馈与卡片正文，违例说明作为前注。
	test("a FAIL that breaks the format still counts as a failure and keeps the original text", async () => {
		await loadAll();
		for (const [body, note] of [
			["FAIL", "缺少阻塞发现"],
			["FAIL\nnot a finding", "缺少阻塞发现"],
			["FAIL\n## 建议（非阻塞）\n- 问题: 可以更好", "缺少阻塞发现"],
			["FAIL\n- 严重程度: 中\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: z", "缺少阻塞发现"], // 字段齐全但没有「## 发现」小节标题
			["FAIL\n## 发现 1\n- 严重程度: 中\n- 问题: 只有问题", "缺少必填字段"],
		] as const) {
			const outcome = (await vote(body));
			expect(`${body}:${outcome.status}`).toBe(`${body}:failed`);
			expect(outcome.details).toContain("未满足格式契约");
			expect(outcome.details).toContain(note);
			expect(outcome.details).toContain(body.slice(5));
		}
	});

	test("a valid high finding is not lost when a low-severity one is misplaced in the blocking section", async () => {
		await loadAll();
		const outcome = (await vote(`FAIL\n${finding("数据丢失")}\n\n## 发现 2\n- 严重程度: 低\n- 问题: 命名\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: z`));
		expect(outcome.status).toBe("failed");
		expect(outcome.details).toContain("数据丢失");
		// 说明点名真实原因：严重程度写了但不是高/中，而不是“缺少严重程度”。
		expect(outcome.details).toContain("严重程度是「低」");
	});

	test("a well-formed FAIL has no format note", async () => {
		await loadAll();
		expect((await vote(`FAIL\n${finding("x")}`)).details).not.toContain("格式契约");
	});

	test("accepts a finding whose field values start on the next line", async () => {
		await loadAll();
		const multilineBody = `FAIL\n## 发现 1：结算态丢失完整结果\n- **严重程度**: 高\n- **问题**:\n大屏仍只显示标题，不展示这段核心问题说明。\n- **违反的约定与期望行为**:\n应按预算展示自然语言结果。\n- **证据**:\nreview/ui.ts\n- **验证命令**:\nbun test`;
		const outcome = (await vote(multilineBody));
		expect(outcome.details).not.toContain("格式契约");
		expect(outcome.summary).toBe("大屏仍只显示标题，不展示这段核心问题说明。");

		const multilineEn = `FAIL\n## Finding 1\n- Severity: High\n- Issue:\nissue description\n- Violated agreement & expected behavior:\ncontract details\n- Evidence:\na.ts\n- Verification command:\nbun test`;
		const outcomeEn = (await vote(multilineEn));
		expect(outcomeEn.details).not.toContain("格式契约");
		expect(outcomeEn.summary).toBe("issue description");
	});

	test("suggestions below the blocking section are not contract-checked", async () => {
		await loadAll();
		const outcome = (await vote(`FAIL\n${finding("真发现")}\n\n## 建议（非阻塞）\n- 随手写的建议`));
		expect(outcome.details).not.toContain("格式契约");
	});

	test("severity and field decoration is tolerated; full-width punctuation and the English contract are accepted", async () => {
		await loadAll();
		const clean = async (body: string) => (await vote(body)).details.includes("格式契约");
		const tail = ["- 问题: x", "- 证据: a.ts", "- 违反的约定与期望行为: y", "- 验证命令: bun test"].join("\n");
		for (const severity of ["- 严重程度: 高", "- 严重程度: **高**", "- **严重程度：** 高", "- 严重程度: 高危", "- 严重程度: 高。", "- 严重程度: 高（直接导致需求未满足）", "- 严重程度：中"])
			expect(`${severity}:${await clean(`FAIL\n## 发现 1\n${severity}\n${tail}`)}`).toBe(`${severity}:false`);
		expect(await clean("FAIL\n## 发现 1\n- 严重程度：中\n- 问题：x\n- 证据：a.ts\n- 违反的约定与期望行为：y\n- 验证命令：bun test")).toBe(false);
		expect(await clean("FAIL\n## Finding 1\n- Severity: Medium\n- Issue: x\n- Evidence: a.ts\n- Violated agreement & expected behavior: y\n- Verification command: bun test")).toBe(false);
	});
});

test("总结回合的材料超长时写明省略了多少字，不留裸省略号", async () => {
	const { buildSummaryPrompt } = await loadFirecodeModule("review/prompt.js") as any;
	const prompt = buildSummaryPrompt({ kind: "passed", rounds: 2, material: "结论".repeat(3_000) });
	expect(prompt).toMatch(/材料截断：省略 2000 字/u);
	expect(prompt).not.toMatch(/\n…\n/u);
});
