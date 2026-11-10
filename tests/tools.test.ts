import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFirecodeModule, PI_CODING_AGENT_URL } from "./loader.ts";

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
		expect(session.systemPrompt).toContain("edits[].oldText");
		const bash = session.agent.state.tools.find((tool: { name: string }) => tool.name === "bash");
		const output = await bash.execute("id", { command: "echo $FROM_PREFIX" }, undefined, undefined, undefined);
		// 只看命令自己的输出行：没有 zh_CN locale 的机器（CI）上 bash 会另打一行 setlocale 警告，先后随运行环境而变。
		expect(output.content[0].text.split("\n")).toContain("ok");

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
