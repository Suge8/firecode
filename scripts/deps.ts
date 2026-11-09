/**
 * master/ 的依赖规则，随 `bun run typecheck` 跑（CI 同跑）；也可单独 `bun scripts/deps.ts [仓库根]`。
 * 1. master/ 内无依赖环。
 * 2. 状态与调度文件不 import 界面文件：界面只在 index.ts 接线，运行时经 onChange 通知重绘（master/AGENTS.md）。
 *    界面文件是下面列出的这几个；新文件默认按状态与调度算，新加界面文件要登记进 UI_FILES。
 *
 * 只有类型的导入也算依赖：它同样把状态层绑在界面的类型上，环也常靠 import type 闭合。Bun.Transpiler.scanImports
 * 会丢掉只有类型的导入，所以先去掉 import/export 语句里的 type 修饰再扫。不用 dependency-cruiser：只为这两条规则加依赖不值；
 * 宿主自带的 TypeScript 7 不提供稳定的 JS 解析接口。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_FILES = new Set(["activity-list.ts", "activity.ts", "list-view.ts", "worker-view.ts", "event-card.ts"]);
/** 接线处：挂界面、建运行时，两边都得认识。 */
const WIRING = "index.ts";

const transpiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: false });
const withoutTypeModifiers = (source: string) => source
	.replace(/^(\s*(?:import|export))\s+type\b(?=\s*(?:[{*]|[\w$]+\s+from\b))/gmu, "$1")
	.replace(/([{,]\s*)type\s+(?=[\w$]+\s*(?:[,}]|as\b))/gu, "$1");

type Edge = { from: string; to: string; line: number };

function masterEdges(root: string): Edge[] {
	const dir = join(root, "master");
	const files = new Set(readdirSync(dir).filter((name) => name.endsWith(".ts")));
	return [...files].flatMap((from) => {
		const source = readFileSync(join(dir, from), "utf8");
		const lines = source.split("\n");
		return transpiler.scanImports(withoutTypeModifiers(source)).flatMap(({ path }) => {
			const to = /^\.\/([^/]+)\.js$/u.exec(path)?.[1];
			if (!to || !files.has(`${to}.ts`)) return [];
			return [{ from, to: `${to}.ts`, line: lines.findIndex((text) => text.includes(`"${path}"`)) + 1 }];
		});
	});
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

export function dependencyViolations(root: string): string[] {
	const edges = masterEdges(root);
	return [
		...cycles(edges).map((cycle) => `依赖环：${cycle.map((name) => `master/${name}`).join(" → ")}`),
		...edges.filter(({ from, to }) => from !== WIRING && !UI_FILES.has(from) && UI_FILES.has(to))
			.map(({ from, to, line }) => `状态与调度文件 import 界面文件：master/${from}:${line} → master/${to}`),
	];
}

if (import.meta.main) {
	const violations = dependencyViolations(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
	for (const line of violations) console.error(line);
	process.exit(violations.length ? 1 : 0);
}
