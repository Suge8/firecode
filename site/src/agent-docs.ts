import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INSTALL, NPM, REPO, site, type Lang } from "./i18n";

// 给 Agent 读的 Markdown 只从仓库 README 派生，不另写一份产品说明
const BLOB = `${REPO}/blob/main/`;
const README: Record<Lang, string> = { en: "README.md", zh: "README.zh-CN.md" };

// Astro 构建时的工作目录是 site/，README 在上一级
export async function readmeMarkdown(lang: Lang) {
	const source = await readFile(join(process.cwd(), "..", README[lang]), "utf8");
	const body = source
		.slice(source.indexOf("\n## ") + 1)
		.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path: string) => `](${BLOB}${path})`)
		.replace(/<p align="center"><img alt="([^"]*)" src="([^"]+)"[^>]*><\/p>/g, "![$1]($2)");
	return `# FireCode\n\n> ${site[lang].description}\n\n\`\`\`bash\n${INSTALL}\n\`\`\`\n\n${body}`;
}

export function llmsTxt() {
	return `# FireCode

> ${site.en.description}

Install with \`${INSTALL}\`, then restart Pi. The full guide is the README below.

## Docs

- [README](${BLOB}README.md): what FireCode does, install and configuration
- [README (简体中文)](${BLOB}README.zh-CN.md): the same guide in Chinese
- [Default config](${BLOB}config.example.jsonc): every option with comments
- [Changelog](${BLOB}CHANGELOG.md)

## Optional

- [Source code](${REPO})
- [npm package](${NPM})
`;
}

export const markdown = (text: string) => new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
