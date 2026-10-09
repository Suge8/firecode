import type { Lang } from "../i18n";

// lede 按句拆开：每句整体换行，中文不会在词中间断开
export const copy = {
	en: {
		headline: ["Install one extension.", "Uninstall the rest."],
		lede: ["Parallel sub-agents, multi-model code review and a cleaner terminal for Pi.", "One install, works out of the box."],
	},
	zh: {
		headline: ["只装这一个扩展", "其余都可以卸了"],
		lede: ["给 Pi 加上并行子代理、多模型代码审查和更干净的终端界面。", "装一个就够，开箱即用。"],
	},
} satisfies Record<Lang, Record<string, string[]>>;
