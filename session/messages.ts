/** session/ 的文案：预设、额度查询、用量统计、herdr 侧边栏标签。 */
import { defineMessages } from "../i18n.js";

export const msg = defineMessages({
	zh: {
		quota: {
			commandDescription: "查询 Codex、Claude 和 Fable 的订阅剩余额度，不打断当前任务",
			usage: "用法：/quota",
			inFlight: "额度正在查询，请稍候",
			querying: "正在查询订阅额度…",
			report: (time: string, lines: string[]) => `订阅剩余额度 · 查询于 ${time}\n${lines.join("\n")}`,
			window: {
				week: "本周",
				fiveHours: "5小时",
				days: (count: number) => `${count}天`,
				hours: (count: number) => `${count}小时`,
				fable: "Fable 本周",
			},
			remaining: (label: string, percent: number) => `${label}剩余 ${percent}%`,
			fableMissing: (label: string) => `${label}：未提供独立额度`,
			provider: (name: string, body: string) => `${name}：${body}`,
			separator: " ｜ ",
			notOAuth: (name: string) => `${name}：未通过 Pi OAuth 登录`,
			failed: (name: string, reason: string) => `${name}：查询失败（${reason}）`,
			noToken: "未取得 OAuth 登录凭据",
			changedFormat: "额度响应格式已变化",
			codexTokenInvalid: "Codex 登录凭据无效",
			codexTokenNoAccount: "Codex 登录凭据缺少账户信息",
		},
		stats: {
			commandDescription: "统计会话 token 与成本，参数为天数：默认 30，0 表示全部",
			completion: { week: "最近 7 天", month: "最近 30 天（默认）", all: "全部历史" },
			usage: "用法：/tokens [天数]，天数为整数，省略为 30，0 表示全部",
			counting: (days: number) => `统计中（${days === 0 ? "全部历史" : `最近 ${days} 天`}）…`,
			close: "Enter / Esc 关闭",
			title: "# Token 用量",
			range: (days: number, from: string, to: string) => (days === 0 ? "全部" : `最近 ${days} 天（${from} ~ ${to}）`),
			rangeLine: (range: string) => `- 范围：${range}`,
			sessionsLine: (matched: string, scanned: string) => `- 会话：命中 ${matched} / 扫描 ${scanned} 个文件`,
			requestsLine: (requests: string, cost: string) => `- 请求：${requests} 次，合计 ${cost}`,
			unreadableLine: (count: string) => `- 无法读取：${count} 个文件或目录，其中的用量未计入`,
			byModel: "## 按模型",
			empty: "该范围内没有用量记录。",
			column: { model: "模型", requests: "请求", input: "输入", output: "输出", cacheRead: "缓存读", cacheWrite: "缓存写", tokens: "总 Token", cost: "成本" },
			compact: (value: number, plain: string) =>
				value >= 100_000_000 ? `${(value / 100_000_000).toFixed(1)}亿`
				: value >= 10_000 ? `${(value / 10_000).toFixed(1)}万`
				: plain,
		},
		herdr: { review: "对抗审查进行中", workers: "子代理进行中" },
	},
	en: {
		quota: {
			commandDescription: "Show remaining Codex, Claude and Fable subscription quota without interrupting the current task",
			usage: "Usage: /quota",
			inFlight: "A quota query is already running; please wait",
			querying: "Querying subscription quota…",
			report: (time: string, lines: string[]) => `Remaining subscription quota · queried at ${time}\n${lines.join("\n")}`,
			window: {
				week: "Weekly",
				fiveHours: "5h",
				days: (count: number) => `${count}d`,
				hours: (count: number) => `${count}h`,
				fable: "Fable weekly",
			},
			remaining: (label: string, percent: number) => `${label} ${percent}% left`,
			fableMissing: (label: string) => `${label}: no separate quota reported`,
			provider: (name: string, body: string) => `${name}: ${body}`,
			separator: " | ",
			notOAuth: (name: string) => `${name}: not signed in through Pi OAuth`,
			failed: (name: string, reason: string) => `${name}: query failed (${reason})`,
			noToken: "No OAuth credential available",
			changedFormat: "The quota response format has changed",
			codexTokenInvalid: "Codex credential is invalid",
			codexTokenNoAccount: "Codex credential has no account information",
		},
		stats: {
			commandDescription: "Token and cost statistics over sessions; the argument is days: default 30, 0 means all",
			completion: { week: "Last 7 days", month: "Last 30 days (default)", all: "All history" },
			usage: "Usage: /tokens [days], an integer; default 30, 0 means all",
			counting: (days: number) => `Collecting usage (${days === 0 ? "all history" : `last ${days} days`})…`,
			close: "Enter / Esc to close",
			title: "# Token usage",
			range: (days: number, from: string, to: string) => (days === 0 ? "All" : `Last ${days} days (${from} ~ ${to})`),
			rangeLine: (range: string) => `- Range: ${range}`,
			sessionsLine: (matched: string, scanned: string) => `- Sessions: ${matched} matched of ${scanned} files scanned`,
			requestsLine: (requests: string, cost: string) => `- Requests: ${requests}, ${cost} in total`,
			unreadableLine: (count: string) => `- Unreadable: ${count} files or directories; their usage is not counted`,
			byModel: "## By model",
			empty: "No usage recorded in this range.",
			column: { model: "Model", requests: "Requests", input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write", tokens: "Total tokens", cost: "Cost" },
			compact: (value: number, plain: string) =>
				value >= 1_000_000_000 ? `${(value / 1_000_000_000).toFixed(1)}B`
				: value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
				: value >= 10_000 ? `${(value / 1_000).toFixed(1)}K`
				: plain,
		},
		herdr: { review: "Adversarial review running", workers: "Workers running" },
	},
});
