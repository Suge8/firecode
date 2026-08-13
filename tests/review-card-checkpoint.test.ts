import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type BuildCard = typeof import("../review/card.js").buildCard;
type BuildPrompt = typeof import("../review/prompt.js").buildReviewPrompt;
type BuildFixFeedback = typeof import("../review/prompt.js").buildFixFeedback;
type IsValidCardDetails = typeof import("../review/card.js").isValidCardDetails;
type IsValidCheckpoint = typeof import("../review/checkpoint.js").isValidCheckpoint;

let buildCard: BuildCard;
let buildReviewPrompt: BuildPrompt;
let buildFixFeedback: BuildFixFeedback;
let isValidCardDetails: IsValidCardDetails;
let isValidCheckpoint: IsValidCheckpoint;

async function loadAll() {
	const card = (await loadFirecodeModule("review/card.js")) as {
		buildCard: BuildCard;
		isValidCardDetails: IsValidCardDetails;
	};
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		isValidCheckpoint: IsValidCheckpoint;
	};
	const prompt = (await loadFirecodeModule("review/prompt.js")) as {
		buildReviewPrompt: BuildPrompt;
		buildFixFeedback: BuildFixFeedback;
	};
	buildCard = card.buildCard;
	isValidCardDetails = card.isValidCardDetails;
	isValidCheckpoint = checkpoint.isValidCheckpoint;
	buildReviewPrompt = prompt.buildReviewPrompt;
	buildFixFeedback = prompt.buildFixFeedback;
}

afterEach(cleanupFirecodeModules);

