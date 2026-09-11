import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { FLAME, contextColor } from "../theme.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

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
	expect(footer.render(100)[0]).toContain("新会话");
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
	for (let width = 0; width <= 120; width++) {
		const lines = footer.render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
	}
	expect(scans).toBe(before);
	expect(footer.render(100)).toHaveLength(1);
	expect(footer.render(100)[0]).toContain("test-model/medium · Fast ｜ 42.3%/200k");
	expect(footer.render(100)[0]).not.toContain("审查");
	statuses.set("watcher", "观察员");
	statuses.set("master", "\x1b[33m👑 指挥模式 · ⠋ 工1\x1b[39m");
	expect(stripVTControlCharacters(footer.render(160)[0])).toEndWith(" ｜ 观察员 ｜ 👑 指挥模式 · ⠋ 工1");
	statuses.delete("watcher");
	statuses.delete("master");
	statuses.delete("pi-openai-native-fast");
	expect(footer.render(160)[0]).toBe(`${name} ｜ test-model/medium ｜ 42.3%/200k`);
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

test("单行布局按显示宽度退让，保完整百分比与 Fast，不解读模块彩色串", async () => {
	const { fitFooter, renderContext } = await loadFirecodeModule("statusbar/render.js") as any;
	const { visibleWidth } = await import((await import("./loader.ts")).PI_TUI_URL);
	const paint = (text: string) => `\x1b[38;2;120;130;140m${text}\x1b[39m`;
	const theme = { fg: (_color: string, text: string) => paint(text) };
	for (const title of ["会话", "中文👩‍💻🚀长标题".repeat(30)]) {
		for (const fast of ["", paint("Fast")]) {
			for (const watcher of ["", paint("观察员")]) {
				for (const master of ["", paint("👑 指挥模式"), paint("👑 指挥模式 · ⠹ 调2·工1·闲1")]) {
					for (const percent of [0, 42.3, 100, undefined]) {
						const parts = {
							title: paint(title), model: paint("模型🚀/high"), fast, watcher, master,
							masterCompact: master ? paint("👑") : "",
							context: renderContext(theme, percent, 1_100_000),
							contextCompact: renderContext(theme, percent, 1_100_000, true),
						};
						const full = stripVTControlCharacters(fitFooter(parts, 2000, paint(" ｜ ")));
						expect(full).toBe([title, `模型🚀/high${fast ? " · Fast" : ""}`,
							`${percent == null ? "?" : `${percent.toFixed(1)}%`}/1.1M`,
							stripVTControlCharacters(watcher), stripVTControlCharacters(master)].filter(Boolean).join(" ｜ "));
						for (let width = 0; width <= 120; width++) {
							const line = fitFooter(parts, width, paint(" ｜ "));
							const plain = stripVTControlCharacters(line);
							expect(visibleWidth(line)).toBeLessThanOrEqual(width);
							expect(plain.split("\n")).toHaveLength(1);
							const percentage = percent == null ? "?" : `${percent.toFixed(1)}%`;
							if (width < visibleWidth(percentage)) expect(plain).toBe("");
							else expect(plain).toContain(percentage);
							if (fast && width >= visibleWidth(`Fast ｜ ${percentage}`)) expect(plain).toContain("Fast");
						}
					}
				}
			}
		}
	}
});

test("窄屏依次裁标题、省模块详情、省容量、裁模型，极窄省标题模式", async () => {
	const { fitFooter } = await loadFirecodeModule("statusbar/render.js") as any;
	const parts = {
		title: "中文🚀长会话标题".repeat(5), model: "GPT-5.4/high", fast: "Fast",
		context: "0.0%/1.1M", contextCompact: "0.0%", watcher: "观察员",
		master: "👑 指挥模式 · ⠋ 调2·工1·闲1", masterCompact: "👑",
	};
	for (const [width, expected] of [
		[80, "中… ｜ GPT-5.4/high · Fast ｜ 0.0%/1.1M ｜ 观察员 ｜ 👑 指挥模式 · ⠋ 调2·工1·闲1"],
		[60, "中文🚀长会话标题… ｜ GPT-5.4/high · Fast ｜ 0.0%/1.1M ｜ 👑"],
		[40, "中… ｜ GPT-5.4/high · Fast ｜ 0.0% ｜ 👑"],
		[30, "… ｜ GPT… · Fast ｜ 0.0% ｜ 👑"],
		[20, "GPT-… · Fast ｜ 0.0%"],
		[12, "Fast ｜ 0.0%"],
		[4, "0.0%"],
		[3, ""],
	] as const) expect(fitFooter(parts, width, " ｜ ")).toBe(expected);
});
