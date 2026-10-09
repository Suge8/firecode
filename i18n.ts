/**
 * 双语文案的唯一机制。语言由 config.jsonc 顶层 language 决定，省略时跟随系统 locale（zh 开头为中文，其余英文）；
 * 模块加载时定下，改语言重启生效，所以文案表是普通对象，调用处不传语言。
 * 用法：每个目录一个 messages.ts，`export const msg = defineMessages({ zh: {...}, en: {...} })`；
 * en 与 zh 的键、嵌套、函数参数必须一致（类型检查守）。带参数的文案写成函数。
 * 给模型看的提示词按语言分文件 <name>.zh.md / <name>.en.md，用 readPrompt 读。
 */
import { readFileSync } from "node:fs";
import { readConfigFile } from "./config-file.js";

const LANGUAGES = ["zh", "en"] as const;
type Language = (typeof LANGUAGES)[number];

export function parseLanguage(value: unknown): Language | undefined {
	return LANGUAGES.find((language) => language === value);
}

function inferLanguage(locale: string | undefined): Language {
	return /^zh/iu.test(locale ?? "") ? "zh" : "en";
}

/** POSIX 的消息语言优先级；都没设置（如图形界面启动）才退回运行时的默认 locale。 */
function systemLocale(): string {
	const { LC_ALL, LC_MESSAGES, LANG } = process.env;
	return LC_ALL || LC_MESSAGES || LANG || Intl.DateTimeFormat().resolvedOptions().locale;
}

const LANGUAGE: Language = parseLanguage(readConfigFile().raw.language) ?? inferLanguage(systemLocale());

type Messages = { readonly [key: string]: string | ((...args: never[]) => string) | Messages };
/** 与 zh 同形的表：字符串对字符串，函数对同参数的函数，嵌套逐层对齐。 */
type Counterpart<T> = T extends string ? string
	: T extends (...args: infer Args) => string ? (...args: Args) => string
	: { [Key in keyof T]: Counterpart<T[Key]> };

export function defineMessages<T extends Messages>(tables: { zh: T; en: NoInfer<Counterpart<T>> }): T {
	return tables[LANGUAGE] as T;
}

/** 读 `<name>.<语言>.md`；dir 由调用方以 `new URL("./prompts/", import.meta.url)` 给出（构建据此改写打包后的位置）。 */
export function readPrompt(dir: URL, name: string): string {
	return readFileSync(new URL(`${name}.${LANGUAGE}.md`, dir), "utf8");
}
