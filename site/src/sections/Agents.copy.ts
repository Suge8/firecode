import type { Lang } from "../i18n";

// 三个目录的统计取自 hero 录屏的末帧（og 图里的汇总表），两种语言共用同一份
export const tallies = [
	{ dir: "master/", files: "21", lines: "3,438", largest: "worker-view.ts", largestLines: "516" },
	{ dir: "review/", files: "18", lines: "4,177", largest: "index.ts", largestLines: "879" },
	{ dir: "tools/", files: "16", lines: "2,124", largest: "group-view.ts", largestLines: "420" },
] as const;

// 演示里出故障并切到 fallback 的那一个：录屏中 review/ 也是最后一个回来的
export const FALLBACK_INDEX = 1;

// 角色模型取自 config.example.jsonc：researcher 的主模型与 fallback，engineer 的主模型
export const models = { primary: "claude-haiku-5-5/low", fallback: "gpt-6-luna/medium", engineer: "claude-sonnet-5-5/high" } as const;

// 子代理视图里的固定部分，取自 shot-worker-view 截图
export const worker = { name: "parse-duration", model: "anthropic/claude-sonnet-5-5/high" } as const;

export const copy = {
	en: {
		title: "Sub-agents under control.",
		lede: "Run them in parallel, pick a model per role, switch automatically on failure, step in any time.",
		beats: [
			{ title: "Run them in parallel", body: "One request, three researchers. Each works in its own session, at the same time." },
			{ title: "A model for every role", body: "Researchers run on a fast, cheap model; engineers get a stronger one. Set it once per role." },
			{ title: "Switch on failure", body: "When a provider fails, the sub-agent moves to the next model in its role's list and carries on in the same session." },
			{ title: "One table back", body: "The three reports come home to the commander, merged into the single table you asked for." },
		],
		task: "Dispatch 3 researchers in parallel to count the files, total lines and largest file of master/, review/ and tools/ each, then report back with just one summary table",
		agent: (dir: string) => `count-${dir}`,
		role: "researcher",
		engineer: "engineer",
		countCmd: (dir: string) => `$ find ${dir} -type f | wc -l`,
		linesCmd: (dir: string) => `$ wc -l ${dir}**/*`,
		files: (n: string) => `→ ${n} files`,
		lines: (n: string) => `→ ${n} lines`,
		largest: (file: string, n: string) => `→ largest: ${file} (${n})`,
		fault: "✕ anthropic · overloaded",
		switched: (model: string) => `↻ switched → ${model}`,
		paneDone: "✓ Done",
		thinking: "Thinking",
		allDone: "3 done",
		working: "Working",
		waiting: "Waiting for 3 workers",
		master: "Master",
		table: { dir: "Directory", files: "Files", lines: "Total lines", largest: "Largest file" },
		closing: "The counts are the researchers' own and I didn't re-run them.",
		terminalLabel: "Replay of a FireCode session: the commander dispatches three researchers and merges their counts into one table",
		detailTitle: "Step in any time",
		detailBody: "Every sub-agent sits above the input box. Click one to read its whole run and talk to it directly.",
		workerLabel: "A sub-agent's own view: its full run, with a follow-up typed into its own input box",
		// 反引号里的片段按代码着色
		followup: "Also check what 0s and an empty string return",
		answer: [
			"Your two cases",
			"- `parseDuration(\"0s\")` returns `0`.",
			"- `parseDuration(\"\")` throws `Invalid duration: `. The same happens for anything that isn't a run of `<digits><unit>` pairs, such as `\"abc\"`. It never returns `NaN`.",
		],
		workerDone: "✓ Done 31s",
		placeholder: "Say something to this Worker, Enter to send",
		hints: ["Tab switch Worker", "click summary to expand", "ctrl+o expand all", "esc back"],
	},
	zh: {
		title: "子代理可控",
		lede: "并行跑，每个角色独立选模型，出故障自动切换，随时点开干预。",
		beats: [
			{ title: "并行跑", body: "一句话派出三个调研员，各开一个会话，同时开工。" },
			{ title: "每个角色独立选模型", body: "调研员用又快又省的模型，工程师用更强的。按角色配一次就行。" },
			{ title: "出故障自动切换", body: "供应商出故障时，子代理换到这个角色的下一个模型，在同一个会话里接着干。" },
			{ title: "汇总成一张表", body: "三份结果回到指挥官手里，合成你要的那一张表。" },
		],
		task: "派 3 个调研员并行：分别统计 master/、review/、tools/ 的文件数、总行数和最大的文件，回来只给一张汇总表",
		agent: (dir: string) => `stat-${dir}`,
		role: "调研员",
		engineer: "工程师",
		countCmd: (dir: string) => `$ find ${dir} -type f | wc -l`,
		linesCmd: (dir: string) => `$ wc -l ${dir}**/*`,
		files: (n: string) => `→ ${n} 个文件`,
		lines: (n: string) => `→ 共 ${n} 行`,
		largest: (file: string, n: string) => `→ 最大：${file}（${n}）`,
		fault: "✕ anthropic · 过载",
		switched: (model: string) => `↻ 已切换 → ${model}`,
		paneDone: "✓ 完成",
		thinking: "思考中",
		allDone: "3 个已完成",
		working: "处理中",
		waiting: "等待 3 个子代理",
		master: "指挥官",
		table: { dir: "目录", files: "文件数", lines: "总行数", largest: "最大文件" },
		closing: "数字是调研员自己统计的，我没有重跑。",
		terminalLabel: "FireCode 会话回放：指挥官派出三个调研员，把统计结果合成一张表",
		detailTitle: "随时点开干预",
		detailBody: "每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。",
		workerLabel: "子代理自己的视图：完整过程，并在它自己的输入框里补一句话",
		followup: "顺便确认 0s 和空串的行为",
		answer: [
			"已实测确认：",
			"- `parseDuration(\"0s\")` 返回 `0`，不抛错。`formatSeconds(0)` 输出 `\"0s\"`，两者互为逆运算。",
			"- `parseDuration(\"\")` 抛错：`invalid duration: \"\"`。空串测试已在非法输入用例里。",
		],
		workerDone: "✓ 完成 35s",
		placeholder: "补话给这个子代理，回车发送",
		hints: ["Tab 换子代理", "点摘要展开", "ctrl+o 全部展开", "esc 返回"],
	},
} satisfies Record<Lang, Record<string, unknown>>;
