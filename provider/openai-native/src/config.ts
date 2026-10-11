import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isRecord, parseJsonc } from "../../../jsonc.js";

const TEXT_VERBOSITIES = ["low", "medium", "high"] as const;

export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];

type OpenAIProviderSettings = {
	textVerbosity?: TextVerbosity;
	priority?: true;
};

export type OpenAINativeSettings = {
	nativeCompaction: boolean;
	providers: Record<string, OpenAIProviderSettings>;
};

type LoadedOpenAINativeSettings = {
	settings: OpenAINativeSettings;
	warnings: string[];
};

export function isTextVerbosity(value: unknown): value is TextVerbosity {
	return typeof value === "string" && TEXT_VERBOSITIES.includes(value as TextVerbosity);
}

function createDefaultSettings(): OpenAINativeSettings {
	return {
		nativeCompaction: false,
		providers: {},
	};
}

function readConfig(configPath: string): Record<string, unknown> {
	const parsed = parseJsonc(readFileSync(configPath, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error("expected a JSON object");
	}
	return parsed;
}

/** 配置文件里只有 `openai` 节归本模块；缺省按全默认。 */
function openaiSection(root: Record<string, unknown>): Record<string, unknown> {
	return isRecord(root.openai) ? root.openai : {};
}

function parseProviderSettings(
	provider: string,
	value: unknown,
	warnings: string[],
): OpenAIProviderSettings | undefined {
	if (!isRecord(value)) {
		warnings.push(`providers.${provider}: expected an object.`);
		return undefined;
	}

	const settings: OpenAIProviderSettings = {};
	if (value.textVerbosity !== undefined) {
		if (isTextVerbosity(value.textVerbosity)) {
			settings.textVerbosity = value.textVerbosity;
		} else {
			warnings.push(`providers.${provider}.textVerbosity: expected low, medium, or high.`);
		}
	}
	if (value.priority !== undefined) {
		if (typeof value.priority === "boolean") {
			if (value.priority) {
				settings.priority = true;
			}
		} else {
			warnings.push(`providers.${provider}.priority: expected a boolean.`);
		}
	}

	return Object.keys(settings).length > 0 ? settings : undefined;
}

function parseSettings(root: Record<string, unknown>): LoadedOpenAINativeSettings {
	const warnings: string[] = [];
	const settings = createDefaultSettings();
	if (root.nativeCompaction !== undefined) {
		if (typeof root.nativeCompaction === "boolean") {
			settings.nativeCompaction = root.nativeCompaction;
		} else {
			warnings.push("nativeCompaction: expected a boolean.");
		}
	}
	if (root.providers === undefined) {
		return { settings, warnings };
	}
	if (!isRecord(root.providers)) {
		warnings.push("providers: expected an object.");
		return { settings, warnings };
	}

	for (const [provider, value] of Object.entries(root.providers)) {
		if (!provider.trim()) {
			warnings.push("providers: provider name cannot be empty.");
			continue;
		}
		const providerSettings = parseProviderSettings(provider, value, warnings);
		if (providerSettings) {
			settings.providers[provider] = providerSettings;
		}
	}

	return { settings, warnings };
}

export function loadOpenAINativeSettings(configPath: string): LoadedOpenAINativeSettings {
	try {
		return parseSettings(openaiSection(readConfig(configPath)));
	} catch (error) {
		return {
			settings: createDefaultSettings(),
			warnings: [`config.jsonc: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

type Member = { key: string; start: number; end: number };

/** 跳过空白与注释，返回下一个有效字符的位置。 */
function skipTrivia(text: string, from: number): number {
	let index = from;
	for (;;) {
		if (/\s/.test(text[index] ?? "")) index += 1;
		else if (text.startsWith("//", index)) index = text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index);
		else if (text.startsWith("/*", index)) index = text.indexOf("*/", index) + 2;
		else return index;
	}
}

function stringEnd(text: string, from: number): number {
	let index = from + 1;
	while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
	return index + 1;
}

function valueEnd(text: string, from: number): number {
	if (text[from] === '"') return stringEnd(text, from);
	if (text[from] !== "{" && text[from] !== "[") {
		let index = from;
		while (index < text.length && !/[\s,}\]/]/.test(text[index])) index += 1;
		return index;
	}
	let depth = 0;
	let index = from;
	for (;;) {
		index = skipTrivia(text, index);
		const char = text[index];
		if (char === '"') index = stringEnd(text, index);
		else {
			if (char === "{" || char === "[") depth += 1;
			else if (char === "}" || char === "]") depth -= 1;
			index += 1;
			if (depth === 0) return index;
		}
	}
}

/** 顶层对象的成员位置，只认词法上真实的键：注释和字符串里的 "openai": { 不算。 */
function topLevelMembers(text: string): { members: Member[]; afterLast: number } {
	let index = skipTrivia(text, 0) + 1;
	const members: Member[] = [];
	let afterLast = index;
	for (;;) {
		index = skipTrivia(text, index);
		if (text[index] === "}") return { members, afterLast };
		if (text[index] === ",") {
			index += 1;
			continue;
		}
		const keyEnd = stringEnd(text, index);
		const key = JSON.parse(text.slice(index, keyEnd)) as string;
		const start = skipTrivia(text, skipTrivia(text, keyEnd) + 1);
		index = valueEnd(text, start);
		members.push({ key, start, end: index });
		afterLast = index;
	}
}

/** 只改 openai 节（没有就追加到顶层末尾），文件其余部分含注释原样保留。 */
function replaceOpenAISection(text: string, section: Record<string, unknown>): string {
	const pretty = JSON.stringify(section, null, "\t").replaceAll("\n", "\n\t");
	const { members, afterLast } = topLevelMembers(text);
	const existing = members.findLast((member) => member.key === "openai");
	if (existing) return text.slice(0, existing.start) + pretty + text.slice(existing.end);
	const separator = members.length > 0 ? "," : "";
	return `${text.slice(0, afterLast)}${separator}\n\t"openai": ${pretty}${members.length > 0 ? "" : "\n"}${text.slice(afterLast)}`;
}

/**
 * 翻转某供应商的 priority 并写回配置。读-改-写之间不加锁：两个 Pi 进程同一瞬间切换才会丢一次更新，
 * 不值得为此维护锁文件（崩溃后的陈旧锁会让切换永久报错）。
 */
export function togglePriority(
	provider: string,
	configPath: string,
): { enabled: boolean; loaded: LoadedOpenAINativeSettings } {
	if (!provider.trim()) {
		throw new Error("provider name cannot be empty");
	}
	const text = readFileSync(configPath, "utf8");
	const section = openaiSection(readConfig(configPath));
	const providers = isRecord(section.providers) ? section.providers : {};
	const current = isRecord(providers[provider]) ? providers[provider] : {};
	const enabled = current.priority !== true;
	const next = { ...section, providers: { ...providers, [provider]: { ...current, priority: enabled } } };

	const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, replaceOpenAISection(text, next), { encoding: "utf8", mode: statSync(configPath).mode & 0o777 });
		renameSync(temporaryPath, configPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return { enabled, loaded: parseSettings(next) };
}
