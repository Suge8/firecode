/** FireCode 配置：只读 Pi Agent 目录下的 `extensions/firecode/config.jsonc`。 */
import { type ConfigFile, readConfigFile } from "./config-file.js";
import { parseLanguage } from "./i18n.js";
import { msg } from "./messages.js";

export type ThinkingLevelValue =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/**
 * 模型原子：配置里一律写作 "provider/model/thinking"，解析后拆成运行时模型 id 与思考档。
 * 全仓库指定模型与思考档的唯一形状。
 */
export interface ModelAtom {
	model: string;
	thinking: ThinkingLevelValue;
}

export interface Preset {
	model?: ModelAtom;
	tools?: string[];
	instructions?: string;
	/** 一键切换，如 alt+1；不填则无快捷键 */
	key?: string;
}

/** /fire-review 配置：审查者 / 顾问模型 + 循环限制。见 config.jsonc 的 review 节注释。 */
export interface ReviewConfig {
	advisor: ModelAtom;
	reviewers: ModelAtom[];
	/** 审查轮数硬上限。 */
	maxRounds: number;
	/** 连续几轮失败触发顾问仲裁。 */
	advisorAfterFailures: number;
	/** 单个审查者 / 顾问会话超时（分钟）。 */
	timeoutMinutes: number;
	/** 审查者只读工具白名单。 */
	tools: string[];
}

export interface MasterRole extends ModelAtom {
	role: string;
	use: string;
	fallback: ModelAtom[];
}

export interface MasterConfig {
	roles: MasterRole[];
	workerExcludeExtensions: string[];
	autoActivate: boolean;
}

/** 观察员喂给观察会话的增量粒度：minimal 省略 reasoning 与 diff 正文。 */
export type WatcherContext = "minimal" | "full";

/** Watcher 观察员配置：模型原子必须显式配置，绝不回退默认模型。 */
export interface WatcherConfig extends ModelAtom {
	enabled: boolean;
	context: WatcherContext;
}


export const FEATURES = [
	"header",
	"statusbar",
	"tools",
	"presets",
	"stats",
	"claudeSub",
	"openaiNative",
	"review",
	"master",
	"watcher",
] as const;

export type Feature = (typeof FEATURES)[number];

/** 顶层只认这些节；openai 节由 provider/openai-native 自己解析。 */
const SECTIONS = ["language", "features", "keys", "openai", "presets", "review", "master", "watcher"];

/**
 * 扩展注册的快捷键与宿主任一键位撞键，宿主都会在启动时报冲突；默认键须避开宿主全部默认键位
 * （tests/config-seam.test.ts 守这条）。ctrl+shift+s：宿主默认键位里没有，s 取 speed；单个 ctrl+字母已被宿主占满。
 */
export const DEFAULT_KEYS = {
	fast: "ctrl+shift+s",
} as const;

export type FireCodeKeys = {
	fast: string;
};

export interface FireCodeConfig {
	features: Partial<Record<Feature, boolean>>;
	keys: FireCodeKeys;
	presets: Record<string, Preset>;
	review: ReviewConfig;
	master: MasterConfig;
	watcher: WatcherConfig;
}

/** 一节能否启动的唯一判定：要么交出可用配置，要么给出拒绝启动的原因。 */
export type Section<T> = { config: T } | { error: string };

export type LoadedConfig = {
	config: FireCodeConfig;
	/** 需要在 session_start 全局警告的问题；关闭的功能那一节的问题不在其中。 */
	problems: string[];
	review: Section<ReviewConfig>;
	master: Section<MasterConfig>;
	watcher: Section<WatcherConfig>;
	/** features 整节类型错误：已安全回退成全关，但那是配置坏而非用户关闭。 */
	featuresBroken: boolean;
};

function readFile({ raw, fault }: ConfigFile, problems: string[]): Record<string, unknown> {
	if (!fault) return raw;
	switch (fault.kind) {
		case "missing":
			problems.push(msg.config.missing);
			return { features: Object.fromEntries(FEATURES.map((feature) => [feature, false])) };
		case "notObject":
			problems.push(msg.config.notObject);
			return {};
		case "parse":
			// 统一前缀：文件级故障必须能被调用方识别并阻断功能，
			// 不能因为消息文本不带节名就被当成无关问题过滤掉。
			problems.push(msg.config.parseFailed(fault.message));
			return {};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** 嵌套对象也做键白名单：拼写错误必须报出来，不能静默回退默认值。 */
function rejectUnknownKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	field: string,
	problems: string[],
) {
	for (const key of Object.keys(record))
		if (!allowed.includes(key)) problems.push(msg.config.unknownField(`${field}.${key}`));
}

function booleanValue(value: unknown, field: string, fallback: boolean, problems: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	problems.push(msg.config.mustBeBoolean(field));
	return fallback;
}

function stringValue(value: unknown, field: string, problems: string[]): string | undefined {
	if (typeof value === "string" && value) return value;
	problems.push(msg.config.mustBeString(field));
	return undefined;
}

function stringArray(value: unknown, field: string, problems: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
		problems.push(msg.config.mustBeStringArray(field));
		return [];
	}
	return [...new Set(value)];
}

