import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule, PI_TUI_URL } from "./loader.ts";

afterEach(cleanupFirecodeModules);

async function harness(mode = "tui", theme = { fg: (_color: string, text: string) => text }) {
	const { registerRunSummary } = await loadFirecodeModule("session/run-summary.ts") as any;
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: any }> = [];
	let renderer: Function;
	let time = 0;
	let idle = true;
	let abort = new AbortController();
	const ctx = { mode, isIdle: () => idle, get signal() { return idle ? undefined : abort.signal; } };
	registerRunSummary({
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerEntryRenderer: (_name: string, render: Function) => { renderer = render; },
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	}, () => time);
	const emit = (name: string, event = {}, at = time) => {
		time = at;
		if (name === "agent_start") { idle = false; abort = new AbortController(); }
		if (name === "agent_settled") idle = true;
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	emit("session_start");
	const message = (output: number, stopReason = "stop") => ({ message: { role: "assistant", usage: { output }, stopReason } });
	const render = (data = entries.at(-1)?.data, width = 100, expanded = false) => renderer!({ data }, { expanded }, theme).render(width);
	return { emit, entries, message, render, handlers, abort: () => abort.abort() };
}

test("收尾只在处理段歇透时写一次，均速排除工具等待，插话与续跑不重置起点", async () => {
	const s = await harness();
	s.emit("input", { source: "interactive" }, 0);
	s.emit("before_agent_start", {}, 100);
	s.emit("agent_start", {}, 200);
	s.emit("before_provider_request", {}, 1_000);
	s.emit("message_end", s.message(800, "toolUse"), 11_000);
	s.emit("input", { source: "interactive", streamingBehavior: "steer" }, 15_000);
	s.emit("agent_end", {}, 16_000);
	expect(s.entries).toEqual([]);
	s.emit("agent_start", {}, 40_000);
	s.emit("before_provider_request", {}, 41_000);
	s.emit("message_end", s.message(400), 61_000);
	s.emit("agent_end", {}, 61_000);
	expect(s.entries).toEqual([]);
	s.emit("agent_settled", {}, 65_000);
	s.emit("agent_settled", {}, 70_000);
	expect(s.entries).toEqual([{ customType: "firecode-run-summary", data: { elapsedMs: 65_000, outcome: "complete", tps: 40 } }]);
	expect(s.render()).toEqual([" ◷ 处理 1m5s  ·  ↗ 均速 40 tps"]);
	expect(s.render(undefined, 100, true)).toEqual(s.render());
	expect(s.handlers.has("message_update")).toBe(false);
});

