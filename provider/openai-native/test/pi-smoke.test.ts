import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("pi-openai-native", () => {
	test("loads as a local extension and registers its flag without a provider request", () => {
		const extensionDir = path.resolve(import.meta.dir, "../../..");
		const isolated = mkdtempSync(path.join(tmpdir(), "firecode-smoke-"));
		const agentDir = path.join(isolated, "agent");
		const configDir = path.join(agentDir, "extensions", "firecode");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(path.join(configDir, "config.jsonc"), readFileSync(path.join(extensionDir, "config.example.jsonc")));
		try {
			const result = spawnSync("pi", ["--no-extensions", "-e", extensionDir, "--help"], {
				encoding: "utf8",
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			});
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--verbosity");
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});
