/**
 * 会话 token / 成本统计：扫描 sessions 下的 jsonl，按模型汇总后用 Markdown 展示。
 * 源自 pi-token-stats (MIT, https://github.com/reaishijie/pi-token-stats)，已精简。
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";

import { msg } from "./messages.js";
import { registerQuota } from "./quota.js";

const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 每次读入的字节数：会话文件可达数百 MB 且含超长行，整文件读成字符串会超过 Node 的字符串上限并占满内存。 */
const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;
/** 只有带 usage 的行才可能被计入，其余（工具输出等大行）不必解码解析。 */
const USAGE_MARK = Buffer.from('"usage"');

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
};

type SessionLine = {
	type?: string;
	timestamp?: string;
	usage?: Usage;
	message?: { role?: string; provider?: string; model?: string; usage?: Usage; timestamp?: number };
};

type UsageAttribution = {
	provider: string;
	model: string;
	usage: Usage;
	timestamp?: number;
	countRequest: boolean;
};

/** 与 pi 的 usage-totals 对齐：assistant 归模型，工具与压缩归 tools/summaries。 */
function usageAttribution(entry: SessionLine): UsageAttribution | undefined {
	const at = (fallback?: number) => fallback ?? (entry.timestamp ? Date.parse(entry.timestamp) : undefined);

	if (entry.type === "message" && entry.message?.usage) {
		const { role, provider, model, usage, timestamp } = entry.message;
		if (role === "assistant") {
			return {
				provider: provider ?? "unknown",
				model: model ?? "unknown",
				usage,
				timestamp: at(timestamp),
				countRequest: true,
			};
		}
		if (role === "toolResult") {
			return { provider: "tools", model: "summaries", usage, timestamp: at(timestamp), countRequest: false };
		}
		return undefined;
	}

	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
		return { provider: "tools", model: "summaries", usage: entry.usage, timestamp: at(), countRequest: false };
	}
	return undefined;
}

type Totals = {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
};

const emptyTotals = (): Totals => ({
	requests: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	tokens: 0,
	cost: 0,
});

function add(target: Totals, usage: Usage, countRequest: boolean): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;

	if (countRequest) target.requests += 1;
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.tokens += usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	target.cost += usage.cost?.total ?? 0;
}

/** 目录读不了的计入 unreadable（根目录不存在不算：没有会话就是没有用量）。 */
async function sessionFiles(dir: string): Promise<{ files: string[]; unreadable: number }> {
	const found: string[] = [];
	let unreadable = 0;
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable += 1;
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			// 软链接按目标判断（指向目录的要继续遍历）；断链忽略。
			const target = entry.isSymbolicLink() ? await stat(path).catch(() => undefined) : entry;
			if (target?.isDirectory()) pending.push(path);
			else if (target && entry.name.endsWith(".jsonl")) found.push(path);
		}
	}
	return { files: found, unreadable };
}

/** 逐块读文件、按字节切行：峰值内存是一块加当前这一行，每块读完都让出事件循环。 */
async function forEachLine(path: string, onLine: (line: Buffer) => void): Promise<void> {
	const handle = await open(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		/** 上一块末尾还没结束的行；块缓冲会被复用，所以存副本。 */
		let tail: Buffer[] = [];
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			const data = chunk.subarray(0, bytesRead);
			let start = 0;
			for (let end = data.indexOf(NEWLINE); end >= 0; end = data.indexOf(NEWLINE, start)) {
				tail.push(data.subarray(start, end));
				onLine(tail.length === 1 ? tail[0] : Buffer.concat(tail));
				tail = [];
				start = end + 1;
			}
			if (start < bytesRead) tail.push(Buffer.from(data.subarray(start)));
		}
		if (tail.length) onLine(Buffer.concat(tail));
	} finally {
		await handle.close();
	}
}

type Report = {
	days: number;
	from?: number;
	to: number;
	dir: string;
	scanned: number;
	/** 没读成的文件与目录数；这些文件里的用量没有计入。 */
	unreadable: number;
	matched: number;
	overall: Totals;
	byModel: Map<string, Totals>;
};

