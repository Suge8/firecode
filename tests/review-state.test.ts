import { describe, expect, test } from "bun:test";
import type { ReviewLimits, ReviewState, ReviewerResult } from "../review/state.js";
import { loadFirecodeModule } from "./loader.ts";

type StateModule = typeof import("../review/state.js");
let reduce: StateModule["reduce"];
let initialState: StateModule["initialState"];
let roundText: StateModule["roundText"];
type ReviewEvent = import("../review/state.js").ReviewEvent;

const LIMITS: ReviewLimits = {
	maxRounds: 3,
	advisorAfterFailures: 2,
	advisor: [{ model: "p/advisor", thinking: "high" }],
	reviewers: [
		[{ model: "p/sol", thinking: "high" }],
		[{ model: "p/terra", thinking: "high" }],
	],
};

function reviewer(index: number, status: ReviewerResult["status"], details: string, summary = "s"): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary, details };
}

const step = (state: ReviewState, event: ReviewEvent, limits = LIMITS, now = 10_000) => reduce(state, event, limits, now);

/** 命令入口的真实路径：START 一律排队，ADVANCE 在 idle 门开第 1 轮。 */
function begin(limits = LIMITS): ReviewState {
	const queued = step(initialState("g"), { type: "START", focus: "" }, limits, 1000).state;
	return step(queued, { type: "ADVANCE" }, limits, 1000).state;
}

function settle(state: ReviewState, index: number, status: ReviewerResult["status"], details = "d", limits = LIMITS, summary = "s") {
	return step(state, { type: "REVIEWER_SETTLED", index, result: reviewer(index, status, details, summary) }, limits, 10_000 + index);
}

/** 两个审查者都判 FAIL：返回修复回合等待中的状态。 */
function failRound(state: ReviewState, limits = LIMITS): ReviewState {
	return settle(settle(state, 0, "failed", "FAIL\n发现 1", limits).state, 1, "failed", "FAIL\n发现 2", limits).state;
}

/** 修复回合走完：投递 → 回合正常结束 → 下一轮开始。 */
function repaired(state: ReviewState, limits = LIMITS): ReviewState {
	const started = step(state, { type: "TURN_STARTED" }, limits, 18_000).state;
	const done = step(started, { type: "TURN_ENDED", aborted: false }, limits, 19_000).state;
	return step(done, { type: "ADVANCE" }, limits, 20_000).state;
}

/** 连败两轮，进入等顾问仲裁的 needs_fix。 */
function needsAdvisor(): ReviewState {
	const state = failRound(repaired(failRound(begin())));
	expect(state.phase).toBe("needs_fix");
	return state;
}

function passSummary(effect: unknown): string {
	const card = (effect as { card?: { kind: string; summary: string } }).card;
	return card?.kind === "pass" ? card.summary : "";
}

async function loadState() {
	const module = (await loadFirecodeModule("review/state.ts")) as StateModule;
	({ reduce, initialState, roundText } = module);
}

