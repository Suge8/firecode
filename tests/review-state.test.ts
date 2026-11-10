import { describe, expect, test } from "bun:test";
import type { ReviewLimits, ReviewState, ReviewerResult } from "../review/state.js";
import { loadFirecodeModule } from "./loader.ts";

type StateModule = typeof import("../review/state.js");
let reduce: StateModule["reduce"];
let initialState: StateModule["initialState"];
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

async function loadState() {
	const module = (await loadFirecodeModule("review/state.ts")) as StateModule;
	({ reduce, initialState } = module);
}

describe("fire-review reducer", () => {
	// stop 的终止卡只承载裁决：findings 已在咨询前的失败卡显示过。
	test.each([
		["continue", "awaiting_fix", "failed", "advisor"],
		["stop", "summarizing", "stopped", "stop"],
	] as const)("advisor %s: the round closes and the right card follows", async (verdict, phase, result, card) => {
		await loadState();
		const next = step(needsAdvisor(), { type: "ADVISOR_SETTLED", result: { verdict, advice: "别修了" } }, LIMITS, 30_000);
		expect(next.state).toMatchObject({ phase, turn: "pending" });
		expect(next.state.history.at(-1)?.result).toBe(result);
		const sent = next.effects.find((effect) => effect.kind === "send_card") as { card: { kind: string; details?: string } };
		expect(sent.card.kind).toBe(card);
		if (card === "stop") expect(sent.card.details).toBe("别修了");
	});

	test("a FAIL at the max round goes straight to the summary turn without delivering feedback", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		const result = settle(settle(begin(local), 0, "failed", "FAIL\n发现 1", local).state, 1, "failed", "FAIL\n发现 2", local);
		expect(result.state).toMatchObject({ phase: "summarizing", turn: "pending" });
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "stop", reason: "max_rounds", round: 1 } }, { kind: "advance" }]);
	});
});
