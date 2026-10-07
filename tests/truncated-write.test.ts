import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, featuresOnly, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

afterEach(cleanupFirecodeModules);

/** 宿主 read 截断时追加在正文末尾的提示（pi core/tools/read.ts 的三种写法）。 */
const TRUNCATED = [
	"line 1\nline 2\n\n[Showing lines 1-1018 of 2023 (50.0KB limit). Use offset=1019 to continue.]",
	"line 1\n\n[Showing lines 1-2000 of 2007. Use offset=2001 to continue.]",
	"line 1\n\n[7 more lines in file. Use offset=2001 to continue.]",
];

async function writeGuard(role: "main" | "worker") {
	const harness = await loadFirecodeModule("role-harness.js", {
		configJsonc: JSON.stringify({ features: await featuresOnly() }),
		extraFiles: {
			"role-harness.ts": [
				'import firecode from "./index.js";',
				'import { withSubsessionRole } from "./master/role.js";',
				'export const register = (pi: unknown, role: string) => role === "main"',
				'	? Promise.resolve(firecode(pi as never))',
				'	: withSubsessionRole(role as never, async () => firecode(pi as never));',
			].join("\n"),
		},
	}) as { register: (pi: unknown, role: string) => Promise<void> };
	const fake = fakePi();
	await harness.register(fake.pi, role);
	const ctx = { cwd: process.cwd() };
	return (content: string) => fake.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "out.ts", content } }, ctx);
}

// 事故两次：codemode 脚本把 read 的截断结果整体写回，测试文件被清成半截还被提交。
test("写入内容带 read 截断提示时拒绝：主会话与子代理会话都拦，正常内容放行", async () => {
	for (const role of ["main", "worker"] as const) {
		const write = await writeGuard(role);
		for (const content of TRUNCATED)
			expect(await write(content)).toEqual({ block: true, reason: expect.stringContaining("read 截断") });
		expect(await write("export const a = 1;\n")).toBeUndefined();
		await cleanupFirecodeModules();
	}
});
