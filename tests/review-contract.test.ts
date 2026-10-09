import { describe, expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

type ParseReview = typeof import("../review/reviewer.js").parseReviewOutput;
type ParseAdvisor = typeof import("../review/advisor.js").parseAdvisorOutput;
type BuildEvidence = typeof import("../review/evidence.js").buildEvidence;

let parseReview: ParseReview;
let parseAdvisor: ParseAdvisor;
let buildEvidence: BuildEvidence;

async function loadAll() {
	const review = (await loadFirecodeModule("review/reviewer.js")) as {
		parseReviewOutput: ParseReview;
	};
	const advisor = (await loadFirecodeModule("review/advisor.js")) as {
		parseAdvisorOutput: ParseAdvisor;
	};
	const evidence = (await loadFirecodeModule("review/evidence.js")) as {
		buildEvidence: BuildEvidence;
	};
	parseReview = review.parseReviewOutput;
	parseAdvisor = advisor.parseAdvisorOutput;
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
		for (const first of ["PASS", "**PASS**", "__PASS__", "`PASS`", "  pass  "])
			expect(`${first}:${parseReview(first + body).status}`).toBe(`${first}:passed`);
		expect(parseReview("**FAIL**\n" + finding("x")).status).toBe("failed");
		expect(parseReview("maybe" + body).status).toBe("error");
	});

	test("PASS whose only pre-evidence line is the suggestions heading is a contract violation", async () => {
		await loadAll();
		// 曾让 summary=undefined 流进多模型汇总对 undefined 调 replace，审查循环悬挂到超时。
		const result = parseReview("PASS\n## 建议（非阻塞）\n证据：文件=a.ts；命令=bun test");
		expect(result.status).toBe("error");
		expect(result.details).toContain("缺少摘要行");
	});

	test("PASS requires summary + evidence anchor line with files and commands", async () => {
		await loadAll();
		const ok = parseReview(
			"PASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=src/auth.ts；命令=npm test",
		);
		expect(ok.status).toBe("passed");
		expect(ok.summary).toBe("验证命令 exit 0，核心逻辑已核对。");
		const missingEvidence = parseReview("PASS\n没有证据行");
		expect(missingEvidence.status).toBe("error");
		const missingSummary = parseReview(
			"PASS\n证据：文件=src/auth.ts；命令=npm test",
		);
		expect(missingSummary.status).toBe("error");
		const missingCommand = parseReview(
			"PASS\nok\n证据：文件=src/auth.ts；命令=",
		);
		expect(missingCommand.status).toBe("error");
	});

	test("FAIL keeps the findings as details and pulls a one-line issue for the summary", async () => {
		await loadAll();
		const parsed = parseReview(`FAIL\n${finding("auth 没校验")}`);
		expect(parsed.status).toBe("failed");
		expect(parsed.summary).toBe("auth 没校验");
		expect(parsed.details).toContain("发现 1");
	});

	test("a non-PASS/FAIL first line or empty output is rejected as invalid format", async () => {
		await loadAll();
		const parsed = parseReview("结论如下\n随便写");
		expect(parsed.status).toBe("error");
		expect(parsed.details).toContain("格式无效");
		expect(parseReview("").status).toBe("error");
	});
});

