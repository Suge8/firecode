import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type ParseReview = typeof import("../review/reviewer.js").parseReviewOutput;
type Verdict = typeof import("../review/reviewer.js").verdictOf;
type ParseAdvisor = typeof import("../review/advisor.js").parseAdvisorOutput;
type BuildEvidence = typeof import("../review/evidence.js").buildEvidence;

let parseReview: ParseReview;
let verdictOf: Verdict;
let parseAdvisor: ParseAdvisor;
let buildEvidence: BuildEvidence;

async function loadAll() {
	const review = (await loadFirecodeModule("review/reviewer.js")) as {
		parseReviewOutput: ParseReview;
		verdictOf: Verdict;
	};
	const advisor = (await loadFirecodeModule("review/advisor.js")) as {
		parseAdvisorOutput: ParseAdvisor;
	};
	const evidence = (await loadFirecodeModule("review/evidence.js")) as {
		buildEvidence: BuildEvidence;
	};
	parseReview = review.parseReviewOutput;
	verdictOf = review.verdictOf;
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
		"- 违反的契约或期望行为: 终态必须可持久化",
		"- 需要运行的验证命令: bun test",
	].join("\n");
}

afterEach(cleanupFirecodeModules);

describe("PASS/FAIL output contract", () => {
	test("verdictOf tolerates markdown bold around the verdict", async () => {
		await loadAll();
		expect(verdictOf("PASS")).toBe("PASS");
		expect(verdictOf("**FAIL**")).toBe("FAIL");
		expect(verdictOf("__PASS__")).toBe("PASS");
		expect(verdictOf("  fail  ")).toBe("FAIL");
		expect(verdictOf("maybe")).toBeUndefined();
	});

	test("PASS requires summary + evidence anchor line with files and commands", async () => {
		await loadAll();
		const ok = parseReview(
			"PASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=src/auth.ts；命令=npm test",
			"zh",
		);
		expect(ok.status).toBe("passed");
		expect(ok.summary).toBe("验证命令 exit 0，核心逻辑已核对。");
		const missingEvidence = parseReview("PASS\n没有证据行", "zh");
		expect(missingEvidence.status).toBe("error");
		const missingSummary = parseReview(
			"PASS\n证据：文件=src/auth.ts；命令=npm test",
			"zh",
		);
		expect(missingSummary.status).toBe("error");
		const missingCommand = parseReview(
			"PASS\nok\n证据：文件=src/auth.ts；命令=",
			"zh",
		);
		expect(missingCommand.status).toBe("error");
	});

	test("FAIL keeps the findings as details and pulls a one-line issue for the summary", async () => {
		await loadAll();
		const parsed = parseReview(
			`FAIL\n${finding("auth 没校验")}`,
			"zh",
		);
		expect(parsed.status).toBe("failed");
		expect(parsed.summary).toBe("auth 没校验");
		expect(parsed.details).toContain("发现 1");
	});

	test("a non-PASS/FAIL first line is rejected as invalid format", async () => {
		await loadAll();
		const parsed = parseReview("结论如下\n随便写", "zh");
		expect(parsed.status).toBe("error");
		expect(parsed.details).toContain("格式无效");
	});

	test("empty output is a format error", async () => {
		await loadAll();
		expect(parseReview("", "zh").status).toBe("error");
	});
});