describe("fire-review reducer", () => {
	test("a PASS summary keeps non-blocking suggestions once across reviewers and drops the evidence line", async () => {
		await loadState();
		const one: ReviewLimits = { ...LIMITS, reviewers: [LIMITS.reviewers[0]] };
		const single = settle(begin(one), 0, "passed", "核心逻辑已核对\n证据：文件=a.ts；命令=bun test\n## 建议（非阻塞）\n- 清理命名", one, "核心逻辑已核对");
		const singleSummary = passSummary(single.effects[0]);
		expect(singleSummary).toContain("核心逻辑已核对");
		expect(singleSummary).toContain("## 建议（非阻塞）\n- 清理命名");
		expect(singleSummary).not.toContain("证据：");

		const first = settle(begin(), 0, "passed", "ok\n## 建议（非阻塞）\n- 清理命名", LIMITS, "核心逻辑已核对").state;
		const multi = settle(first, 1, "passed", "ok\n## 建议（非阻塞）\n- 清理命名", LIMITS, "测试已通过");
		expect(multi.state.phase).toBe("summarizing");
		const summary = passSummary(multi.effects[0]);
		expect(summary).toContain("• m0：核心逻辑已核对");
		expect(summary.match(/清理命名/gu)).toHaveLength(1);
	});

	test("a later PASS card recaps the findings closed since the failed rounds", async () => {
		await loadState();
		let state = settle(begin(), 0, "failed", "FAIL\n## 发现 1\n- 问题: stale lock").state;
		state = settle(state, 1, "passed", "PASS\nok").state;
		state = repaired(state);
		state = settle(state, 0, "passed", "PASS\nok").state;
		const summary = passSummary(settle(state, 1, "passed", "PASS\nok").effects[0]);
		expect(summary).toContain("**本次收口的问题**：");
		expect(summary).toContain("• stale lock（第 1 轮）");
	});

	test("a FAIL vote fails the round: the card shows every reviewer, the feedback carries the failing votes only", async () => {
		await loadState();
		const result = settle(settle(begin(), 0, "failed", "FAIL\n发现 1").state, 1, "passed", "PASS\n证据：文件=a.ts；命令=ls");
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "fail", round: 1 } }, { kind: "advance" }]);
		const card = result.effects[0] as { card: { details: string } };
		expect(card.card.details).toContain("模型 1 · m0");
		expect(card.card.details).toContain("模型 2 · m1");
		const text = roundText(result.state.history[0]);
		expect(text).toContain("模型 1 · m0");
		expect(text).not.toContain("模型 2 · m1");
	});

	test("an absent reviewer blocks a pass but not the findings of a FAIL", async () => {
		await loadState();
		const passed = settle(settle(begin(), 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state, 1, "error", "审查会话超时");
		expect(passed.state).toMatchObject({ phase: "settled", end: "error" });
		expect(passed.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
		expect(passed.state.history[0].error).toContain("模型 2 · m1\n审查会话超时");

		const failed = settle(settle(begin(), 0, "failed", "FAIL\n发现 1").state, 1, "error", "审查会话认证失败");
		expect(failed.state.history[0].result).toBe("failed");
		expect(failed.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "fail" } });
	});

	test("failures reaching the threshold hand the round to the advisor", async () => {
		await loadState();
		const second = repaired(failRound(begin()));
		expect(second).toMatchObject({ phase: "reviewing", round: 2 });
		const result = failRound(second);
		expect(result).toMatchObject({ phase: "needs_fix", consecutiveFailures: 2 });
		// 顾问可能叫停：此时反馈还没交给执行模型，本轮也还没进历史。
		expect(result.history).toHaveLength(1);
	});

	// narrow 与 continue 在 reducer 层同样带着反馈去修复；两者的差别在反馈文本的范围约束，由 review-card-checkpoint 的 prompt 用例把守。
	test.each(["continue", "narrow"] as const)("advisor %s sends the advisor card and goes on to repair", async (verdict) => {
		await loadState();
		const result = step(needsAdvisor(), { type: "ADVISOR_SETTLED", result: { verdict, advice: "建议" } }, LIMITS, 30_000);
		expect(result.state).toMatchObject({ phase: "awaiting_fix", turn: "pending" });
		expect(result.state.history.at(-1)?.advisor?.verdict).toBe(verdict);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "advisor", advisor: { verdict }, advisorModel: "p/advisor" } },
			{ kind: "advance" },
		]);
	});

	test("skipping the advisor repairs without a card; an unavailable advisor repairs and says so", async () => {
		await loadState();
		const skipped = step(needsAdvisor(), { type: "ADVISOR_SKIPPED" }, LIMITS, 30_000);
		expect(skipped.state.phase).toBe("awaiting_fix");
		expect(skipped.effects).toEqual([{ kind: "advance" }]);
		const unavailable = step(needsAdvisor(), { type: "ADVISOR_SKIPPED", message: "额度不足" }, LIMITS, 30_000);
		expect(unavailable.state.phase).toBe("awaiting_fix");
		expect(unavailable.effects).toEqual([{ kind: "send_card", card: { kind: "skipped", message: "额度不足" } }, { kind: "advance" }]);
	});

	test("advisor stop ends the loop with a summary turn and a card that carries only the ruling", async () => {
		await loadState();
		const start = needsAdvisor().updatedAt;
		const result = step(needsAdvisor(), { type: "ADVISOR_SETTLED", result: { verdict: "stop", advice: "别修了" } }, LIMITS, 30_000);
		expect(result.state).toMatchObject({ phase: "summarizing", turn: "pending" });
		expect(result.state.history.at(-1)?.result).toBe("stopped");
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
					elapsedMs: 30_000 - start,
				},
			},
			{ kind: "advance" },
		]);
	});

	test("a FAIL at the max round goes straight to the summary turn without delivering feedback", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		const result = settle(settle(begin(local), 0, "failed", "FAIL\n发现 1", local).state, 1, "failed", "FAIL\n发现 2", local);
		expect(result.state).toMatchObject({ phase: "summarizing", turn: "pending" });
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "stop", reason: "max_rounds", round: 1 } }, { kind: "advance" }]);
	});

	test("an interrupted summary turn is re-armed on recovery and a cancel during it settles quietly", async () => {
		await loadState();
		let state = settle(settle(begin(), 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state, 1, "passed", "PASS\n证据：文件=b.ts；命令=ls").state;
		state = step(state, { type: "TURN_STARTED" }, LIMITS, 5000).state;
		const recovered = step(state, { type: "RECOVER" }, LIMITS, 6000).state;
		expect(recovered).toMatchObject({ phase: "summarizing", turn: "pending" });
		const cancelled = step(recovered, { type: "CANCEL", reason: "user" }, LIMITS, 7000);
		expect(cancelled.state.phase).toBe("settled");
		expect(cancelled.state.history.map((round) => round.result)).toEqual(["passed"]);
		expect(cancelled.effects).toEqual([]);
	});
});