async function collect(days: number): Promise<Report> {
	const to = Date.now();
	const from = days === 0 ? undefined : to - days * DAY_MS;
	const dir = join(getAgentDir(), "sessions");
	const { files, unreadable } = await sessionFiles(dir);
	const report: Report = {
		days,
		from,
		to,
		dir,
		scanned: files.length,
		unreadable,
		matched: 0,
		overall: emptyTotals(),
		byModel: new Map(),
	};

	for (const file of files) {
		// 先收进本文件的列表，读完才并入报告：读到一半失败的文件不留半截数字。
		const found: UsageAttribution[] = [];
		try {
			await forEachLine(file, (line) => {
				if (!line.includes(USAGE_MARK)) return;
				try {
					const attributed = usageAttribution(JSON.parse(line.toString("utf8")) as SessionLine);
					if (!attributed) return;
					if (from !== undefined && attributed.timestamp !== undefined && attributed.timestamp < from) return;
					found.push(attributed);
				} catch {
					// 写到一半的坏行忽略。
				}
			});
		} catch {
			report.unreadable += 1;
			continue;
		}

		for (const attributed of found) {
			const key = `${attributed.provider}/${attributed.model}`;
			let model = report.byModel.get(key);
			if (!model) {
				model = emptyTotals();
				report.byModel.set(key, model);
			}
			add(report.overall, attributed.usage, attributed.countRequest);
			add(model, attributed.usage, attributed.countRequest);
		}
		if (found.length) report.matched += 1;
	}

	return report;
}

const number = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));

const compactTokens = (value: number): string => msg.stats.compact(Math.round(value), number(value));

const cost = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const dateTime = (value: number): string => {
	const date = new Date(value);
	const pad = (part: number) => part.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const row = (cells: Array<string | number>): string => `| ${cells.join(" | ")} |`;

const totalsCells = (totals: Totals): string[] => [
	number(totals.input),
	number(totals.output),
	number(totals.cacheRead),
	number(totals.cacheWrite),
	compactTokens(totals.tokens),
	cost(totals.cost),
];

function buildMarkdown(report: Report): string {
	const { column } = msg.stats;
	const range = report.days === 0 ? msg.stats.range(0, "", "") : msg.stats.range(report.days, dateTime(report.from as number), dateTime(report.to));
	const headers = [column.input, column.output, column.cacheRead, column.cacheWrite, column.tokens, column.cost];
	const aligns = headers.map(() => "---:");
	const lines = [
		msg.stats.title,
		"",
		msg.stats.rangeLine(range),
		msg.stats.sessionsLine(number(report.matched), number(report.scanned)),
		msg.stats.requestsLine(number(report.overall.requests), cost(report.overall.cost)),
		...(report.unreadable ? [msg.stats.unreadableLine(number(report.unreadable))] : []),
		"",
		row(headers),
		row(aligns),
		row(totalsCells(report.overall)),
		"",
		msg.stats.byModel,
		"",
	];

	const models = [...report.byModel.entries()].sort((left, right) => right[1].tokens - left[1].tokens);
	if (models.length === 0) {
		lines.push(msg.stats.empty);
		return lines.join("\n");
	}

	lines.push(row([column.model, column.requests, ...headers]));
	lines.push(row(["---", "---:", ...aligns]));
	for (const [key, totals] of models) {
		lines.push(row([`\`${key}\``, number(totals.requests), ...totalsCells(totals)]));
	}
	return lines.join("\n");
}

async function show(markdown: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(markdown);
		return;
	}

	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const border = new DynamicBorder((text: string) => theme.fg("accent", text));
		container.addChild(border);
		container.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
		container.addChild(new Text(theme.fg("dim", msg.stats.close), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

/** 参数只认纯数字天数；省略即默认天数，无法解析返回 undefined。 */
function parseDays(args: string): number | undefined {
	const text = args.trim();
	if (!text) return DEFAULT_DAYS;
	return /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

const dayCompletions: AutocompleteItem[] = [
	{ value: "7", label: "7", description: msg.stats.completion.week },
	{ value: "30", label: "30", description: msg.stats.completion.month },
	{ value: "0", label: "0", description: msg.stats.completion.all },
];

export function registerStats(pi: ExtensionAPI): void {
	registerQuota(pi);
	pi.registerCommand("tokens", {
		description: msg.stats.commandDescription,
		getArgumentCompletions: (prefix: string) => {
			const matches = dayCompletions.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const days = parseDays(args);
			if (days === undefined) {
				ctx.ui.notify(msg.stats.usage, "warning");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(msg.stats.counting(days), "info");
			}
			await show(buildMarkdown(await collect(days)), ctx);
		},
	});
}
