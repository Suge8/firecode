export type Lang = "en" | "zh";

// 页面级共享文案；各区块自己的文案放在 sections/<名字>.copy.ts，结构与这里相同
export const site = {
	en: {
		title: "FireCode — sub-agents and adversarial review for Pi",
		description: "Parallel sub-agents, multi-model code review and a cleaner terminal for Pi. One install, works out of the box.",
		copy: "Copy install command",
		copied: "Copied",
		switchLabel: "中文",
		switchHref: "/zh/",
		home: "/",
	},
	zh: {
		title: "FireCode — 给 Pi 的并行子代理与对抗性审查",
		description: "给 Pi 加上并行子代理、多模型代码审查和更干净的终端界面。装一个就够，开箱即用。",
		copy: "复制安装命令",
		copied: "已复制",
		switchLabel: "EN",
		switchHref: "/",
		home: "/zh/",
	},
} satisfies Record<Lang, Record<string, string>>;

export const INSTALL = "pi install npm:pi-firecode";
export const REPO = "https://github.com/Suge8/firecode";
export const NPM = "https://www.npmjs.com/package/pi-firecode";
