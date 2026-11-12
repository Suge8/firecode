/**
 * 机器守的约定，随 `bun run typecheck` 跑（CI 同跑）；也可单独 `bun scripts/deps.ts [仓库根]`。前三条只管 master/：
 * 1. master/ 内无依赖环。
 * 2. 状态与调度文件不 import 界面文件：界面只在 index.ts 接线，运行时经 onChange 通知重绘。
 *    界面文件是下面列出的这几个；新文件默认按状态与调度算，新加界面文件要登记进 UI_FILES。
 * 3. 相对导入带 .js 扩展名（仓库约定，构建产物按它解析）。tsconfig 是 moduleResolution Bundler，tsc 接受无扩展名的
 *    相对导入，挡不住；所以由这里报错。前两条按解析后的文件判定，无扩展名、.ts 或绕道 ../master/ 的写法同样算边。
 * 4. master/ 读 review/ 只经 outcome.ts（接线处除外）：checkpoint 格式归 review 所有。
 * 5. 插件源码里的禁用写法（BANNED），修法写在各条报错里。
 * 6. 提示词不点配置模板里的角色名：角色名由每个用户的配置决定。
 *
 * 只有类型的导入也算依赖：它同样把状态层绑在界面的类型上，环也常靠 import type 闭合。Bun.Transpiler.scanImports
 * 会丢掉只有类型的导入，所以先去掉 import/export 语句里的 type 修饰再扫。不用 dependency-cruiser：只为这两条规则加依赖不值；
 * 宿主自带的 TypeScript 7 不提供稳定的 JS 解析接口。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJsonc } from "../jsonc.ts";

const UI_FILES = new Set(["activity-list.ts", "activity.ts", "list-view.ts", "worker-view.ts", "event-card.ts"]);
/** 接线处：挂界面、建运行时，两边都得认识。 */
const WIRING = "index.ts";

const transpiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: false });
const withoutTypeModifiers = (source: string) => source
	.replace(/^(\s*(?:import|export))\s+type\b(?=\s*(?:[{*]|[\w$]+\s+from\b))/gmu, "$1")
	.replace(/([{,]\s*)type\s+(?=[\w$]+\s*(?:[,}]|as\b))/gu, "$1");

type Import = { from: string; path: string; line: number };
type Edge = { from: string; to: string; line: number };

function masterImports(dir: string, files: ReadonlySet<string>): Import[] {
	return [...files].flatMap((from) => {
		const source = readFileSync(join(dir, from), "utf8");
		const lines = source.split("\n");
		return transpiler.scanImports(withoutTypeModifiers(source)).flatMap(({ path }) => path.startsWith(".")
			? [{ from, path, line: lines.findIndex((text) => text.includes(`"${path}"`) || text.includes(`'${path}'`)) + 1 }]
			: []);
	});
}

/** 相对导入解析到的 master/ 内文件（去掉 .js/.ts 或无扩展名都按同一个 .ts 算）；指向别处时 undefined。 */
function target(dir: string, files: ReadonlySet<string>, path: string): string | undefined {
	const resolved = resolve(dir, path);
	if (dirname(resolved) !== dir) return undefined;
	const name = `${basename(resolved).replace(/\.(?:js|ts)$/u, "")}.ts`;
	return files.has(name) ? name : undefined;
}

/** 每个强连通分量给一条具体的环路。 */
function cycles(edges: readonly Edge[]): string[][] {
	const next = new Map<string, string[]>();
	for (const { from, to } of edges) next.set(from, [...(next.get(from) ?? []), to]);
	const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], found: string[][] = [];
	const visit = (node: string) => {
		index.set(node, index.size); low.set(node, index.get(node)!); stack.push(node);
		for (const to of next.get(node) ?? []) {
			if (!index.has(to)) { visit(to); low.set(node, Math.min(low.get(node)!, low.get(to)!)); }
			else if (stack.includes(to)) low.set(node, Math.min(low.get(node)!, index.get(to)!));
		}
		if (low.get(node) !== index.get(node)) return;
		const members = new Set(stack.splice(stack.indexOf(node)));
		if (members.size > 1 || next.get(node)?.includes(node)) found.push(pathBack(node, members));
	};
	const pathBack = (start: string, members: Set<string>): string[] => {
		const prev = new Map<string, string>([[start, ""]]), queue = [start];
		for (const node of queue) for (const to of next.get(node) ?? []) {
			if (to === start) return [...trail(node, prev), start];
			if (members.has(to) && !prev.has(to)) { prev.set(to, node); queue.push(to); }
		}
		return [start];
	};
	const trail = (node: string, prev: Map<string, string>): string[] => (node ? [...trail(prev.get(node)!, prev), node] : []);
	for (const node of next.keys()) if (!index.has(node)) visit(node);
	return found;
}