test("时长始终在左，右侧只显示有效均速或终态，未知统计不会显示假零", async () => {
	const s = await harness();
	s.emit("agent_start", {}, 1_000);
	s.emit("message_end", s.message(400), 8_000);
	s.emit("agent_settled", {}, 9_000);
	expect(s.entries[0].data).toEqual({ elapsedMs: 8_000, outcome: "complete" });
	expect(s.render()).toEqual([" ◷ 处理 8.0s"]);
	expect(s.render({ elapsedMs: 15_217_000, outcome: "complete", tps: 58.1 }))
		.toEqual([" ◷ 处理 4h13m37s  ·  ↗ 均速 58.1 tps"]);
	const { visibleWidth } = await import(PI_TUI_URL);
	for (const outcome of ["complete", "aborted", "error"]) {
		const data = { elapsedMs: 18_000, outcome, ...(outcome === "complete" ? { tps: 42 } : {}) };
		const line = s.render(data)[0];
		expect(line).toStartWith(" ◷ 处理 18s  ·  ");
		expect(line).toContain(outcome === "complete" ? "均速 42 tps" : outcome === "aborted" ? "已中断" : "请求失败");
		for (const width of [0, 1, 12, 24, 80]) {
			const lines = s.render(data, width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
	}
	expect(() => s.render({ elapsedMs: -1, outcome: "complete" })).toThrow("处理摘要数据无效");
});

test("工具期间取消仍显示中断，失败或缺失统计后的续跑不伪造整段均速", async () => {
	const s = await harness();
	s.emit("agent_start");
	s.emit("before_provider_request");
	s.emit("message_end", s.message(100, "toolUse"), 1_000);
	s.abort();
	s.emit("agent_settled", {}, 18_000);
	expect(s.entries[0].data).toEqual({ elapsedMs: 18_000, outcome: "aborted" });
	s.emit("agent_start", {}, 20_000);
	s.emit("before_provider_request", {}, 21_000);
	s.emit("message_end", s.message(0, "error"), 22_000);
	s.emit("agent_end");
	s.emit("agent_start", {}, 24_000);
	s.emit("before_provider_request", {}, 25_000);
	s.emit("message_end", s.message(200), 27_000);
	s.emit("agent_settled", {}, 28_000);
	expect(s.entries[1].data).toEqual({ elapsedMs: 8_000, outcome: "complete" });
	s.emit("agent_start", {}, 30_000);
	s.emit("before_provider_request", {}, 31_000);
	s.emit("message_end", s.message(0, "error"), 32_000);
	s.emit("agent_settled", {}, 33_000);
	expect(s.entries[2].data).toEqual({ elapsedMs: 3_000, outcome: "error" });
});

test("压缩请求不计入助手均速，重载丢弃未完成测量，无头会话零摘要", async () => {
	const s = await harness();
	s.emit("agent_start");
	s.emit("before_provider_request");
	s.emit("message_end", s.message(100), 1_000);
	s.emit("session_before_compact", {}, 2_000);
	s.emit("before_provider_request", {}, 3_000);
	s.emit("session_compact", {}, 10_000);
	s.emit("before_provider_request", {}, 11_000);
	s.emit("message_end", s.message(200), 13_000);
	s.emit("agent_settled", {}, 14_000);
	expect(s.entries[0].data).toEqual({ elapsedMs: 14_000, outcome: "complete", tps: 100 });
	s.emit("agent_start", {}, 20_000);
	s.emit("session_shutdown", {}, 25_000);
	s.emit("message_end", s.message(200));
	s.emit("agent_settled");
	expect(s.entries).toHaveLength(1);
	s.emit("session_start");
	s.emit("agent_start", {}, 50_000);
	s.emit("message_end", s.message(200), 51_000);
	s.emit("agent_settled", {}, 52_000);
	expect(s.entries[1].data.elapsedMs).toBe(2_000);
	s.emit("agent_start", {}, 60_000);
	s.emit("before_provider_request", {}, 61_000);
	s.emit("message_end", s.message(100), 62_000);
	s.emit("session_before_compact");
	s.emit("session_compact_failed", { aborted: true }, 63_000);
	s.emit("agent_settled", {}, 64_000);
	expect(s.entries[2].data).toEqual({ elapsedMs: 4_000, outcome: "aborted" });
	const headless = await harness("print");
	headless.emit("input", { source: "interactive" });
	headless.emit("before_agent_start");
	headless.emit("agent_start");
	headless.emit("before_provider_request");
	headless.emit("message_end", headless.message(100), 1_000);
	headless.emit("agent_settled");
	expect(headless.entries).toEqual([]);
});

test("真实 SDK 续跑只产生一个收尾，展示记录可恢复且不进入下一次模型请求", async () => {
	const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { PI_CODING_AGENT_URL, PI_AI_URL } = await import("./loader.ts");
	const { createAgentSession, ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL);
	const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(PI_AI_URL);
	const { registerRunSummary } = await loadFirecodeModule("session/run-summary.ts") as any;
	const directory = await mkdtemp(join(tmpdir(), "firecode-run-summary-"));
	const bridge = `firecode-summary-test-${crypto.randomUUID()}`;
	(globalThis as any)[Symbol.for(bridge)] = registerRunSummary;
	let session: any;
	try {
		const agentDir = join(directory, "agent");
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		await writeFile(join(agentDir, "extensions", "summary.ts"), `export default function(pi) {
			globalThis[Symbol.for(${JSON.stringify(bridge)})](pi);
			let continued = false;
			pi.on("agent_end", () => {
				if (continued) return;
				continued = true;
				pi.sendMessage({ customType: "test-continuation", content: "continue", display: false }, { deliverAs: "followUp" });
			});
		}`);
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		runtime.registerNativeProvider(faux.provider);
		const requests: any[] = [];
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first"), fauxAssistantMessage("continued"), fauxAssistantMessage("next"),
		].map((response: any) => async (context: any, options: any, _state: unknown, model: any) => {
			await options.onPayload({ input: context.messages }, model);
			requests.push(structuredClone(context.messages));
			return response;
		}));
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		({ session } = await createAgentSession({
			cwd: directory, agentDir, model: faux.getModel(), modelRuntime: runtime, sessionManager: manager,
			tools: ["probe"], customTools: [{
				name: "probe", label: "Probe", description: "Returns a fixed tool result",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			}],
		}));
		await session.bindExtensions({ mode: "tui" });
		const appended: any[] = [];
		session.subscribe((event: any) => {
			if (event.type === "entry_appended" && event.entry.customType === "firecode-run-summary") appended.push(event.entry);
		});
		await session.prompt("start");
		expect(requests).toHaveLength(3);
		expect(appended).toHaveLength(1);
		expect(appended[0].data.outcome).toBe("complete");
		expect(appended[0].data.tps).toBeGreaterThan(0);
		await session.prompt("next input");
		expect(requests).toHaveLength(4);
		expect(appended).toHaveLength(2);
		expect(JSON.stringify(requests)).not.toMatch(/firecode-run-summary|elapsedMs/);
		expect(session.messages.at(-1).stopReason).toBe("stop");
		const restored = SessionManager.open(manager.getSessionFile()).getEntries()
			.filter((entry: any) => entry.type === "custom" && entry.customType === "firecode-run-summary");
		expect(restored.map((entry: any) => entry.data)).toEqual(appended.map((entry) => entry.data));
	} finally {
		session?.dispose();
		delete (globalThis as any)[Symbol.for(bridge)];
		await rm(directory, { recursive: true, force: true });
	}
}, 10_000);

test("真实明暗主题中收尾保持单行，窄屏不截坏颜色控制码", async () => {
	const { PI_CODING_AGENT_URL } = await import("./loader.ts");
	const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.ts", PI_CODING_AGENT_URL).href);
	const { stripVTControlCharacters } = await import("node:util");
	const { visibleWidth } = await import(PI_TUI_URL);
	const s = await harness("tui", theme);
	for (const appearance of ["dark", "light"]) {
		initTheme(appearance);
		for (const outcome of ["complete", "aborted", "error"]) {
			const data = { elapsedMs: 138_000, outcome, ...(outcome === "complete" ? { tps: 42 } : {}) };
			expect(stripVTControlCharacters(s.render(data)[0])).toStartWith(" ◷ 处理 2m18s  ·  ");
			for (const width of [1, 12, 24, 80]) {
				const lines = s.render(data, width);
				expect(lines).toHaveLength(1);
				expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
				expect(stripVTControlCharacters(lines[0])).not.toContain("\x1b");
			}
		}
	}
});
