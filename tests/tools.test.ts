import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFirecodeModule, PI_CODING_AGENT_URL } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const context = (overrides = {}) => ({ state: {}, cwd: "/project", toolCallId: crypto.randomUUID(), isPartial: false, isError: false, expanded: false, ...overrides });
/** 宿主解析器给七个默认工具的渲染器：只接管渲染，不注册工具。 */
async function renderers() {
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	const fake = fakePi();
	registerToolRendering(fake.pi);
	expect(fake.tools.size).toBe(0);
	return (name: string) => fake.resolveToolRenderers(name);
}

test("紧凑工具保留路径、错误和修改摘要，按需正文保留空白并清理终端控制字符", async () => {
	const resolve = await renderers();
	const [read, bash, edit] = ["read", "bash", "edit"].map(resolve);
	const ctx = context();
	const result = { content: [{ type: "text", text: "  alpha  \n" }, { type: "text", text: "\x1b[31mbeta\x1b[0m\x00 " }] };
	expect(read.renderResult(result, { expanded: false }, theme, ctx).render(76)).toEqual([]);
	expect(read.renderCall({ path: "/project/a.ts", offset: 10 }, theme, ctx).render(76)[0]).toContain("读取 ./a.ts:10+");
	// 严格模式的模型把没填的参数传成 null，曾显示成 :10-9。
	expect(read.renderCall({ path: "/project/a.ts", offset: 10, limit: null }, theme, ctx).render(76)[0]).toContain("读取 ./a.ts:10+");
	const body = read.renderResult(result, { expanded: true }, theme, ctx).render(76);
	expect(body).toContain("  alpha  ");
	expect(body).toContain("beta ");
	expect(body.join("")).not.toMatch(/[\x00\x1b]/);
	const error = context({ isError: true });
	bash.renderResult({ content: [{ type: "text", text: "Cannot find module" }] }, { expanded: false }, theme, error);
	expect(bash.renderCall({ command: "bun test" }, theme, error).render(100)[0]).toContain("操作 $ bun test · Cannot find module");
	const diff = { content: [{ type: "text", text: "修改成功" }], details: { diff: "+1 new\n-1 old" } };
	edit.renderResult(diff, { expanded: false }, theme, ctx);
	expect(edit.renderCall({ path: "/project/a.ts" }, theme, ctx).render(76)[0]).toContain("+1 -1");
	expect(edit.renderResult(diff, { expanded: true }, theme, ctx).render(76).join("\n")).toContain("+1 new\n-1 old");
});

test("grep、find、ls 与读写工具同一套紧凑行，耗时列来自宿主给的真实执行耗时", async () => {
	const resolve = await renderers();
	const call = (name: string, args: unknown, overrides = {}) => {
		const ctx = context(overrides);
		const tool = resolve(name);
		tool.renderResult({ content: [{ type: "text", text: "x".repeat(200) }] }, { expanded: false }, theme, ctx);
		return tool.renderCall(args, theme, ctx).render(100)[0];
	};
	expect(call("grep", { pattern: "TODO", path: "/project/src" })).toContain("搜索 TODO ./src");
	expect(call("find", { pattern: "*.ts" })).toContain("查找 *.ts");
	expect(call("ls", {})).toContain("列出 .");
	expect(call("read", { path: "/project/a.ts" }, { durationMs: 1500 })).toContain("1.5s");
	// 导出 HTML 时宿主不带耗时。
	expect(call("read", { path: "/project/a.ts" })).not.toContain("1.5s");
});

test("接管渲染不改变宿主的工具：系统提示仍有 read/edit/write 的准则，shellCommandPrefix 仍作用于 bash，导出 HTML 照常渲染", async () => {
	const host = await import(PI_CODING_AGENT_URL) as any;
	const { registerToolRendering } = await loadFirecodeModule("tools/index.ts");
	const directory = mkdtempSync(join(tmpdir(), "firecode-tools-"));
	try {
		host.initTheme("dark");
		const loader = new host.DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [registerToolRendering],
		});
		await loader.reload();
		const { session } = await host.createAgentSession({
			cwd: directory, agentDir: directory, resourceLoader: loader,
			sessionManager: host.SessionManager.inMemory(), settingsManager: host.SettingsManager.inMemory({ shellCommandPrefix: "export FROM_PREFIX=ok" }),
		});
		expect(session.systemPrompt).toContain("Use read to examine files instead of cat or sed.");
		expect(session.systemPrompt).toContain("edits[].oldText must match exactly");
		const bash = session.agent.state.tools.find((tool: { name: string }) => tool.name === "bash");
		const output = await bash.execute("id", { command: "echo $FROM_PREFIX" }, undefined, undefined, undefined);
		// 只看命令自己的输出行：没有 zh_CN locale 的机器（CI）上 bash 会先打一行 setlocale 警告。
		expect(output.content[0].text).toMatch(/(^|\n)ok\n$/);

		const { createToolHtmlRenderer } = await import(new URL("./core/export-html/tool-renderer.ts", PI_CODING_AGENT_URL).href);
		const { theme } = await import(new URL("./modes/interactive/theme/theme.ts", PI_CODING_AGENT_URL).href);
		const html = createToolHtmlRenderer({
			theme, cwd: directory,
			getToolRenderers: (name: string) => session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name)),
		});
		expect(html.renderCall("c1", "read", { path: "a.ts" })).toContain("a.ts");
		expect(html.renderResult("c1", "read", [{ type: "text", text: "hello" }], undefined, false)?.expanded).toContain("hello");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("bash 目标省掉 cd 到当前工作目录的前缀，cd 到别处保留", async () => {
	const { homedir } = await import("node:os");
	const { toolActionText } = await loadFirecodeModule("tools/actions.ts");
	const home = `${homedir()}/proj`;
	for (const [command, cwd, expected] of [
		["cd /project && bun test", "/project", "操作 $ bun test"],
		["cd \"/project\" && bun test", "/project", "操作 $ bun test"],
		["cd /project/ && bun test", "/project", "操作 $ bun test"],
		["cd ~/proj && bun test", home, "操作 $ bun test"],
		["cd /other && bun test", "/project", "操作 $ cd /other && bun test"],
		["cd /project/sub && ls", "/project", "操作 $ cd /project/sub && ls"],
	]) expect(toolActionText("bash", { command }, cwd)).toBe(expected);
});