/** 禁用写法：匹配到就报错，报错即修法。注释里提到这些名字不算（各条都匹配调用或导入的形状）。 */
const BANNED: readonly { pattern: RegExp; fix: string }[] = [
	{
		pattern: /^import[^;]*\b(?:truncateToWidth|TruncatedText)\b/mu,
		fix: "单行截断用 format.ts 的 clip：pi-tui 的省略号带 \\x1b[0m 全量重置，会在截断点掐断卡片背景色（earendil-works/pi#4894，上游拒修）",
	},
	{
		pattern: /\.sendUserMessage\(/u,
		fix: "发给模型的消息经 deliver.ts（自定义消息 + triggerTurn）：用户消息只表示人类输入，轮界、tail 与审查证据都按消息角色区分",
	},
];
const COMPACT_HOOK = /\.on\(\s*["']session_before_compact["']/gu;
const SOURCE_SKIP = /^(?:node_modules|dist|tests|evals|site|scripts|design|coverage)\/|\/node_modules\//u;

function conventionViolations(root: string): string[] {
	const sources = [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].filter((file) => !SOURCE_SKIP.test(file)).sort()
		.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
	const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
	const hooks = sources.flatMap(({ file, text }) => [...text.matchAll(COMPACT_HOOK)].map((match) => `${file}:${lineOf(text, match.index)}`));
	return [
		...sources.flatMap(({ file, text }) => BANNED.flatMap(({ pattern, fix }) => {
			const match = pattern.exec(text);
			return match ? [`禁用写法：${file}:${lineOf(text, match.index)}。${fix}`] : [];
		})),
		...(hooks.length > 1
			? [`session_before_compact 只能注册一个处理器（registerOpenAINative）：宿主让后返回的结果覆盖先返回的，分开注册时后台摘要会盖掉原生窗口。现有：${hooks.join("、")}`]
			: []),
	];
}

function promptViolations(root: string): string[] {
	const template = parseJsonc(readFileSync(join(root, "config.example.jsonc"), "utf8"));
	const master = isRecord(template) && isRecord(template.master) ? template.master : {};
	const roles = Object.keys(isRecord(master.roles) ? master.roles : {});
	return [...new Bun.Glob("*/prompts/*.md").scanSync({ cwd: root })].sort().flatMap((file) => {
		const lines = readFileSync(join(root, file), "utf8").split("\n");
		return roles.flatMap((role) => {
			const line = lines.findIndex((text) => new RegExp(`\\b${role}\\b`, "iu").test(text));
			return line < 0 ? [] : [`提示词点了角色名“${role}”：${file}:${line + 1}。角色名由用户配置决定，按角色表里的适用场景指代`];
		});
	});
}

export function dependencyViolations(root: string): string[] {
	const dir = resolve(root, "master");
	const files = new Set(readdirSync(dir).filter((name) => name.endsWith(".ts")));
	const imports = masterImports(dir, files);
	const edges = imports.flatMap(({ from, path, line }) => {
		const to = target(dir, files, path);
		return to ? [{ from, to, line }] : [];
	});
	return [
		...imports.filter(({ path }) => !path.endsWith(".js"))
			.map(({ from, path, line }) => `相对导入缺 .js 扩展名：master/${from}:${line} → "${path}"`),
		...cycles(edges).map((cycle) => `依赖环：${cycle.map((name) => `master/${name}`).join(" → ")}`),
		...edges.filter(({ from, to }) => from !== WIRING && !UI_FILES.has(from) && UI_FILES.has(to))
			.map(({ from, to, line }) => `状态与调度文件 import 界面文件：master/${from}:${line} → master/${to}`),
		...imports.filter(({ from, path }) => from !== WIRING && /\/review\//u.test(path) && !/\/review\/outcome(?:\.js|\.ts)?$/u.test(path))
			.map(({ from, path, line }) => `master/ 读 review/ 只经 outcome.ts：master/${from}:${line} → "${path}"`),
		...conventionViolations(root),
		...promptViolations(root),
	];
}

if (import.meta.main) {
	const violations = dependencyViolations(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
	for (const line of violations) console.error(line);
	process.exit(violations.length ? 1 : 0);
}
