import { describe, expect, test } from "bun:test";
import type { ReviewLimits, ReviewState, ReviewerResult } from "../review/state.js";
import { loadFirecodeModule } from "./loader.ts";

type Reduce = typeof import("../review/state.js").reduce;
type InitialState = typeof import("../review/state.js").initialState;
type ReviewEvent = import("../review/state.js").ReviewEvent;
type IsValidCheckpoint = typeof import("../review/checkpoint.js").isValidCheckpoint;

let reduce: Reduce;
let initialState: InitialState;
let isValidCheckpoint: IsValidCheckpoint;

const LIMITS: ReviewLimits = {
	maxRounds: 3,
	advisorAfterFailures: 2,
	advisor: { model: "p/advisor", thinking: "high" },
	reviewers: [
		{ model: "p/sol", thinking: "high" },
		{ model: "p/terra", thinking: "high" },
	],
};

function reviewer(index: number, status: ReviewerResult["status"], details: string): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary: "s", details };
}

// 每一步产出的状态都必须能写进 checkpoint：校验键表与领域类型漂移时，终态写不进去，重启后会恢复出幽灵审查。
const step = (state: ReviewState, event: ReviewEvent, limits = LIMITS, now = 10_000) => {
	const result = reduce(state, event, limits, now);
	expect(`${event.type}:${isValidCheckpoint({ version: 5, seq: 1, ...result.state })}`).toBe(`${event.type}:true`);
	return result;
};

/** 命令入口的真实路径：START 一律排队，ADVANCE 在 idle 门开第 1 轮。 */
function begin(limits = LIMITS, focus = ""): ReviewState {
	const queued = step(initialState("g"), { type: "START", focus }, limits, 1000).state;
	return step(queued, { type: "ADVANCE" }, limits, 1000).state;
}

function settle(state: ReviewState, index: number, status: ReviewerResult["status"], details = "d", limits = LIMITS) {
	return step(state, { type: "REVIEWER_SETTLED", index, result: reviewer(index, status, details) }, limits, 10_000 + index);
}

/** 两个审查者都判 FAIL：返回修复回合等待中的状态。 */
function failRound(state: ReviewState, limits = LIMITS): ReviewState {
	return settle(settle(state, 0, "failed", "FAIL\n发现 1", limits).state, 1, "failed", "FAIL\n发现 2", limits).state;
}

function completeRepair(state: ReviewState, limits = LIMITS, now = 20_000): ReviewState {
	state = step(state, { type: "FEEDBACK_DISPATCHED" }, limits, now - 3).state;
	state = step(state, { type: "REPAIR_STARTED" }, limits, now - 2).state;
	return step(state, { type: "REPAIR_COMPLETED" }, limits, now - 1).state;
}

/** 连败两轮，进入等顾问仲裁的 needs_fix。 */
function needsAdvisor(): ReviewState {
	const second = step(completeRepair(failRound(begin())), { type: "ADVANCE" }, LIMITS, 20_000).state;
	const state = failRound(second);
	expect(state.phase).toBe("needs_fix");
	return state;
}

function passCard(effect: unknown): { summary: string } | undefined {
	const card = (effect as { kind: string; card?: { kind: string; summary: string } }).card;
	return card?.kind === "pass" ? card : undefined;
}

async function loadState() {
	const module = (await loadFirecodeModule("review/state.ts")) as {
		reduce: Reduce;
		initialState: InitialState;
	};
	reduce = module.reduce;
	initialState = module.initialState;
	isValidCheckpoint = ((await loadFirecodeModule("review/checkpoint.ts")) as { isValidCheckpoint: IsValidCheckpoint }).isValidCheckpoint;
}

