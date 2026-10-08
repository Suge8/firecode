import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isRecord, parseJsonc } from "../../../jsonc.js";

const TEXT_VERBOSITIES = ["low", "medium", "high"] as const;

export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];

export type OpenAIProviderSettings = {
	textVerbosity?: TextVerbosity;
	priority?: true;
};

export type OpenAINativeSettings = {
	nativeCompaction: boolean;
	providers: Record<string, OpenAIProviderSettings>;
};

export type LoadedOpenAINativeSettings = {
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

/** 只替换名为 key 的对象，文件其余部分（含注释）原样保留。 */
function replaceKeyedObject(text: string, key: string, value: unknown): string | undefined {
	const marker = new RegExp(`"${key}"\\s*:\\s*\\{`);
	const match = marker.exec(text);
	if (!match) return undefined;
	const brace = text.indexOf("{", match.index + match[0].length - 1);
	if (brace < 0) return undefined;

	let depth = 0;
	let inString = false;
	let escape = false;
	for (let index = brace; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escape) escape = false;
			else if (char === "\\") escape = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth !== 0) continue;
			const lineStart = text.lastIndexOf("\n", match.index) + 1;
			const indent = text.slice(lineStart, match.index);
			const pretty = JSON.stringify(value, null, "\t")
				.split("\n")
				.map((line, lineIndex) => (lineIndex === 0 ? line : indent + line))
				.join("\n");
			return text.slice(0, brace) + pretty + text.slice(index + 1);
		}
	}
	return undefined;
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

function serializeSettings(settings: OpenAINativeSettings): Record<string, unknown> {
	const providers: Record<string, OpenAIProviderSettings> = {};
	for (const [provider, providerSettings] of Object.entries(settings.providers)) {
		providers[provider] = {
			...(providerSettings.textVerbosity ? { textVerbosity: providerSettings.textVerbosity } : {}),
			...(providerSettings.priority ? { priority: true } : {}),
		};
	}

	return {
		nativeCompaction: settings.nativeCompaction,
		providers,
	};
}

function isProcessRunning(processId: number): boolean {
	if (!Number.isSafeInteger(processId) || processId <= 0) {
		return false;
	}

	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function acquireConfigLock(lockPath: string): number {
	try {
		return openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}

	const processId = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
	if (!Number.isSafeInteger(processId) || isProcessRunning(processId)) {
		throw new Error("config is being updated by another Pi process");
	}

	rmSync(lockPath, { force: true });
	return openSync(lockPath, "wx", 0o600);
}

function writeConfig(configPath: string, settings: OpenAINativeSettings, root: Record<string, unknown>): void {
	const serialized = serializeSettings(settings);
	const text = replaceKeyedObject(readFileSync(configPath, "utf8"), "openai", serialized)
		?? `${JSON.stringify({ ...root, openai: serialized }, null, "\t")}\n`;
	const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, text, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, configPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function withConfigLock<T>(configPath: string, action: () => T): T {
	const lockPath = `${configPath}.lock`;
	const lockDescriptor = acquireConfigLock(lockPath);
	writeFileSync(lockDescriptor, `${process.pid}\n`, "utf8");
	try {
		return action();
	} finally {
		closeSync(lockDescriptor);
		rmSync(lockPath, { force: true });
	}
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

export function togglePriority(
	provider: string,
	configPath: string,
): { enabled: boolean; loaded: LoadedOpenAINativeSettings } {
	if (!provider.trim()) {
		throw new Error("provider name cannot be empty");
	}

	return withConfigLock(configPath, () => {
		const root = readConfig(configPath);
		const loaded = parseSettings(openaiSection(root));
		const providerSettings = loaded.settings.providers[provider] ?? {};
		const enabled = providerSettings.priority !== true;
		const providers = {
			...loaded.settings.providers,
			[provider]: {
				...providerSettings,
				...(enabled ? { priority: true as const } : {}),
			},
		};

		if (!enabled) {
			delete providers[provider].priority;
			if (Object.keys(providers[provider]).length === 0) {
				delete providers[provider];
			}
		}

		const settings: OpenAINativeSettings = {
			nativeCompaction: loaded.settings.nativeCompaction,
			providers,
		};
		writeConfig(configPath, settings, root);
		return {
			enabled,
			loaded: { settings, warnings: loaded.warnings },
		};
	});
}