describe("result card payload", () => {
	test("every card kind produces schema-valid details and non-empty plain content", async () => {
		await loadAll();
		const cards = [
			{ kind: "queued", focus: "f" },
			{ kind: "start", round: 1, focus: "f", models: ["p/sol", "p/terra"] },
			{ kind: "pass", round: 1, summary: "s", details: "s", elapsedMs: 1000 },
			{ kind: "fail", round: 1, details: "FAIL", advisor: null },
			{ kind: "stop", reason: "max_rounds", round: 1, details: "" },
			{ kind: "cancel", round: 1 },
			{ kind: "timeout", round: 1 },
			{ kind: "error", message: "err" },
		];
		for (const card of cards) {
			const built = buildCard(card as never, "zh");
			expect(built.content.length).toBeGreaterThan(0);
			expect(isValidCardDetails(built.details)).toBe(true);
			expect(built.details.lines.every((line) => typeof line === "string")).toBe(true);
		}
	});

	test("content is plain text facts; details carry the localized title and icon", async () => {
		await loadAll();
		const built = buildCard({ kind: "pass", round: 1, summary: "ok", details: "ok", elapsedMs: 60000 }, "zh");
		expect(built.content).not.toMatch(/\x1b\[/);
		expect(built.details.title).toContain("审查通过");
		expect(built.details.icon).toBe("✓");
		expect(built.details.lines.join("\n")).toContain("ok");
	});

	test("start card surfaces the focus and models without a redundant description", async () => {
		await loadAll();
		const built = buildCard({ kind: "start", round: 1, focus: "审 auth", models: ["p/sol"] }, "zh");
		const lines = built.details.lines.join("\n");
		expect(lines).toContain("审 auth");
		expect(lines).toContain("sol");
		expect(lines).not.toContain("审查到目前为止做完的事");
	});

	test("non-pass cards do not repeat their title state in the body", async () => {
		await loadAll();
		const cases = [
			buildCard({ kind: "queued", focus: "" }, "zh"),
			buildCard({ kind: "fail", round: 1, details: "FAIL", advisor: null }, "zh"),
			buildCard({ kind: "stop", reason: "max_rounds", round: 1, details: "" }, "zh"),
			buildCard({ kind: "timeout", round: 1 }, "zh"),
			buildCard({ kind: "error", message: "network" }, "zh"),
		];
		expect(cases[0].details.lines).toEqual([]);
		expect(cases[1].details.lines[0]).toBe("发现已交回修复。");
		expect(cases[2].details.lines[0]).toBe("已达到最大轮数。");
		expect(cases[3].details.lines).toEqual([]);
		expect(cases[4].details.lines[0]).toBe("未产生有效发现。");
		for (const built of cases)
			expect(built.details.lines[0] ?? "").not.toContain(built.details.title.split(" · ")[0]);
	});

	test("renderer removes markdown furniture from reviewer findings", async () => {
		const card = (await loadFirecodeModule("review/card.js")) as {
			buildCard: BuildCard;
			registerCardRenderer: (pi: unknown) => void;
		};
		let renderer: ((message: unknown, options: unknown, theme: unknown) => { render: (width: number) => string[] }) | undefined;
		card.registerCardRenderer({
			registerMessageRenderer: (_type: string, next: typeof renderer) => {
				renderer = next;
			},
		});
		const built = card.buildCard({
			kind: "fail",
			round: 1,
			details: "## 发现 1\n- 问题: `state.ts` 有误",
			advisor: null,
		}, "zh");
		const component = renderer?.(
			{ details: built.details, content: built.content },
			{},
			{ fg: (_tone: string, text: string) => text },
		);
		const output = component?.render(48).join("\n") ?? "";
		expect(output).toContain("发现 1");
		expect(output).toContain("• 问题: state.ts 有误");
		expect(output).not.toContain("##");
		expect(output).not.toContain("`");
	});

	test("narrow cards never render beyond the terminal width", async () => {
		const card = (await loadFirecodeModule("review/card.js")) as {
			buildCard: BuildCard;
			registerCardRenderer: (pi: unknown) => void;
		};
		let renderer: ((message: unknown, options: unknown, theme: unknown) => { render: (width: number) => string[] }) | undefined;
		card.registerCardRenderer({
			registerMessageRenderer: (_type: string, next: typeof renderer) => {
				renderer = next;
			},
		});
		const built = card.buildCard({ kind: "timeout", round: 12 }, "zh");
		const lines = renderer?.(
			{ details: built.details, content: built.content },
			{},
			{ fg: (_tone: string, text: string) => text },
		)?.render(8) ?? [];
		expect(lines.every((line) => Bun.stringWidth(line) <= 8)).toBe(true);
	});
});

describe("checkpoint schema", () => {
	test("rejects version mismatch, unknown keys, and invalid phases (discard, no field-level compat)", async () => {
		await loadAll();
		const valid = {
			version: 2,
			seq: 1,
			generation: "g",
			phase: "reviewing",
			round: 1,
			focus: "",
			history: [],
			active: {
				round: 1,
				reviewers: [{ index: 0, model: "m", thinking: "high", status: "running", result: null }],
				settledCount: 0,
			},
			pending: null,
			repair: null,
			consecutiveFailures: 0,
			startedAt: 1,
			roundStartedAt: 1,
			updatedAt: 1,
		};
		expect(isValidCheckpoint(valid)).toBe(true);
		expect(isValidCheckpoint({ ...valid, version: 1 })).toBe(false);
		expect(isValidCheckpoint({ ...valid, extra: 1 })).toBe(false);
		expect(isValidCheckpoint({ ...valid, phase: "bogus" })).toBe(false);
		expect(isValidCheckpoint({ ...valid, active: null })).toBe(true);
	});

	// 回归：轮记录新增 reason 字段时校验白名单未同步，导致取消/超时的终态写不进去，
	// 活动 checkpoint 残留并在重启后被恢复成幽灵审查。校验键现由类型 satisfies 派生，
	// 这里覆盖 reducer 能产出的每种终态，确保持久化路径真的走得通。
	test("every terminal state the reducer can produce survives a checkpoint round trip", async () => {
		await loadAll();
		const state = (await loadFirecodeModule("review/state.js")) as typeof import("../review/state.js");
		const limits = {
			maxRounds: 5,
			advisorAfterFailures: 2,
			reviewers: [{ model: "p/m1", thinking: "high" }],
		};
		const singleRound = { ...limits, maxRounds: 1 };
		const failed = {
			index: 0,
			model: "p/m1",
			thinking: "high",
			status: "failed" as const,
			summary: "s",
			details: "d",
		};
		const start = state.reduce(
			state.initialState("g"),
			{ type: "START", focus: "", busy: false, generation: "g" },
			limits,
			1,
		).state;
		const settle = (from: typeof start) =>
			state.reduce(from, { type: "REVIEWER_SETTLED", index: 0, result: failed }, limits, 2).state;
		let repaired = settle(start);
		repaired = state.reduce(repaired, { type: "FEEDBACK_DISPATCHED" }, limits, 3).state;
		repaired = state.reduce(repaired, { type: "REPAIR_STARTED" }, limits, 4).state;
		repaired = state.reduce(repaired, { type: "REPAIR_COMPLETED" }, limits, 5).state;
		const advisorPhase = settle(state.reduce(repaired, { type: "ADVANCE" }, limits, 6).state);
		expect(advisorPhase.phase).toBe("needs_fix");

		const terminals = {
			"reviewing→cancel": state.reduce(start, { type: "CANCEL", reason: "shutdown" }, limits, 4).state,
			"reviewing→timeout": state.reduce(start, { type: "TIMEOUT" }, limits, 4).state,
			"needs_fix→cancel": state.reduce(advisorPhase, { type: "CANCEL", reason: "user" }, limits, 4).state,
			"needs_fix→timeout": state.reduce(advisorPhase, { type: "TIMEOUT" }, limits, 4).state,
			"advisor→stop": state.reduce(
				advisorPhase,
				{ type: "ADVISOR_SETTLED", result: { verdict: "stop", advice: "a" } },
				limits,
				4,
			).state,
			"max_rounds": state.reduce(
				state.reduce(
					state.initialState("g2"),
					{ type: "START", focus: "", busy: false, generation: "g2" },
					singleRound,
					1,
				).state,
				{ type: "REVIEWER_SETTLED", index: 0, result: failed },
				singleRound,
				2,
			).state,
		};
		for (const [label, terminal] of Object.entries(terminals)) {
			expect(`${label}:${terminal.phase}`).toBe(`${label}:settled`);
			expect(`${label}:${isValidCheckpoint({ version: 2, seq: 1, ...terminal })}`).toBe(`${label}:true`);
		}
	});
});

describe("prompt assembly", () => {
	test("review prompt keeps template + scope + focus + evidence, and injects prior rounds from round 2", async () => {
		await loadAll();
		const history = [
			{
				round: 1,
				result: "failed" as const,
				summary: "s",
				details: "FAIL\n## 发现 1\n- 问题: auth",
				reviewers: [],
				elapsedMs: 100,
			},
		];
		const first = buildReviewPrompt("# 模板", {
			language: "zh",
			scope: "当前任务交付质量",
			focus: "审 auth",
			evidence: "会话证据",
			history: [],
			round: 1,
		});
		expect(first).toContain("# 模板");
		expect(first).toContain("当前任务交付质量");
		expect(first).toContain("审 auth");
		expect(first).toContain("会话证据");
		expect(first).not.toContain("往轮发现清单");

		const second = buildReviewPrompt("# 模板", {
			language: "zh",
			scope: "当前任务交付质量",
			focus: "",
			evidence: "会话证据",
			history,
			round: 2,
		});
		expect(second).toContain("往轮发现清单");
		expect(second).toContain("auth");
	});

	test("fix feedback frames findings as hypotheses and attaches advisor advice", async () => {
		await loadAll();
		const feedback = buildFixFeedback({
			language: "zh",
			details: "FAIL\n发现 x",
			advisor: { verdict: "continue", advice: "继续修" },
		});
		expect(feedback).toContain("待核实假设");
		expect(feedback).toContain("发现 x");
		expect(feedback).toContain("继续修");
	});

	// narrow 曾与 continue 走完全相同的反馈，顾问的「收窄范围」裁决形同虚设。
	test("a narrow verdict scopes the fix instead of demanding every finding", async () => {
		await loadAll();
		const base = { language: "zh" as const, details: "FAIL\n发现 x" };
		const carryOn = buildFixFeedback({
			...base,
			advisor: { verdict: "continue", advice: "继续" },
		});
		const narrowed = buildFixFeedback({
			...base,
			advisor: { verdict: "narrow", advice: "只修阻塞项" },
		});
		expect(narrowed).not.toBe(carryOn);
		expect(carryOn).toContain("逐条修复全部属实发现");
		expect(narrowed).not.toContain("逐条修复全部属实发现");
		expect(narrowed).toContain("只修顾问收窄后的范围");
		expect(narrowed).toContain("以此为准");
	});
});
