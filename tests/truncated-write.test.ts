import { expect, test } from "bun:test";
import { featuresOnly, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

/** 宿主 read 截断时追加在正文末尾的提示（pi core/tools/read.ts 的三种写法）。 */
const TRUNCATED = [
	"line 1\nline 2\n\n[Showing lines 1-1018 of 2023 (50.0KB limit). Use offset=1019 to continue.]",
	"line 1\n\n[Showing lines 1-2000 of 2007. Use offset=2001 to continue.]",
	"line 1\n\n[7 more lines in file. Use offset=2001 to continue.]",
];

async function writeGuard(subsession: boolean) {
	const { registerFirecode } = await loadFirecodeModule("index.ts", {
		configJsonc: JSON.stringify({ features: await featuresOnly() }),
	}) as { registerFirecode(pi: unknown, subsession: boolean): void };
	const fake = fakePi();
	registerFirecode(fake.pi, subsession);
	const ctx = { cwd: process.cwd() };
	return (content: string) => fake.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "out.ts", content } }, ctx);
}

// 事故两次：codemode 脚本把 read 的截断结果整体写回，测试文件被清成半截还被提交。
test("写入内容带 read 截断提示时拒绝：主会话与子代理会话都拦，正常内容放行", async () => {
	for (const subsession of [false, true]) {
		const write = await writeGuard(subsession);
		for (const content of TRUNCATED)
			expect(await write(content)).toEqual({ block: true, reason: expect.stringContaining("read 截断") });
		expect(await write("export const a = 1;\n")).toBeUndefined();
	}
});
