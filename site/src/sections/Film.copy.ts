import type { Lang } from "../i18n";

// 宣传片本身的文案在 firecode-promo 仓库；这里只有区块的标题、说明和播放控件的无障碍文字
export const copy = {
	en: {
		title: "FireCode in under a minute.",
		lede: "One sentence sends sub-agents to work in parallel. Each result is reviewed, rejected work goes back to be fixed, and the commander reviews the merged result before delivery.",
		videoLabel: "FireCode film: one sentence in, sub-agents work in parallel and are reviewed one by one, the rejected one is fixed, and the commander's final review comes before delivery",
		play: "Play the film",
		pause: "Pause the film",
	},
	zh: {
		title: "一分钟看懂",
		lede: "你说一句话，指挥官派出子代理并行干活。每份结果各自送审，没过的打回重修，汇总后指挥官再终审一遍，审过的才交到你手里。",
		videoLabel: "FireCode 宣传片：一句话进来，子代理并行干活、各自送审，没过的打回重修，指挥官终审后交付",
		play: "播放宣传片",
		pause: "暂停宣传片",
	},
} satisfies Record<Lang, Record<string, string>>;
