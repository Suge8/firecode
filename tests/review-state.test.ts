import { afterEach, describe, expect, test } from "bun:test";
import type { ReviewLimits, ReviewState, ReviewerResult } from "../review/state.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type Reduce = typeof import("../review/state.js").reduce;
type InitialState = typeof import("../review/state.js").initialState;

let reduce: Reduce;
let initialState: InitialState;

const LIMITS: ReviewLimits = {
	maxRounds: 3,
	advisorAfterFailures: 2,
	reviewers: [
		{ model: "p/sol", thinking: "high" },
		{ model: "p/terra", thinking: "high" },
	],
};

function reviewer(index: number, status: ReviewerResult["status"], details: string): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary: "s", details };
}

function settle(state: ReviewState, index: number, status: ReviewerResult["status"], details = "d") {
	return reduce(state, { type: "REVIEWER_SETTLED", index, result: reviewer(index, status, details) }, LIMITS, 10_000 + index);
}

async function loadState() {
	const module = (await loadFirecodeModule("review/state.ts")) as {
		reduce: Reduce;
		initialState: InitialState;
	};
	reduce = module.reduce;
	initialState = module.initialState;
}

afterEach(cleanupFirecodeModules);

describe("fire-review reducer", () => {
	test("START while idle begins reviewing round 1 with start card and reviewers", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "START", focus: "审 auth", busy: false, generation: "g" }, LIMITS, 1000);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.round).toBe(1);
		expect(result.state.active?.reviewers).toHaveLength(2);
		expect(result.state.focus).toBe("审 auth");
		expect(result.effects.map((e) => e.kind)).toEqual(["send_card", "start_reviewers"]);
		expect(result.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "start", models: ["p/sol", "p/terra"] } });
	});

	test("START while busy queues and waits for agent end", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "START", focus: "x", busy: true, generation: "g" }, LIMITS, 1000);
		expect(result.state.phase).toBe("queued");
		expect(result.state.round).toBe(0);
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "queued" } }]);
	});

	test("START while a review is active is ignored", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		const result = reduce(state, { type: "START", focus: "again", busy: false, generation: "g2" }, LIMITS, 2000);
		expect(result.state).toBe(state);
		expect(result.effects).toEqual([]);
	});

	test("all reviewers pass settles with passed round in history", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n验证命令 exit 0\n证据：文件=a.ts；命令=ls").state;
		const result = settle(state, 1, "passed", "PASS\nok\n证据：文件=b.ts；命令=cat b.ts");
		expect(result.state.phase).toBe("settled");
		expect(result.state.history).toHaveLength(1);
		expect(result.state.history[0].result).toBe("passed");
		expect(result.state.history[0].reviewers).toHaveLength(2);
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "pass" } }]);
	});

	test("any FAIL drives the round failed; before advisor threshold it delivers feedback directly", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		const result = settle(state, 1, "passed", "PASS\n证据：文件=a.ts；命令=ls");
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[0].result).toBe("failed");
		// 失败轮先发一张可见卡，再投隐藏反馈，否则用户看不到本轮结论。
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 1 } },
			{ kind: "deliver_feedback", advisor: null },
		]);
	});

	test("consecutive failures reaching the threshold consult the advisor instead of direct feedback", async () => {
		await loadState();
		// round 1 fails (direct feedback)
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		expect(state.phase).toBe("awaiting_fix");
		// agent fixes, round 2 begins
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		expect(state.round).toBe(2);
		// round 2 fails -> consecutiveFailures = 2 >= advisorAfterFailures
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		const result = settle(state, 1, "failed", "FAIL\n发现 4");
		expect(result.state.phase).toBe("needs_fix");
		expect(result.state.consecutiveFailures).toBe(2);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 2 } },
			{ kind: "consult_advisor" },
		]);
	});

	test("advisor continue delivers feedback and waits for fix", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "continue", advice: "继续修" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[1].advisor?.verdict).toBe("continue");
		// 先补一张带顾问结论的失败卡，再投反馈：否则界面永远停在「仲裁中」
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", advisor: { verdict: "continue" } } },
			{ kind: "deliver_feedback", advisor: { verdict: "continue" } },
		]);
	});

	// narrow 在 reducer 层与 continue 同样投反馈；两者的差别在反馈文本的范围约束，
	// 由 review-card-checkpoint 里的 prompt 用例把守。
	test("advisor narrow keeps the loop going and carries the advisor scope", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "narrow", advice: "收窄" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", advisor: { verdict: "narrow" } } },
			{ kind: "deliver_feedback" },
		]);
	});

	test("advisor stop settles the review as stopped", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "stop", advice: "别修了" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history).toHaveLength(2);
		expect(result.state.history[1].result).toBe("stopped");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "stop", reason: "advisor" } }]);
	});

	test("AGENT_END from queued begins round 1", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "f", busy: true, generation: "g" }, LIMITS, 1000).state;
		const result = reduce(state, { type: "AGENT_END" }, LIMITS, 2000);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.round).toBe(1);
		expect(result.state.focus).toBe("f");
		expect(result.effects.map((e) => e.kind)).toEqual(["send_card", "start_reviewers"]);
	});

	test("AGENT_END from awaiting_fix advances to the next round", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const result = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000);
		expect(result.state.round).toBe(2);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.history).toHaveLength(1);
	});

	test("AGENT_END at maxRounds stops instead of opening another round", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, local, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		expect(state.phase).toBe("awaiting_fix");
		const result = reduce(state, { type: "AGENT_END" }, local, 20_000);
		expect(result.state.phase).toBe("settled");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "stop", reason: "max_rounds" } }]);
	});

	test("a FAIL at the max round settles directly without delivering feedback", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, local, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "failed", "FAIL\n发现 1") }, local, 2000).state;
		const result = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "failed", "FAIL\n发现 2") }, local, 3000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("failed");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "stop", reason: "max_rounds" } }]);
	});

	test("AGENT_END is ignored while idle or reviewing", async () => {
		await loadState();
		const idle = reduce(initialState("g"), { type: "AGENT_END" }, LIMITS, 1000);
		expect(idle.state.phase).toBe("idle");
		expect(idle.effects).toEqual([]);
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		const reviewing = reduce(state, { type: "AGENT_END" }, LIMITS, 2000);
		expect(reviewing.state.phase).toBe("reviewing");
		expect(reviewing.state.round).toBe(1);
	});

	test("all reviewers error settles as infrastructure error without a failed round", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "error", "审查子进程超时").state;
		const result = settle(state, 1, "error", "审查子进程启动失败");
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("CANCEL from reviewing settles with a cancelled round and card", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const result = reduce(state, { type: "CANCEL", reason: "user" }, LIMITS, 5000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("cancelled");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "cancel" } }]);
	});

	test("CANCEL while idle is ignored", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "CANCEL", reason: "user" }, LIMITS, 1000);
		expect(result.state.phase).toBe("idle");
		expect(result.effects).toEqual([]);
	});

	test("TIMEOUT from awaiting_fix settles; the round was already recorded as failed", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const result = reduce(state, { type: "TIMEOUT" }, LIMITS, 50_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("failed");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "timeout" } }]);
	});

	test("history is append-only: earlier round records are never mutated", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const first = state.history[0];
		const before = JSON.stringify(state.history[0]);
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const result = settle(state, 1, "passed", "PASS\n证据：文件=b.ts；命令=cat b.ts");
		expect(result.state.history).toHaveLength(2);
		expect(JSON.stringify(result.state.history[0])).toBe(before);
		expect(result.state.history[0]).toBe(first);
	});

	test("round numbers are monotonic across the loop", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		const rounds = [state.round];
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 20_000).state;
		rounds.push(state.round);
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		// 第二轮触发顾问仲裁，仲裁 continue 后进修复，agent_end 再开第三轮
		state = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "continue", advice: "继续" } }, LIMITS, 30_000).state;
		state = reduce(state, { type: "AGENT_END" }, LIMITS, 40_000).state;
		rounds.push(state.round);
		expect(rounds).toEqual([1, 2, 3]);
	});

	test("a passed round labels each reviewer by its own status (error stays ERROR, not PASS)", async () => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "passed", "PASS\n证据：文件=a.ts；命令=ls") }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "passed", "PASS\n证据：文件=b.ts；命令=ls") }, three, 1000).state;
		const settled = reduce(state, { type: "REVIEWER_SETTLED", index: 2, result: reviewer(2, "error", "审查子进程超时") }, three, 1000);
		expect(settled.state.phase).toBe("settled");
		expect(settled.state.history[0].result).toBe("passed");
		expect(settled.state.history[0].details).toContain("PASS · m0");
		expect(settled.state.history[0].details).toContain("ERROR · m2");
		expect(settled.state.history[0].details).not.toContain("PASS · m2");
	});

	// 多数审查者基础设施错误时不能宣告通过：对抗审查的价值在多模型交叉，
	// 只剩一个模型完成却说「审查通过」是假成功。
	test("a round where most reviewers errored is an infra error, not a pass", async () => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "passed", "PASS\n证据：文件=a.ts；命令=ls") }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "error", "子进程超时") }, three, 1000).state;
		const settled = reduce(state, { type: "REVIEWER_SETTLED", index: 2, result: reviewer(2, "error", "子进程启动失败") }, three, 1000);
		expect(settled.state.history[0].result).toBe("error");
		expect(settled.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("cancelled and timed-out rounds carry a reason enum, not display text", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false, generation: "g" }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const cancelled = reduce(state, { type: "CANCEL", reason: "user" }, LIMITS, 5000);
		expect(cancelled.state.history[0].reason).toBe("user");
		expect(cancelled.state.history[0].details).toBe("");
		expect(cancelled.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "cancel", reason: "user" } });

		let timed = reduce(initialState("g2"), { type: "START", focus: "", busy: false, generation: "g2" }, LIMITS, 1000).state;
		timed = settle(timed, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const timedOut = reduce(timed, { type: "TIMEOUT" }, LIMITS, 9000);
		expect(timedOut.state.history[0].reason).toBe("timeout");
		expect(timedOut.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "timeout", reason: "timeout" } });
	});
});
