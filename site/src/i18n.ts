export type Lang = "en" | "zh";

// 页面级共享文案；各区块自己的文案放在 sections/<名字>.copy.ts，结构与这里相同。
// 标语与简介不在这里：它们只来自 README（见 repo.ts）
export const site = {
	en: {
		tag: "en",
		ogLocale: "en_US",
		title: "FireCode — sub-agents and adversarial review for Pi",
		copy: "Copy install command",
		copied: "Copied",
		copyFailed: "Couldn't copy, select the command instead",
		switchLabel: "中文",
		home: "/",
	},
	zh: {
		tag: "zh-CN",
		ogLocale: "zh_CN",
		title: "FireCode — 给 Pi 的并行子代理与对抗性审查",
		copy: "复制安装命令",
		copied: "已复制",
		copyFailed: "复制失败，请手动选中命令",
		switchLabel: "EN",
		home: "/zh/",
	},
} satisfies Record<Lang, Record<string, string>>;

export const other = (lang: Lang): Lang => (lang === "en" ? "zh" : "en");

export const INSTALL = "pi install npm:pi-firecode";
export const REPO = "https://github.com/Suge8/firecode";
export const NPM = "https://www.npmjs.com/package/pi-firecode";
