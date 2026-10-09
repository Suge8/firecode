import type { Lang } from "../i18n";

// 标题与说明都按行给出，渲染时每项固定占一行
export const copy = {
	en: {
		title: ["One install.", "Works out of the box."],
		lede: ["Restart Pi (1.1.0+) and it's ready.", "The config is created on first launch."],
		contributing: "Contributing",
		license: "MIT © Suge8",
	},
	zh: {
		title: ["装一个就够", "开箱即用"],
		lede: ["重启 Pi（1.1.0 及以上）就能用，", "配置文件首次启动时自动生成。"],
		contributing: "参与开发",
		license: "MIT © Suge8",
	},
} satisfies Record<Lang, Record<string, string | string[]>>;
