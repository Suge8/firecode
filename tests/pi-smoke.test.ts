import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRECODE_DIR, PI_PACKAGES } from "./loader.ts";

// 需要先 bun run build：宿主按 package.json 加载 dist/index.js。宿主跑 PI_PACKAGES 里的源码，与类型检查、其余测试同一份。
test("pi loads the built package and its features register", () => {
	const isolated = mkdtempSync(join(tmpdir(), "firecode-smoke-"));
	const agentDir = join(isolated, "agent");
	const configDir = join(agentDir, "extensions", "firecode");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.jsonc"), readFileSync(join(FIRECODE_DIR, "config.example.jsonc")));
	try {
		const result = Bun.spawnSync(["bun", join(PI_PACKAGES, "coding-agent/src/cli.ts"), "--no-extensions", "-e", FIRECODE_DIR, "--help"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("--verbosity");
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});