describe("fire-review reducer", () => {
	test("START queues silently; ADVANCE opens round 1 with the start card and reviewers", async () => {
		await loadState();
		const queued = step(initialState("g"), { type: "START", focus: "审 auth" }, LIMITS, 1000);
		expect(queued.state).toMatchObject({ phase: "queued", round: 0, focus: "审 auth" });
		// 排队不发卡：输入框边框已有提示，记录只留开始/结果卡。
		expect(queued.effects).toEqual([{ kind: "advance" }]);

		const result = step(queued.state, { type: "ADVANCE" }, LIMITS, 2000);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.round).toBe(1);
		expect(result.state.active?.reviewers).toHaveLength(2);
		expect(result.effects).toEqual([
			{ kind: "send_card", card: { kind: "start", models: ["p/sol", "p/terra"] } },
			{ kind: "advance" },
		]);
	});

	test("all reviewers pass records the round then runs a summary turn before settling", async () => {
		await loadState();
		let state = begin();
		state = settle(state, 0, "passed", "PASS\n验证命令 exit 0\n证据：文件=a.ts；命令=ls").state;
		const result = settle(state, 1, "passed", "PASS\nok\n证据：文件=b.ts；命令=cat b.ts");
		// 质量裁决终态先进总结相：结果卡照发，总结回合结束才 settled。
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "passed", status: "pending" });
		expect(result.state.history).toHaveLength(1);
		expect(result.state.history[0].result).toBe("passed");
		expect(result.state.history[0].reviewers).toHaveLength(2);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "pass", summary: "• m0：s\n• m1：s" } },
			{ kind: "advance" },
		]);
		// 总结生命周期：投递 → 回合启动 → 回合结束 → settled，中途状态均可持久化。
		let current = step(result.state, { type: "SUMMARY_DISPATCHED" }, LIMITS, 4000).state;
		expect(current.summary?.status).toBe("awaiting_start");
		current = step(current, { type: "SUMMARY_STARTED" }, LIMITS, 5000).state;
		expect(current.summary?.status).toBe("running");
		const settledResult = step(current, { type: "SUMMARY_SETTLED" }, LIMITS, 6000);
		expect(settledResult.state.phase).toBe("settled");
		expect(settledResult.state.summary).toBeNull();
		expect(settledResult.effects).toEqual([]);
	});

	test("RECOVER re-arms an interrupted summary turn; CANCEL during summarizing settles quietly", async () => {
		await loadState();
		let state = begin();
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		state = settle(state, 1, "passed", "PASS\n证据：文件=b.ts；命令=ls").state;
		state = step(state, { type: "SUMMARY_DISPATCHED" }, LIMITS, 4000).state;
		state = step(state, { type: "SUMMARY_STARTED" }, LIMITS, 5000).state;
		// reload 中断未完成的总结回合 → 重置 pending 重投。
		const recovered = step(state, { type: "RECOVER" }, LIMITS, 6000).state;
		expect(recovered.phase).toBe("summarizing");
		expect(recovered.summary).toEqual({ kind: "passed", status: "pending" });
		// 取消/退出：裁决与结果卡已落地，静默收尾，不追加轮记录不发卡。
		const cancelled = step(recovered, { type: "CANCEL", reason: "user" }, LIMITS, 7000);
		expect(cancelled.state.phase).toBe("settled");
		expect(cancelled.state.history).toHaveLength(1);
		expect(cancelled.state.history[0].result).toBe("passed");
		expect(cancelled.effects).toEqual([]);
	});

	test("PASS summaries keep non-blocking suggestions (deduplicated across reviewers) and drop evidence", async () => {
		await loadState();
		const one: ReviewLimits = { ...LIMITS, reviewers: [LIMITS.reviewers[0]] };
		const single = step(begin(one), {
			type: "REVIEWER_SETTLED",
			index: 0,
			result: {
				...reviewer(0, "passed", "核心逻辑已核对\n证据：文件=a.ts；命令=bun test\n## 建议（非阻塞）\n- 清理命名"),
				summary: "核心逻辑已核对",
			},
		}, one, 2000);
		const singleSummary = passCard(single.effects[0])?.summary ?? "";
		expect(singleSummary).toContain("核心逻辑已核对");
		expect(singleSummary).toContain("## 建议（非阻塞）\n- 清理命名");
		expect(singleSummary).not.toContain("证据：");

		let state = step(begin(), {
			type: "REVIEWER_SETTLED",
			index: 0,
			result: { ...reviewer(0, "passed", "ok\n## 建议（非阻塞）\n- 清理命名"), summary: "核心逻辑已核对" },
		}, LIMITS, 2000).state;
		const multi = step(state, {
			type: "REVIEWER_SETTLED",
			index: 1,
			result: { ...reviewer(1, "passed", "ok\n## 建议（非阻塞）\n- 清理命名"), summary: "测试已通过" },
		}, LIMITS, 3000);
		const multiSummary = passCard(multi.effects[0])?.summary ?? "";
		expect(multiSummary).toContain("• m0：核心逻辑已核对");
		expect(multiSummary.match(/清理命名/gu)).toHaveLength(1);
	});

	test("a later PASS card recaps findings closed since prior failed rounds", async () => {
		await loadState();
		let state = settle(begin(), 0, "failed", "FAIL\n## 发现 1\n- 问题: stale lock").state;
		state = settle(state, 1, "passed", "PASS\nok").state;
		state = step(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "passed", "PASS\nok").state;
		const summary = passCard(settle(state, 1, "passed", "PASS\nok").effects[0])?.summary ?? "";
		expect(summary).toContain("**本次收口的问题**：");
		expect(summary).toContain("• stale lock（第 1 轮）");
	});

	test("any FAIL records the round and requests guarded advancement with the failing votes only", async () => {
		await loadState();
		const state = settle(begin(), 0, "failed", "FAIL\n发现 1").state;
		const result = settle(state, 1, "passed", "PASS\n证据：文件=a.ts；命令=ls");
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[0].result).toBe("failed");
		// 失败轮先发可见卡，再由统一 barrier 投隐藏反馈。
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 1 } },
			{ kind: "advance" },
		]);
		const card = result.effects[0] as { card: { details: string } };
		expect(card.card.details).toContain("模型 1 · m0");
		expect(card.card.details).toContain("模型 2 · m1");
		expect(result.state.repair?.details).toContain("模型 1 · m0");
		expect(result.state.repair?.details).not.toContain("模型 2 · m1");
	});

	test("failures reaching the threshold hand the round to the advisor", async () => {
		await loadState();
		const next = step(completeRepair(failRound(begin())), { type: "ADVANCE" }, LIMITS, 20_000);
		const second = next.state;
		expect(second).toMatchObject({ phase: "reviewing", round: 2 });
		expect(second.history).toHaveLength(1);
		// 开始卡只发第 1 轮；后续轮的边界由结果卡轮号承担。
		expect(next.effects).toEqual([{ kind: "advance" }]);
		const result = settle(settle(second, 0, "failed", "FAIL\n发现 3").state, 1, "failed", "FAIL\n发现 4");
		expect(result.state.phase).toBe("needs_fix");
		expect(result.state.consecutiveFailures).toBe(2);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 2 } },
			{ kind: "advance" },
		]);
	});

	// narrow 与 continue 在 reducer 层同样投反馈；两者的差别在反馈文本的范围约束，由 review-card-checkpoint 的 prompt 用例把守。
	test.each(["continue", "narrow"] as const)("advisor %s sends the advisor card and goes on to repair", async (verdict) => {
		await loadState();
		const result = step(needsAdvisor(), { type: "ADVISOR_SETTLED", result: { verdict, advice: "建议" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[1].advisor?.verdict).toBe(verdict);
		expect(result.state.repair?.advisor?.verdict).toBe(verdict);
		// 失败卡已在咨询前可见；咨询完成补中性的顾问建议卡。
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "advisor", advisor: { verdict }, advisorModel: "p/advisor" } },
			{ kind: "advance" },
		]);
	});

	test("skipping advisor continues to repair without cancelling the review", async () => {
		await loadState();
		const result = step(needsAdvisor(), { type: "ADVISOR_SKIPPED" }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.repair?.advisor).toBeNull();
		expect(result.effects).toEqual([{ kind: "advance" }]);
	});

	test("advisor stop settles the review as stopped", async () => {
		await loadState();
		const result = step(needsAdvisor(), { type: "ADVISOR_SETTLED", result: { verdict: "stop", advice: "别修了" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "advisor_stop", status: "pending" });
		expect(result.state.history).toHaveLength(2);
		expect(result.state.history[1].result).toBe("stopped");
		// 本轮 findings 已在咨询前显示；终止卡只给顾问裁决，不能重复整张失败报告。
		// elapsedMs 是咨询时长（进入顾问相 → 裁决），与顾问建议卡同一语义；轮时长已在失败卡显示。
		const consultStart = needsAdvisor().updatedAt;
		expect(result.effects).toEqual([
			{
				kind: "send_card",
				card: {
					kind: "stop",
					reason: "advisor",
					round: 2,
					details: "别修了",
					advisor: { verdict: "stop", advice: "别修了" },
					advisorModel: "p/advisor",
					elapsedMs: 30_000 - consultStart,
				},
			},
			{ kind: "advance" },
		]);
	});

	test("a FAIL at the max round goes straight to the summary turn without delivering feedback", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		const state = settle(settle(begin(local), 0, "failed", "FAIL\n发现 1", local).state, 1, "failed", "FAIL\n发现 2", local);
		expect(state.state.phase).toBe("summarizing");
		expect(state.state.summary).toEqual({ kind: "max_rounds", status: "pending" });
		expect(state.state.history[0].result).toBe("failed");
		expect(state.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "stop", reason: "max_rounds", round: 1 } },
			{ kind: "advance" },
		]);
	});

	test("events that do not apply to the current phase change nothing", async () => {
		await loadState();
		const idle = initialState("g");
		expect(step(idle, { type: "ADVANCE" })).toEqual({ state: idle, effects: [] });
		expect(step(idle, { type: "CANCEL", reason: "user" })).toEqual({ state: idle, effects: [] });
		const reviewing = begin();
		expect(step(reviewing, { type: "ADVANCE" })).toEqual({ state: reviewing, effects: [] });
	});

	test("all reviewers error settles as infrastructure error without a failed round", async () => {
		await loadState();
		const state = settle(begin(), 0, "error", "审查会话超时").state;
		const result = settle(state, 1, "error", "审查输出格式无效：缺少发现");
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("CANCEL notifies only for the user; the interrupted round records a reason enum, not display text", async () => {
		await loadState();
		const state = settle(begin(), 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const byUser = step(state, { type: "CANCEL", reason: "user" }, LIMITS, 5000);
		expect(byUser.state.phase).toBe("settled");
		expect(byUser.state.history[0]).toMatchObject({ result: "cancelled", reason: "user", details: "" });
		expect(byUser.effects).toEqual([{ kind: "notify_cancelled" }]);
		expect(step(state, { type: "CANCEL", reason: "shutdown" }, LIMITS, 5000).effects).toEqual([]);
		// 等顾问时被取消：待仲裁的那一轮也要收口进历史。
		const cancelled = step(needsAdvisor(), { type: "CANCEL", reason: "user" }, LIMITS, 30_000).state;
		expect(cancelled.history.at(-1)).toMatchObject({ round: 2, result: "cancelled", reason: "user" });
	});

	test("TIMEOUT settles with a timeout card; a round already recorded as failed stays failed", async () => {
		await loadState();
		const reviewing = settle(begin(), 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const timedOut = step(reviewing, { type: "TIMEOUT" }, LIMITS, 9000);
		expect(timedOut.state.history[0]).toMatchObject({ result: "timed_out", reason: "timeout" });
		expect(timedOut.effects).toEqual([{ kind: "send_card", card: { kind: "timeout" } }]);

		const result = step(failRound(begin()), { type: "TIMEOUT" }, LIMITS, 50_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history).toHaveLength(1);
		expect(result.state.history[0].result).toBe("failed");
	});

	// 有裁决就成轮：缺席者（会话故障或输出契约违例）只在结论里标注，不阻止形成质量结论。
	test.each([
		["审查会话超时", "审查会话超时"],
		["审查输出格式无效：第一行必须是 PASS 或 FAIL", "审查输出格式无效"],
	])("a PASS round forms without the absent reviewer (%s) and names it in the summary", async (absentDetails, reason) => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = begin(three);
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls", three).state;
		state = settle(state, 1, "error", absentDetails, three).state;
		const settled = settle(state, 2, "error", "会话启动失败", three);
		expect(settled.state.phase).toBe("summarizing");
		expect(settled.state.history[0].result).toBe("passed");
		expect(settled.state.history[0].details).toContain("模型 1 · m0\nPASS");
		expect(settled.state.history[0].details).toContain(`模型 2 · m1\n${absentDetails}`);
		expect(passCard(settled.effects[0])?.summary).toContain(`未形成裁决：m1（${reason}）、m2（会话启动失败）`);
	});

	test("a FAIL verdict forms the round even when the other reviewer errored", async () => {
		await loadState();
		const result = settle(settle(begin(), 0, "failed", "FAIL\n发现 1").state, 1, "error", "审查会话认证失败");
		expect(result.state.history[0].result).toBe("failed");
		expect(result.state.history[0].details).toContain("模型 2 · m1\n审查会话认证失败");
		expect(result.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "fail" } });
	});

	test("advisor infrastructure failure settles as unavailable instead of continuing", async () => {
		await loadState();
		const result = step(needsAdvisor(), { type: "INFRASTRUCTURE_ERROR", details: "顾问会话额度不足" }, LIMITS, 30_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history.at(-1)?.result).toBe("error");
		expect(result.effects).toEqual([{ kind: "send_card", card: { kind: "error", message: "顾问会话额度不足" } }]);
	});
});
