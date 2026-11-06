import type { Lang } from "../i18n";

type Copy = {
	title: string;
	lede: string;
	caption: string;
	tools: (count: string) => string;
	/** 结论句按短语给出，方括号内为强调部分，{name} 处填最重的那个、{n} 处填倍数；中文每个短语占一行 */
	punch: string[];
	alsoTitle: string;
	also: { usage: string; rename: string; fast: string; login: string };
};

export const copy = {
	en: {
		title: "An ultra-light core.",
		lede: "Built the Pi way: sub-agents add just two small tools, and review adds none.",
		caption: "Sub-agent tool definitions sent to the model on every request, in characters.",
		tools: (count) => `${count} tools`,
		punch: ["At its heaviest,", "{name} costs [{n}×]", "what FireCode does,", "on every request"],
		alsoTitle: "Also in the box",
		also: {
			usage: "Usage at a glance",
			rename: "Rename the session",
			fast: "Toggle OpenAI Fast mode",
			login: "Works with Claude subscription login",
		},
	},
	zh: {
		title: "核心极轻",
		lede: "完美契合 Pi 原生的极简思路：子代理只加两个小工具，审查一个都不加。",
		caption: "子代理工具在每次请求里发给模型的定义字符数。",
		tools: (count) => `${count} 个工具`,
		punch: ["最重的时候", "{name} 每次请求的开销", "是 FireCode 的 [{n} 倍]"],
		alsoTitle: "还有这些",
		also: {
			usage: "随时看用量",
			rename: "改会话名",
			fast: "开关 OpenAI 加速档",
			login: "适配 Claude 订阅登录",
		},
	},
} satisfies Record<Lang, Copy>;