function checkFeatures(features: Record<string, unknown>, problems: string[]): void {
	for (const [key, value] of Object.entries(features)) {
		if (!FEATURES.includes(key as Feature)) {
			problems.push(msg.config.unknownFeature(key, FEATURES.join(" / ")));
			continue;
		}
		// 开关只能是布尔：写成字符串 "false" 时因为 `!== false` 仍会启用，
		// 而启用 review 意味着真实的模型调用，不能静默放行。
		if (typeof value !== "boolean")
			problems.push(msg.config.mustBeBoolean(`features.${key}`));
	}
}

function checkKeys(keys: FireCodeKeys, presets: Record<string, Preset>, problems: string[]): void {
	const owners = new Map<string, string>([[keys.fast, "keys.fast"]]);
	for (const [name, preset] of Object.entries(presets)) {
		if (!preset?.key) continue;
		const owner = owners.get(preset.key);
		if (owner) problems.push(msg.config.keyConflict(preset.key, owner, name));
		else owners.set(preset.key, msg.config.presetOwner(name));
	}
}

let cached: LoadedConfig | undefined;

export function loadConfig(): LoadedConfig {
	if (cached) return cached;

	// 文件级与开关级问题阻断所有付费功能：开关写成字符串 "false" 时 `!== false` 仍会启用。
	const blocking: string[] = [];
	const raw = readFile(readConfigFile(), blocking);
	// features 省略表示沿用默认全开；只要显式写了，就必须是对象。
	// 非对象不能回退成 {}，因为 {} 在入口语义里正是「全部启用」。
	const featuresBroken = raw.features !== undefined && !isPlainObject(raw.features);
	if (featuresBroken) blocking.push(msg.config.featuresNotObject);
	const features: Partial<Record<Feature, boolean>> = featuresBroken
		? Object.fromEntries(FEATURES.map((feature) => [feature, false]))
		: asRecord(raw.features);
	checkFeatures(features, blocking);

	const problems = [...blocking];
	for (const key of Object.keys(raw)) if (!SECTIONS.includes(key)) problems.push(msg.config.unknownSection(key));
	const rawKeys = asRecord(raw.keys);
	rejectUnknownKeys(rawKeys, Object.keys(DEFAULT_KEYS), "keys", problems);
	const presets = parsePresets(raw.presets, problems);
	const keys: FireCodeKeys = {
		fast: typeof rawKeys.fast === "string" ? rawKeys.fast : DEFAULT_KEYS.fast,
	};
	checkKeys(keys, presets, problems);
	if (raw.language !== undefined && !parseLanguage(raw.language)) problems.push(msg.config.language);

	// review / master / watcher 有问题时对应功能拒绝启动：静默补齐会拿用户没选的模型真实发起调用。
	// 节内问题只在功能开启时进全局警告。
	const section = <T>(
		name: "review" | "master" | "watcher",
		refused: (reasons: string[]) => string,
		parse: (record: Record<string, unknown>, problems: string[]) => T,
		incomplete: (config: T) => string | undefined,
	): { config: T; verdict: Section<T> } => {
		const own: string[] = [];
		if (raw[name] !== undefined && !isPlainObject(raw[name])) own.push(msg.config.mustBeObject(name));
		const config = parse(asRecord(raw[name]), own);
		if (features[name] !== false) problems.push(...own);
		const reasons = [...blocking, ...own];
		const missing = reasons.length ? undefined : incomplete(config);
		if (missing) reasons.push(missing);
		return { config, verdict: reasons.length ? { error: refused(reasons) } : { config } };
	};
	const review = section("review", msg.config.refusedReview, parseReviewConfig, (config) =>
		config.advisor.model && config.reviewers.length ? undefined : msg.config.reviewIncomplete);
	const master = section("master", msg.config.refusedMaster, parseMasterConfig, (config) =>
		config.roles.length ? undefined : msg.config.masterIncomplete);
	const watcher = section("watcher", msg.config.refusedWatcher, parseWatcherConfig, () => undefined);

	cached = {
		config: { features, keys, presets, review: review.config, master: master.config, watcher: watcher.config },
		problems,
		review: review.verdict,
		master: master.verdict,
		watcher: watcher.verdict,
		featuresBroken,
	};
	return cached;
}

