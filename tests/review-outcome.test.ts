import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FIRECODE_DIR, loadFirecodeModule } from "./loader.ts";

type ReadReviewOutcome = typeof import("../review/outcome.js").readReviewOutcome;

const fixtures = join(FIRECODE_DIR, "tests/fixtures/review-outcomes");

async function loadReader(): Promise<ReadReviewOutcome> {
	const module = await loadFirecodeModule("review/outcome.js") as {
		readReviewOutcome: ReadReviewOutcome;
	};
	return module.readReviewOutcome;
}

describe("review outcome reader", () => {
	test("maps max-round and advisor terminal decisions to stopped", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "stopped-max-rounds.jsonl"))).toMatchObject({ status: "stopped" });
		expect(readReviewOutcome(join(fixtures, "stopped-advisor.jsonl"))).toMatchObject({ status: "stopped", advisorAdvice: "stop here" });
	});

	test("ignores a truncated tail after the latest valid checkpoint", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "truncated-tail.jsonl"))).toEqual({
			status: "passed",
			runId: "truncated-run",
			rounds: 1,
		});
	});

	test("returns a parse error when no valid checkpoint survives malformed data", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "malformed.jsonl"))).toEqual({
			status: "error",
			message: "session 第 2 行不是有效 JSON",
		});
	});
});
