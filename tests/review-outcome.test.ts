import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, FIRECODE_DIR, loadFirecodeModule } from "./loader.ts";

type ReadReviewOutcome = typeof import("../review/outcome.js").readReviewOutcome;

const fixtures = join(FIRECODE_DIR, "tests/fixtures/review-outcomes");

async function loadReader(): Promise<ReadReviewOutcome> {
	const module = await loadFirecodeModule("review/outcome.js") as {
		readReviewOutcome: ReadReviewOutcome;
	};
	return module.readReviewOutcome;
}

afterEach(cleanupFirecodeModules);

describe("review outcome reader", () => {
	test("reads pass from the latest checkpoint", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "passed.jsonl"))).toEqual({
			status: "passed",
			runId: "passed-run",
			rounds: 1,
		});
	});

	test("maps max-round and advisor terminal decisions to stopped", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "stopped-max-rounds.jsonl"))).toMatchObject({ status: "stopped" });
		expect(readReviewOutcome(join(fixtures, "stopped-advisor.jsonl"))).toMatchObject({ status: "stopped" });
	});

	test("error, cancelled or timed_out terminals surface as failed carrying the round details", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "error-terminal.jsonl"))).toEqual({
			status: "failed",
			runId: "error-run",
			rounds: 2,
			reason: "issue remains",
		});
	});

	test("reports an active checkpoint as in progress", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "in-progress.jsonl"))).toMatchObject({ status: "in_progress" });
	});

	test("reports no review for a plain or missing session", async () => {
		const readReviewOutcome = await loadReader();
		expect(readReviewOutcome(join(fixtures, "none.jsonl"))).toEqual({ status: "none" });
		expect(readReviewOutcome(join(fixtures, "missing.jsonl"))).toEqual({ status: "none" });
	});

	test("a refusal record is the latest outcome until a later checkpoint supersedes it", async () => {
		const readReviewOutcome = await loadReader();
		const directory = await mkdtemp(join(tmpdir(), "review-refusal-"));
		try {
			const passed = (await readFile(join(fixtures, "passed.jsonl"), "utf8")).trimEnd();
			const refusal = JSON.stringify({ type: "custom", customType: "firecode-review-refusal", data: { id: "r1", message: "配置有问题" } });
			const path = join(directory, "session.jsonl");
			await writeFile(path, `${passed}\n${refusal}\n`);
			expect(readReviewOutcome(path)).toEqual({ status: "refused", runId: "r1", message: "配置有问题" });
			await writeFile(path, `${refusal}\n${passed}\n`);
			expect(readReviewOutcome(path)).toMatchObject({ status: "passed" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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
