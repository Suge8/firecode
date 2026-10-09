import type { Lang } from "../i18n";

type Copy = {
	title: string;
	lede: string;
	caption: string;
	headTools: string;
	headChars: string;
	tools: (count: string) => string;
	/** 结论句按短语给出，方括号内为强调部分，{n} 处填倍数；中文每个短语占一行 */
	punch: string[];
	alsoTitle: string;
	also: { watch: string; preset: string; usage: string; rename: string; fast: string; login: string };
};

export const copy = {
	en: {
		title: "An ultra-light core.",
		lede: "Built the Pi way: sub-agents add just two small tools, and review and the watcher add none.",
		caption: "Sub-agent tool definitions sent to the model on every request, in characters. Measured October 2026.",
		headTools: "Sub-agent tools",
		headChars: "Characters",
		tools: (count) => `${count} tools`,
		punch: ["At its heaviest,", "pi-subagents costs [{n}×]", "what FireCode does,", "on every request"],
		alsoTitle: "Also in the box",
		also: {
			watch: "A cheap model keeps watch and speaks up only when work drifts",
			preset: "Switch model, thinking and tools in one go",
			usage: "Usage at a glance",
			rename: "Rename the session",
			fast: "Toggle OpenAI Fast mode",
			login: "Works with Claude subscription login",
		},
	},
	zh: {
		title: "核心极轻",
		lede: "完美契合 Pi 原生的极简思路：子代理只加两个小工具，审查和观察员一个都不加。",
		caption: "子代理工具在每次请求里发给模型的定义字符数，2026\u00a0年\u00a010\u00a0月实测。",
		headTools: "子代理工具",
		headChars: "字符数",
		tools: (count) => `${count} 个工具`,
		punch: ["最重的时候", "pi-subagents 每次请求的开销", "是 FireCode 的 [{n} 倍]"],
		alsoTitle: "还有这些",
		also: {
			watch: "便宜模型帮你盯着，跑偏才开口",
			preset: "一键切换模型、思考档和工具",
			usage: "随时看用量",
			rename: "改会话名",
			fast: "开关 OpenAI 加速档",
			login: "适配 Claude 订阅登录",
		},
	},
} satisfies Record<Lang, Copy>;