// ---- 模型原子 ----

const THINKING_LEVELS = new Set<ThinkingLevelValue>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const FALLBACK_THINKING: ThinkingLevelValue = "medium";

/**
 * 解析 "provider/model/thinking"：按最后一个斜杠切出思考档，前半必须仍是 provider/model。
 * 任何位置的模型配置都走这里，解析失败只记录问题并留空模型，让上层拒绝启动。
 * 每个字段只报一条问题，且必带目标形状——两段式旧写法会同时踩中两项校验，逐项报错说不出该改成什么。
 * 旧的分字段与两段式写法一律拒绝、不做兼容：兼容层会把三种写法固化成三套事实源。
 */
export function parseModelAtom(value: unknown, field: string, problems: string[]): ModelAtom {
	const shape = msg.config.modelAtomShape(field);
	if (typeof value !== "string" || !value) {
		problems.push(shape);
		return { model: "", thinking: FALLBACK_THINKING };
	}
	const slash = value.lastIndexOf("/");
	const model = slash > 0 ? value.slice(0, slash) : "";
	const thinking = slash > 0 ? value.slice(slash + 1) : value;
	const providerSlash = model.indexOf("/");
	const valid = THINKING_LEVELS.has(thinking as ThinkingLevelValue);
	const faults: string[] = [];
	if (providerSlash <= 0 || providerSlash === model.length - 1)
		faults.push(msg.config.modelSegment(model || value));
	if (!valid) faults.push(msg.config.thinkingLevel(thinking));
	if (faults.length) problems.push(msg.config.modelAtomFaults(shape, faults));
	return { model, thinking: valid ? (thinking as ThinkingLevelValue) : FALLBACK_THINKING };
}

// ---- presets 节 ----

const PRESET_KEYS = ["model", "tools", "instructions", "key"] as const;

function parsePresets(value: unknown, problems: string[]): Record<string, Preset> {
	if (value === undefined) return {};
	if (!isPlainObject(value)) {
		problems.push(msg.config.mustBeObject("presets"));
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).map(([name, raw]) => [name, parsePreset(raw, `presets.${name}`, problems)]),
	);
}

/** preset 只在写了 model 时切模型；其余字段与模型原子互不依赖。 */
function parsePreset(value: unknown, field: string, problems: string[]): Preset {
	if (!isPlainObject(value)) {
		problems.push(msg.config.mustBeObject(field));
		return {};
	}
	rejectUnknownKeys(value, PRESET_KEYS, field, problems);
	return {
		...(value.model === undefined
			? {}
			: { model: parseModelAtom(value.model, `${field}.model`, problems) }),
		...(value.tools === undefined ? {} : { tools: stringArray(value.tools, `${field}.tools`, problems) }),
		...(value.instructions === undefined
			? {}
			: { instructions: stringValue(value.instructions, `${field}.instructions`, problems) }),
		...(value.key === undefined ? {} : { key: stringValue(value.key, `${field}.key`, problems) }),
	};
}

// ---- review 节 ----

const REVIEW_KEYS = new Set([
	"advisor",
	"reviewers",
	"maxRounds",
	"advisorAfterFailures",
	"timeoutMinutes",
	"tools",
]);
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** 导出供测试：严格拒绝未知字段（含嵌套），类型错误一律记录而非静默回退。 */
export function parseReviewConfig(raw: Record<string, unknown>, problems: string[]): ReviewConfig {
	for (const key of Object.keys(raw)) {
		if (REVIEW_KEYS.has(key)) continue;
		problems.push(key === "background" ? msg.config.reviewBackground : msg.config.unknownField(`review.${key}`));
	}
	// advisor 与 reviewers 缺失由模型原子解析自己报形状，不再叠一条泛化的“必须显式配置”。
	for (const key of REVIEW_KEYS)
		if (key !== "advisor" && key !== "reviewers" && !(key in raw))
			problems.push(msg.config.mustSet(`review.${key}`));
	const advisor = parseModelAtom(raw.advisor, "review.advisor", problems);
	const reviewers = reviewModels(raw.reviewers, problems);
	return {
		advisor,
		reviewers,
		maxRounds: reviewInt(raw.maxRounds, "review.maxRounds", 5, 1, 10, problems),
		advisorAfterFailures: reviewInt(raw.advisorAfterFailures, "review.advisorAfterFailures", 2, 1, 5, problems),
		timeoutMinutes: reviewInt(raw.timeoutMinutes, "review.timeoutMinutes", 20, 1, 60, problems),
		tools: reviewTools(raw.tools, problems),
	};
}