describe("advisor verdict parsing", () => {
	test("parses continue/stop/narrow on the first line", async () => {
		await loadAll();
		expect(parseAdvisor("continue\n继续修")).toEqual({ verdict: "continue", advice: "继续修" });
		expect(parseAdvisor("stop\n别修了").verdict).toBe("stop");
		expect(parseAdvisor("narrow\n收窄范围").verdict).toBe("narrow");
		expect(parseAdvisor("**stop**").verdict).toBe("stop");
	});

	test("tolerates a model preamble before the verdict line and keeps it as advice", async () => {
		await loadAll();
		// fable 实际产出过的形状：前言句 + 裁决行 + 正文。
		expect(parseAdvisor("我已核实关键文件与 Pi 类型定义，裁决如下。\ncontinue\n核实结论：发现属实")).toEqual({
			verdict: "continue",
			advice: "我已核实关键文件与 Pi 类型定义，裁决如下。\n核实结论：发现属实",
		});
		// 正文里出现的裁决词不得被误识别：扫描只覆盖前几个非空行。
		const body = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段分析`).join("\n");
		expect(parseAdvisor(`${body}\nstop`).verdict).toBe("continue");
	});

	test("accepts an unambiguous verdict wrapped by markdown or a verdict label", async () => {
		await loadAll();
		expect(parseAdvisor("```text\nstop\n别修了\n```")).toEqual({
			verdict: "stop",
			advice: "别修了",
		});
		expect(parseAdvisor("裁决：narrow\n只修阻塞项")).toEqual({
			verdict: "narrow",
			advice: "只修阻塞项",
		});
		expect(parseAdvisor("Verdict: continue\nkeep fixing")).toEqual({
			verdict: "continue",
			advice: "keep fixing",
		});
		// 提示词里裁决词带反引号展示，模型照抄是真实发生过的解析失败根因。
		expect(parseAdvisor("`stop`\n别修了")).toEqual({
			verdict: "stop",
			advice: "别修了",
		});
		expect(parseAdvisor("裁决：`narrow`\n只修阻塞项").verdict).toBe("narrow");
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
			const result = parseAdvisor(output);
			expect(`${output}:${result.verdict}`).toBe(`${output}:continue`);
			expect(result.advice).toContain("无法解析");
		}
	});

	test("advisor session failure is infrastructure error, not continue", async () => {
		const { runAdvisor } = (await loadFirecodeModule("review/advisor.js")) as {
			runAdvisor: (options: Record<string, unknown>) => Promise<unknown>;
		};
		await expect(runAdvisor({
			config: { model: "p/m", thinking: "low", tools: [], timeoutMs: 1_000 },
			prompt: { system: "policy", user: "input" },
			cwd: process.cwd(),
			runSession: async () => ({ kind: "error", message: "auth failed" }),
		})).rejects.toThrow("顾问会话不可用");
	});
});

describe("evidence assembly", () => {
	function user(text: string) {
		return { type: "message", message: { role: "user", content: text } };
	}
	function assistant(text: string) {
		return { type: "message", message: { role: "assistant", content: text } };
	}
	function toolResult() {
		return { type: "message", message: { role: "toolResult", content: "big output" } };
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

	test("toolResult entries are skipped entirely", async () => {
		await loadAll();
		const entries = [user("需求"), assistant("改完"), toolResult()];
		const text = buildEvidence(entries);
		expect(text).not.toContain("big output");
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
	// FAIL 曾不做任何校验：空正文或一段散文都会被当成有效缺陷，
	// 驱动执行模型去改代码。格式非法的票必须作废为基础设施错误。
	test("rejects a FAIL without any blocking finding", async () => {
		await loadAll();
		for (const body of [
			"FAIL",
			"FAIL\nnot a finding",
			"FAIL\n## 建议（非阻塞）\n- 问题: 可以更好",
			"FAIL\n- 严重程度: 中\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: z", // 字段齐全但没有「## 发现」小节标题
		]) {
			const outcome = parseReview(body);
			expect(`${body.slice(0, 12)}:${outcome.status}`).toBe(`${body.slice(0, 12)}:error`);
			expect(outcome.details).toContain("FAIL 缺少阻塞发现");
		}
	});

	test("accepts a finding whose field values start on the next line", async () => {
		await loadAll();
		const multilineBody = `FAIL\n## 发现 1：结算态丢失完整结果\n- **严重程度**: 高\n- **问题**:\n大屏仍只显示标题，不展示这段核心问题说明。\n- **违反的约定与期望行为**:\n应按预算展示自然语言结果。\n- **证据**:\nreview/ui.ts\n- **验证命令**:\nbun test`;
		const outcome = parseReview(multilineBody);
		expect(outcome.status).toBe("failed");
		expect(outcome.summary).toBe("大屏仍只显示标题，不展示这段核心问题说明。");

		const multilineEn = `FAIL\n## Finding 1\n- Severity: High\n- Issue:\nissue description\n- Violated agreement & expected behavior:\ncontract details\n- Evidence:\na.ts\n- Verification command:\nbun test`;
		const outcomeEn = parseReview(multilineEn);
		expect(outcomeEn.status).toBe("failed");
		expect(outcomeEn.summary).toBe("issue description");
	});

	// 契约以 prompts/review.{zh,en}.md 为唯一事实源：每条发现六要素齐全才可驱动修复，
	// 缺任一字段的半成品票无法核实也无法验收，一律作废为基础设施错误。
	test("rejects a finding missing any required field", async () => {
		await loadAll();
		const fields = ["- 严重程度: 中", "- 问题: x", "- 证据: a.ts", "- 违反的约定与期望行为: y", "- 验证命令: bun test"];
		for (const [index, dropped] of fields.entries()) {
			const body = ["## 发现 1", ...fields.filter((_, at) => at !== index)].join("\n");
			const outcome = parseReview(`FAIL\n${body}`);
			expect(`${dropped}:${outcome.status}`).toBe(`${dropped}:error`);
			expect(outcome.details).toContain("缺少必填字段");
		}
	});

	// 同票混入非法发现整票作废：放行会让执行模型照着半成品条目改代码。
	test("rejects the whole ticket when any finding is malformed", async () => {
		await loadAll();
		const outcome = parseReview(`FAIL\n${finding("完整的")}\n\n## 发现 2\n- 问题: 只有问题`);
		expect(outcome.status).toBe("error");
		expect(outcome.details).toContain("第 2 条发现");
	});

	test("suggestions below the blocking section are not contract-checked", async () => {
		await loadAll();
		const outcome = parseReview(
			`FAIL\n${finding("真发现")}\n\n## 建议（非阻塞）\n- 随手写的建议`,
		);
		expect(outcome.status).toBe("failed");
	});

	// 提示词规定低严重度只进建议区、不驱动修复循环。
	test("rejects a low-severity finding as a blocking one", async () => {
		await loadAll();
		const outcome = parseReview(
			"FAIL\n## 发现 1\n- 严重程度: 低\n- 问题: x\n- 证据: a.ts\n- 违反的约定与期望行为: y\n- 验证命令: bun test",
		);
		expect(outcome.status).toBe("error");
		expect(outcome.details).toContain("严重程度");
	});

	test("accepts full-width punctuation and the English contract", async () => {
		await loadAll();
		const zh = parseReview(
			"FAIL\n## 发现 1\n- 严重程度：中\n- 问题：x\n- 证据：a.ts\n- 违反的约定与期望行为：y\n- 验证命令：bun test",
		);
		expect(zh.status).toBe("failed");
		const en = parseReview(
			"FAIL\n## Finding 1\n- Severity: Medium\n- Issue: x\n- Evidence: a.ts\n- Violated agreement & expected behavior: y\n- Verification command: bun test",
		);
		expect(en.status).toBe("failed");
	});
});

test("总结回合的材料超长时写明省略了多少字，不留裸省略号", async () => {
	const { buildSummaryPrompt } = await loadFirecodeModule("review/prompt.js") as any;
	const prompt = buildSummaryPrompt({ kind: "passed", rounds: 2, material: "结论".repeat(3_000) });
	expect(prompt).toMatch(/材料截断：省略 2000 字/u);
	expect(prompt).not.toMatch(/\n…\n/u);
});
