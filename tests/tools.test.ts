import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const context = (overrides = {}) => ({ state: {}, cwd: "/project", toolCallId: crypto.randomUUID(), isPartial: false, isError: false, expanded: false, ...overrides });
afterEach(cleanupFirecodeModules);

async function tools() {
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	const registered: Record<string, any> = {};
	registerToolRendering({ on() {}, registerTool: (tool: any) => { registered[tool.name] = tool; }, registerCommand() {} });
	expect(Object.keys(registered).sort()).toEqual(["bash", "edit", "read", "write"]);
	return registered;
}

test("紧凑工具保留路径、错误和修改摘要，按需正文保留空白并清理终端控制字符", async () => {
	const { read, bash, edit } = await tools();
	const ctx = context();
	const result = { content: [{ type: "text", text: "  alpha  \n" }, { type: "text", text: "\x1b[31mbeta\x1b[0m\x00 " }] };
	expect(read.renderResult(result, { expanded: false }, theme, ctx).render(76)).toEqual([]);
	expect(read.renderCall({ path: "/project/a.ts", offset: 10 }, theme, ctx).render(76)[0]).toContain("读取 ./a.ts:10+");
	expect(read.renderResult(result, { expanded: true }, theme, ctx).render(76)).toEqual(["", "  alpha  ", "", "beta "]);
	const error = context({ isError: true });
	bash.renderResult({ content: [{ type: "text", text: "Cannot find module" }] }, { expanded: false }, theme, error);
	expect(bash.renderCall({ command: "bun test" }, theme, error).render(100)[0]).toContain("操作 $ bun test · Cannot find module");
	const diff = { content: [{ type: "text", text: "修改成功" }], details: { diff: "+1 new\n-1 old" } };
	edit.renderResult(diff, { expanded: false }, theme, ctx);
	expect(edit.renderCall({ path: "/project/a.ts" }, theme, ctx).render(76)[0]).toContain("+1 -1");
	expect(edit.renderResult(diff, { expanded: true }, theme, ctx).render(76).join("\n")).toContain("+1 new\n-1 old");
});

test("折叠的成功结果只取长度，不逐字加工隐藏正文", async () => {
	const { read } = await tools();
	const ctx = context();
	const text = "hidden-body-".repeat(10_000);
	const original = String.prototype[Symbol.iterator];
	let traversals = 0;
	String.prototype[Symbol.iterator] = function () {
		if (String(this) === text) traversals++;
		return original.call(this);
	};
	try {
		const result = read.renderResult({ content: [{ type: "text", text }] }, { expanded: false }, theme, ctx);
		expect(result.render(80)).toEqual([]);
		expect(traversals).toBe(0);
		expect(ctx.state).toMatchObject({ chars: text.length });
	} finally {
		String.prototype[Symbol.iterator] = original;
	}
});

test("工具执行耗时仍来自真实调用，展示包装不改变结果", async () => {
	const { read } = await tools();
	const directory = await mkdtemp(join(tmpdir(), "firecode-timing-"));
	const originalNow = performance.now.bind(performance);
	try {
		const path = join(directory, "a.txt");
		await writeFile(path, "content");
		const times = [0, 1500];
		Object.defineProperty(performance, "now", { configurable: true, value: () => times.shift() ?? 1500 });
		const ctx = context({ cwd: directory });
		const result = await read.execute(ctx.toolCallId, { path }, undefined, undefined, { cwd: directory });
		expect(result.content).toEqual([{ type: "text", text: "content" }]);
		read.renderResult(result, { expanded: false }, theme, ctx);
		expect(read.renderCall({ path }, theme, ctx).render(76)[0]).toContain("1.5s");
	} finally {
		Object.defineProperty(performance, "now", { configurable: true, value: originalNow });
		await rm(directory, { recursive: true, force: true });
	}
});