function reviewModels(value: unknown, problems: string[]): ModelAtom[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
		problems.push(msg.config.reviewReviewers);
		return [];
	}
	return value.map((item, index) => parseModelAtom(item, `review.reviewers[${index}]`, problems));
}

function reviewInt(
	value: unknown,
	field: string,
	fallback: number,
	min: number,
	max: number,
	problems: string[],
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		problems.push(msg.config.mustBeInteger(field, min, max));
		return fallback;
	}
	return value;
}

function reviewTools(value: unknown, problems: string[]): string[] {
	if (value === undefined) return [...DEFAULT_TOOLS];
	if (!Array.isArray(value)) {
		problems.push(msg.config.reviewToolsArray);
		return [...DEFAULT_TOOLS];
	}
	const tools = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	if (tools.length !== value.length || tools.length === 0)
		problems.push(msg.config.mustBeStringArray("review.tools"));
	return tools.length > 0 ? tools : [...DEFAULT_TOOLS];
}

// ---- master 节 ----

/** 导出供测试：与 review 节同样严格拒绝未知字段，类型错误记录而非静默回退。 */
export function parseMasterConfig(raw: Record<string, unknown>, problems: string[]): MasterConfig {
	for (const key of Object.keys(raw))
		if (key !== "roles" && key !== "workerExcludeExtensions" && key !== "autoActivate")
			problems.push(msg.config.unknownField(`master.${key}`));
	const exclusions = stringArray(raw.workerExcludeExtensions, "master.workerExcludeExtensions", problems);
	const autoActivate = booleanValue(raw.autoActivate, "master.autoActivate", true, problems);
	if (raw.roles === undefined)
		return { roles: [], workerExcludeExtensions: exclusions, autoActivate };
	if (!isPlainObject(raw.roles) || Object.keys(raw.roles).length === 0) {
		problems.push(msg.config.masterRoles);
		return { roles: [], workerExcludeExtensions: exclusions, autoActivate };
	}
	const roles = Object.entries(raw.roles).map(([role, value]) =>
		masterRole(value, `master.roles.${role}`, role, problems));
	return { roles, workerExcludeExtensions: exclusions, autoActivate };
}

function masterRole(value: unknown, field: string, role: string, problems: string[]): MasterRole {
	const record = asRecord(value);
	rejectUnknownKeys(record, ["model", "use", "fallback"], field, problems);
	const atom = parseModelAtom(record.model, `${field}.model`, problems);
	const use = typeof record.use === "string" && record.use ? record.use : "";
	if (!use) problems.push(msg.config.mustBeString(`${field}.use`));
	const fallback = masterFallback(record.fallback, `${field}.fallback`, problems);
	return { role, ...atom, use, fallback };
}

function masterFallback(value: unknown, field: string, problems: string[]): ModelAtom[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 2) {
		problems.push(msg.config.masterFallback(field));
		return [];
	}
	return value.map((item, index) => parseModelAtom(item, `${field}[${index}]`, problems));
}

// ---- watcher 节 ----

const WATCHER_KEYS = ["enabled", "model", "context"] as const;
const WATCHER_CONTEXTS = new Set<WatcherContext>(["minimal", "full"]);

/** 导出供测试：model 必填（含思考档），enabled 默认 true、context 默认 minimal。 */
export function parseWatcherConfig(raw: Record<string, unknown>, problems: string[]): WatcherConfig {
	rejectUnknownKeys(raw, WATCHER_KEYS, "watcher", problems);
	const enabled = booleanValue(raw.enabled, "watcher.enabled", true, problems);
	// 模型原子必填：缺失或写错时留空模型并记录问题，观察员据此拒绝启动。
	const atom = parseModelAtom(raw.model, "watcher.model", problems);
	let context: WatcherContext = "minimal";
	if (raw.context !== undefined) {
		if (typeof raw.context === "string" && WATCHER_CONTEXTS.has(raw.context as WatcherContext))
			context = raw.context as WatcherContext;
		else problems.push(msg.config.watcherContext);
	}
	return { enabled, ...atom, context };
}
