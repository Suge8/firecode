import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { FLAME, contextColor } from "../theme.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("状态栏观察员段随模块状态出现和消失", async () => {
	const { statusBadges } = await loadFirecodeModule("statusbar/render.js") as any;
	const statuses = new Map([
		["master", "👑 指挥模式"],
		["watcher", "👓 观察员在线"],
	]);

	expect(statusBadges(statuses, " ｜ ")).toBe("👑 指挥模式 ｜ 👓 观察员在线");
	statuses.delete("watcher");
	expect(statusBadges(statuses, " ｜ ")).toBe("👑 指挥模式");
});

test("指挥官状态栏按角色首字计数，空闲合并，无子代理时只有身份", async () => {
	const { masterStatusLine } = await loadFirecodeModule("master/index.js") as any;
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	const worker = (role: string, status: string) => ({ role, status });

	expect(masterStatusLine([
		worker("调研员", "working"),
		worker("调研员", "working"),
		worker("工程师", "reviewing"),
		worker("哨兵", "working"),
		worker("工程师", "idle"),
	], theme, 0)).toBe(`${FLAME.orange}👑 指挥模式\x1b[39m<dim> · ⠋ 调2·工1·哨1·闲1</dim>`);
	expect(masterStatusLine([], theme)).toBe(`${FLAME.orange}👑 指挥模式\x1b[39m`);
});

test("底栏活动动画只在有在飞子代理时开，全部落定即停", async () => {
	const { masterActive, masterStatusLine } = await loadFirecodeModule("master/index.js") as any;
	const theme = { fg: (_color: string, text: string) => text };

	expect(masterActive([])).toBe(false);
	expect(masterActive([{ role: "工程师", status: "idle" }])).toBe(false);
	expect(masterActive([{ role: "工程师", status: "working" }])).toBe(true);
	expect(masterActive([{ role: "工程师", status: "reviewing" }])).toBe(true);

	expect(stripVTControlCharacters(masterStatusLine([{ role: "工程师", status: "idle" }], theme, 3))).toBe("👑 指挥模式 · 闲1");
	expect(stripVTControlCharacters(masterStatusLine([{ role: "工程师", status: "working" }], theme, 3))).toMatch(/^👑 指挥模式 · \S 工1$/u);
});

test("未命名底栏即时取首条消息六个字，重命名和切树同源更新，绘制不扫描历史", async () => {
	const { registerStatusBar } = await loadFirecodeModule("statusbar/index.ts") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const events = new Map<string, Function>();
	let footer: any;
	let name: string | undefined;
	let scans = 0;
	let entries: any[] = [];
	const statuses = new Map<string, string>([
		["pi-openai-native-fast", "fast"], ["fire-review", "🔥 第 2 轮审查"],
	]);
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		model: { id: "test-model", reasoning: true, contextWindow: 200_000 },
		getContextUsage: () => ({ percent: 42.3, contextWindow: 200_000 }),
		sessionManager: {
			getCwd: () => "/project/firecode", getSessionName: () => name,
			getBranch: () => { scans++; return entries; },
			getEntries: () => { scans++; return entries; },
		},
		ui: { setFooter(factory: any) {
			footer = factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => statuses, getGitBranch: () => "main", onBranchChange: () => () => {} });
		} },
	};
	registerStatusBar({ on: (name: string, fn: Function) => events.set(name, fn), getThinkingLevel: () => "medium" });
	events.get("session_start")!({}, ctx);
	expect(footer.render(100)[0]).toBe("新会话");
	const message = { role: "user", content: [{ type: "text", text: "优化插件状态栏和工具展示" }] };
	events.get("message_start")!({ message }, ctx);
	expect(footer.render(100)[0]).toContain("优化插件状态…");
	entries.push({ type: "message", message });
	events.get("message_start")!({ message: { role: "user", content: "第二条消息" } }, ctx);
	expect(footer.render(100)[0]).toContain("优化插件状态…");
	name = "完整的自定义会话名称";
	events.get("session_info_changed")!({}, ctx);
	expect(footer.render(100)[0]).toContain(name);
	const before = scans;
	for (const width of [1, 12, 40, 100])
		for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	expect(scans).toBe(before);
	expect(footer.render(100)[1]).toBe("test-model/medium · Fast ｜ 📦 42.3%/200k");
	expect(footer.render(100)[1]).toContain("42.3%/200k");
	expect(footer.render(100).join("\n")).not.toMatch(/firecode|审查|📍|🧠|💬|⚡|🔋|♻️|t\/s|⏱|🌿/);
	name = undefined;
	entries = [];
	events.get("session_tree")!({}, ctx);
	expect(footer.render(100)[0]).toContain("新会话");
	expect(events.has("message_update")).toBe(false);
	events.get("session_shutdown")!({}, ctx);
	expect(footer).toBeUndefined();
});


test("上下文低占用保持灰色，仅接近既有阈值时警告", () => {
	expect(contextColor(0)).toBe("dim");
	expect(contextColor(49.9)).toBe("dim");
	expect(contextColor(50)).toBe("warning");
	expect(contextColor(75)).toBe("error");
	expect(contextColor(undefined)).toBe("muted");
});
