import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../jsonc";
import { INSTALL, NPM, REPO, type Lang } from "./i18n";

// 构建期从仓库读的事实：标语、对比表与给 Agent 的 Markdown 只从 README 来，演示里的角色模型只从随包配置模板来。
// 表格按表头文字定位（README 结构会变，表格格式不变）；找不到就让构建失败，不拿旧文案顶上。
// Astro 构建时的工作目录是 site/，仓库根在上一级
const root = join(process.cwd(), "..");
const BLOB = `${REPO}/blob/main/`;
const RAW = `https://raw.githubusercontent.com/Suge8/firecode/main/`;
const README: Record<Lang, string> = { en: "README.md", zh: "README.zh-CN.md" };
const HEADS = {
	en: { review: "Reviewers", core: "Characters" },
	zh: { review: "审查者", core: "字符数" },
} satisfies Record<Lang, Record<string, string>>;

const readme = (lang: Lang) => readFileSync(join(root, README[lang]), "utf8");
const plain = (html: string) => html.replace(/<[^>]+>/g, "").trim();
const unbold = (cell: string) => cell.replace(/^\*\*(.*)\*\*$/, "$1");

function table(lang: Lang, head: string) {
	const lines = readme(lang).split("\n");
	const at = lines.findIndex((line) => line.startsWith("|") && cells(line).includes(head));
	if (at < 0) throw new Error(`${README[lang]}：找不到表头含「${head}」的表格`);
	const body = lines.slice(at + 2);
	const end = body.findIndex((line) => !line.startsWith("|"));
	return { head: cells(lines[at]), rows: body.slice(0, end < 0 ? undefined : end).map(cells) };
}

function cells(line: string) {
	return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

/** 标语与简介：README 里紧挨着的 <h3> 与 <p>，按句拆成行 */
export function tagline(lang: Lang) {
	const match = readme(lang).match(/<h3[^>]*>(.*?)<\/h3>\s*<p[^>]*>(.*?)<\/p>/s);
	if (!match) throw new Error(`${README[lang]}：找不到标语（<h3> 后紧跟简介 <p>）`);
	const headline = plain(match[1]);
	const lede = plain(match[2]);
	return {
		// 中文标题按逗号分行、去掉行尾标点；英文按句分行
		headline: lang === "zh" ? headline.split(/[，。]/).filter(Boolean) : headline.split(/(?<=\.)\s+/),
		lede,
		ledeLines: lede.split(lang === "zh" ? /(?<=。)/ : /(?<=\.)\s+/).filter(Boolean),
	};
}

/** 审查对比表：首行是 FireCode（README 里加粗）；名字后的 `命令` 与括号注释拆开 */
export function reviewTable(lang: Lang) {
	const { head, rows } = table(lang, HEADS[lang].review);
	return {
		cols: head.slice(1),
		rows: rows.map(([tool, reviewers, gets]) => {
			const name = unbold(tool);
			return {
				self: name !== tool,
				name: name.replace(/\s*(`[^`]+`|[(（][^)）]+[)）])/g, ""),
				cmd: name.match(/`([^`]+)`/)?.[1],
				note: name.match(/[(（]([^)）]+)[)）]/)?.[1],
				reviewers,
				gets: unbold(gets),
			};
		}),
	};
}

/** 核心极轻表：字符数可能是区间 a–b */
export function coreTable(lang: Lang) {
	const { head, rows } = table(lang, HEADS[lang].core);
	const number = (text: string) => Number(text.replaceAll(",", ""));
	return {
		headTools: head[1],
		headChars: head[2],
		rows: rows.map(([tool, tools, chars]) => {
			const name = unbold(tool);
			const [min, max = min] = unbold(chars).split("–").map(number);
			return { self: name !== tool, name, tools, min, max };
		}),
	};
}

/** 演示里的角色模型：取随包配置模板里调研员与工程师的模型原子 */
export function demoModels() {
	const config = parseJsonc(readFileSync(join(root, "config.example.jsonc"), "utf8")) as {
		master: { roles: Record<string, { model: string[] }> };
	};
	const { researcher, engineer } = config.master.roles;
	if (!researcher?.model[1] || !engineer?.model[0]) throw new Error("config.example.jsonc：演示需要 researcher 的模型链与 engineer");
	return { primary: researcher.model[0], fallback: researcher.model[1], engineer: engineer.model[0], engineerAtom: engineer.model[0] };
}

export function readmeMarkdown(lang: Lang) {
	const source = readme(lang);
	const body = source
		.slice(source.indexOf("\n## ") + 1)
		.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path: string) => `](${BLOB}${path})`)
		.replace(/<p align="center"><img alt="([^"]*)" src="([^"]+)"[^>]*><\/p>/g, "![$1]($2)");
	return `# FireCode\n\n> ${tagline(lang).lede}\n\n${body}`;
}

export function llmsTxt(site: URL) {
	return `# FireCode

> ${tagline("en").lede}

Install with \`${INSTALL}\`, then restart Pi.

## Docs

- [Guide](${new URL("index.md", site)}): what FireCode does, install and configuration
- [Guide (简体中文)](${new URL("zh/index.md", site)}): the same guide in Chinese
- [Default config](${RAW}config.example.jsonc): every option with comments
- [Changelog](${RAW}CHANGELOG.md)

## Optional

- [Source code](${REPO})
- [npm package](${NPM})
`;
}

export const markdown = (text: string) => new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