describe("advisor verdict parsing", () => {
	test("parses continue/stop/narrow on the first line", async () => {
		await loadAll();
		expect(parseAdvisor("continue\n继续修", "zh")).toEqual({ verdict: "continue", advice: "继续修" });
		expect(parseAdvisor("stop\n别修了", "zh").verdict).toBe("stop");
		expect(parseAdvisor("narrow\n收窄范围", "zh").verdict).toBe("narrow");
		expect(parseAdvisor("**stop**", "zh").verdict).toBe("stop");
	});

	test("unparseable advisor output falls back to continue (never kills the loop)", async () => {
		await loadAll();
		const result = parseAdvisor("我不确定\n随便", "zh");
		expect(result.verdict).toBe("continue");
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

	test("the first user message is always kept, even under a tiny budget", async () => {
		await loadAll();
		const entries = [user("原始需求：加登录"), assistant("改了很久"), toolResult()];
		const { text, omitted } = buildEvidence(entries, "zh", 30);
		expect(text).toContain("原始需求：加登录");
		expect(text).toContain("改了很久");
		expect(omitted).toBe(0);
	});

	test("budget clips older middle messages but keeps the newest work", async () => {
		await loadAll();
		const entries = [user("原始需求"), assistant("中间 1"), assistant("中间 2"), assistant("最新改动")];
		const { text, omitted } = buildEvidence(entries, "zh", 20);
		expect(text).toContain("原始需求");
		expect(text).toContain("最新改动");
		expect(omitted).toBeGreaterThan(0);
		expect(text).toContain("省略");
	});

	test("toolResult entries are skipped entirely", async () => {
		await loadAll();
		const entries = [user("需求"), assistant("改完"), toolResult()];
		const { text } = buildEvidence(entries, "zh");
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
		const { text, omitted } = buildEvidence(entries, "zh", 60);
		expect(text).toContain("原始需求锚点");
		expect(text).toContain("最新改动");
		expect(omitted).toBeGreaterThan(0);
	});
});

describe("FAIL output contract", () => {
	// FAIL 曾不做任何校验：空正文或一段散文都会被当成有效缺陷，
	// 驱动执行模型去改代码。格式非法的票必须作废为基础设施错误。
	test("rejects a FAIL without any blocking finding", async () => {
		await loadAll();
		for (const body of ["FAIL", "FAIL\nnot a finding", "FAIL\n## 建议（非阻塞）\n- 问题: 可以更好"]) {
			const outcome = parseReview(body, "zh");
			expect(`${body.slice(0, 12)}:${outcome.status}`).toBe(`${body.slice(0, 12)}:error`);
			expect(outcome.details).toContain("FAIL 缺少阻塞发现");
		}
	});

	test("accepts a FAIL carrying a structured finding", async () => {
		await loadAll();
		const outcome = parseReview(`FAIL\n${finding("校验漏字段")}`, "zh");
		expect(outcome.status).toBe("failed");
		expect(outcome.summary).toBe("校验漏字段");
	});

	// 契约以 prompts/review.{zh,en}.md 为唯一事实源：每条发现六要素齐全才可驱动修复，
	// 缺任一字段的半成品票无法核实也无法验收，一律作废为基础设施错误。
	test("rejects a finding missing any required field", async () => {
		await loadAll();
		const fields = ["- 严重程度: 中", "- 问题: x", "- 证据: a.ts", "- 违反的契约或期望行为: y", "- 需要运行的验证命令: bun test"];
		for (const [index, dropped] of fields.entries()) {
			const body = ["## 发现 1", ...fields.filter((_, at) => at !== index)].join("\n");
			const outcome = parseReview(`FAIL\n${body}`, "zh");
			expect(`${dropped}:${outcome.status}`).toBe(`${dropped}:error`);
			expect(outcome.details).toContain("缺少必填字段");
		}
	});

	test("rejects a finding without the section heading", async () => {
		await loadAll();
		const outcome = parseReview(
			"FAIL\n- 严重程度: 中\n- 问题: x\n- 证据: a.ts\n- 违反的契约或期望行为: y\n- 需要运行的验证命令: z",
			"zh",
		);
		expect(outcome.status).toBe("error");
		expect(outcome.details).toContain("缺少阻塞发现");
	});

	// 同票混入非法发现整票作废：放行会让执行模型照着半成品条目改代码。
	test("rejects the whole ticket when any finding is malformed", async () => {
		await loadAll();
		const outcome = parseReview(`FAIL\n${finding("完整的")}\n\n## 发现 2\n- 问题: 只有问题`, "zh");
		expect(outcome.status).toBe("error");
		expect(outcome.details).toContain("第 2 条发现");
	});

	test("suggestions below the blocking section are not contract-checked", async () => {
		await loadAll();
		const outcome = parseReview(
			`FAIL\n${finding("真发现")}\n\n## 建议（非阻塞）\n- 随手写的建议`,
			"zh",
		);
		expect(outcome.status).toBe("failed");
	});

	// 提示词规定低严重度只进建议区、不驱动修复循环。
	test("rejects a low-severity finding as a blocking one", async () => {
		await loadAll();
		const outcome = parseReview(
			"FAIL\n## 发现 1\n- 严重程度: 低\n- 问题: x\n- 证据: a.ts\n- 违反的契约或期望行为: y\n- 需要运行的验证命令: bun test",
			"zh",
		);
		expect(outcome.status).toBe("error");
		expect(outcome.details).toContain("严重程度");
	});

	test("accepts full-width punctuation and the English contract", async () => {
		await loadAll();
		const zh = parseReview(
			"FAIL\n## 发现 1\n- 严重程度：中\n- 问题：x\n- 证据：a.ts\n- 违反的契约或期望行为：y\n- 需要运行的验证命令：bun test",
			"zh",
		);
		expect(zh.status).toBe("failed");
		const en = parseReview(
			"FAIL\n## Finding 1\n- Severity: Medium\n- Issue: x\n- Evidence: a.ts\n- Contract or expected behavior violated: y\n- Verification command to run: bun test",
			"en",
		);
		expect(en.status).toBe("failed");
	});
});

describe("review config strictness", () => {
	test("reports nested unknown keys and type errors instead of silently defaulting", async () => {
		const { parseReviewConfig } = (await loadFirecodeModule("config.js")) as {
			parseReviewConfig: (
				raw: Record<string, unknown>,
				problems: string[],
			) => { tools: string[]; background: { command: string } };
		};
		const problems: string[] = [];
		parseReviewConfig(
			{
				advisor: { model: "p/m", thinkig: "max" },
				reviewers: [{ model: "p/r", thinking: "high", extra: 1 }],
				background: { cmd: "pi" },
				tools: "read",
			},
			problems,
		);
		expect(problems).toContain("未知字段 review.advisor.thinkig");
		expect(problems).toContain("未知字段 review.reviewers[0].extra");
		expect(problems).toContain("未知字段 review.background.cmd");
		expect(problems).toContain("review.tools 必须是字符串数组");
	});

	test("a fully valid review section reports no problems", async () => {
		const { parseReviewConfig } = (await loadFirecodeModule("config.js")) as {
			parseReviewConfig: (raw: Record<string, unknown>, problems: string[]) => unknown;
		};
		const problems: string[] = [];
		parseReviewConfig(
			{
				advisor: { model: "p/a", thinking: "max" },
				reviewers: [{ model: "p/r", thinking: "high" }],
				maxRounds: 5,
				advisorAfterFailures: 2,
				timeoutMinutes: 20,
				tools: ["read", "bash"],
				background: { command: "pi" },
				language: "zh",
			},
			problems,
		);
		expect(problems).toEqual([]);
	});
});

describe("review section top-level type", () => {
	// review 写成字符串/数组/null 时曾被静默当成空对象，于是全套默认模型上阵。
	test("a non-object review section is reported instead of silently defaulting", async () => {
		for (const bad of ['"typo"', "[]", "null", "3"]) {
			const module = (await loadFirecodeModule("config.js", {
				configJsonc: `{ "review": ${bad} }`,
			})) as { loadConfig: () => { problems: string[] } };
			const { problems } = module.loadConfig();
			expect(`${bad}:${problems.some((item) => item.startsWith("review"))}`).toBe(`${bad}:true`);
		}
	});

	test("an object review section produces no top-level problem", async () => {
		const module = (await loadFirecodeModule("config.js", {
			configJsonc: `{ "review": { "maxRounds": 3 } }`,
		})) as { loadConfig: () => { problems: string[] } };
		expect(module.loadConfig().problems.filter((item) => item.startsWith("review"))).toEqual([]);
	});
});

describe("feature switch types", () => {
	// features.review 写成字符串 "false" 时因 `!== false` 仍会启用，
	// 而启用 review 意味着真实模型调用，必须报出来而不是静默放行。
	test("a non-boolean feature switch is reported", async () => {
		const module = (await loadFirecodeModule("config.js", {
			configJsonc: `{ "features": { "review": "false" } }`,
		})) as { loadConfig: () => { problems: string[] } };
		expect(module.loadConfig().problems.join()).toContain("features.review 必须是 true 或 false");
	});

	test("boolean switches produce no problem", async () => {
		const module = (await loadFirecodeModule("config.js", {
			configJsonc: `{ "features": { "review": false } }`,
		})) as { loadConfig: () => { problems: string[] } };
		expect(module.loadConfig().problems.filter((item) => item.startsWith("features"))).toEqual([]);
	});
});
