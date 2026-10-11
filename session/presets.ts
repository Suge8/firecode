/**
 * 预设：一键切换模型、思考等级、工具集与附加指令。
 * 入口有 `--preset`（只在启动时应用）、`/preset [名字]` 与各预设的 key 快捷键。
 * 预设定义见 firecode/config.jsonc 的 presets 节。
 *
 * 模型、思考档与工具集的事实源是宿主：宿主把它们记在会话里，并在 session_start 之前（切分支时同样）恢复。
 * 这里只持有宿主不知道的两样——预设名与附加指令，且只在“当前模型仍是预设的模型”时成立：手动切走或重开会话时
 * 宿主恢复的不是它，预设即失效（名字与指令一并清掉并记入会话）。
 * 应用前的快照（模型、思考档、工具集）随预设名写进同一条会话记录：重开会话、切分支后清除预设，以及预设失效，
 * 都从它还原工具集；清除预设还原全部三样，失效不动模型。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { type Preset, loadConfig } from "../config.js";
import { isRecord } from "../jsonc.js";
import { STATUS_KEYS } from "../status-keys.js";
import { msg } from "./messages.js";

const CLEAR_ITEM = msg.presets.clearItem;
const STATE_ENTRY = "preset-state";
/** 记录格式版本；不是当前版本的旧记录一律当作没有预设。 */
const STATE_VERSION = 2;
const INSTRUCTIONS_PREVIEW_CHARS = 30;
const SELECTOR_MAX_ROWS = 10;

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** 应用预设之前宿主的状态。model 是 `provider/id`，没有模型时为空。 */
interface Snapshot {
	model?: string;
	thinking: ThinkingLevel;
	tools: string[];
}

/** 会话记录：预设名（null 表示没有预设）与它生效前的快照；没有预设时没有快照。 */
interface PresetState {
	name: string | null;
	original?: Snapshot;
}

function parseState(data: unknown): PresetState | undefined {
	if (!isRecord(data) || data.version !== STATE_VERSION) return undefined;
	if (data.name === null) return { name: null };
	const { original } = data;
	if (typeof data.name !== "string" || !isRecord(original)) return undefined;
	const { model, thinking, tools } = original;
	if ((model !== undefined && typeof model !== "string") || typeof thinking !== "string") return undefined;
	if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) return undefined;
	return { name: data.name, original: { model, thinking: thinking as ThinkingLevel, tools } };
}

const title = (text: string): string =>
	text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;

const modelKey = (model: Model<Api> | undefined) => (model ? `${model.provider}/${model.id}` : undefined);

/** 模型原子在配置层已校验为 provider/model；调 Pi 接口时才拆成两段。 */
function splitModel(id: string): [provider: string, model: string] {
	const slash = id.indexOf("/");
	return [id.slice(0, slash), id.slice(slash + 1)];
}

/** 预设对模型的要求：当前模型就是预设的模型，或预设根本不管模型。 */
function holds(preset: Preset, model: Model<Api> | undefined): boolean {
	return !preset.model || modelKey(model) === preset.model.model;
}

function describe(preset: Preset): string {
	const parts: string[] = [];
	if (preset.model) parts.push(preset.model.model, `thinking:${preset.model.thinking}`);
	if (preset.tools) parts.push(`tools:${preset.tools.join(",")}`);
	if (preset.instructions) {
		const preview =
			preset.instructions.length > INSTRUCTIONS_PREVIEW_CHARS
				? `${preset.instructions.slice(0, INSTRUCTIONS_PREVIEW_CHARS - 3)}...`
				: preset.instructions;
		parts.push(`"${preview}"`);
	}
	return parts.join(" | ");
}

export function registerPresets(pi: ExtensionAPI): void {
	// 配置问题由 index.ts 统一提示，这里只取预设。
	const { presets } = loadConfig().config;
	let activeName: string | undefined;
	/** 与 activeName 同生同灭：有预设生效时必有快照。 */
	let original: Snapshot | undefined;
	/** 本模块自己切模型期间的 model_select 不算用户切走。 */
	let applying = false;

	pi.registerFlag("preset", {
		description: msg.presets.flagDescription,
		type: "string",
	});

	/**
	 * 预设名只在它带来边框看不见的改动（工具集、附加指令）时发布：模型与思考档已显示在输入框下边框，
	 * 只改这两样的预设再报名字就是同一信息说两遍。
	 */
	const updateStatus = (ctx: ExtensionContext) => {
		const active = activePreset();
		ctx.ui.setStatus(
			STATUS_KEYS.preset,
			activeName && (active?.tools?.length || active?.instructions) ? ctx.ui.theme.fg("accent", title(activeName)) : undefined,
		);
	};

	const unknownPreset = (name: string, ctx: ExtensionContext, level: "warning" | "error") =>
		ctx.ui.notify(msg.presets.unknown(name, Object.keys(presets).join(", ") || msg.presets.noneAvailable), level);

	const activePreset = () => (activeName === undefined ? undefined : presets[activeName]);

	const snapshot = (ctx: ExtensionContext): Snapshot => ({
		model: modelKey(ctx.model),
		thinking: pi.getThinkingLevel(),
		tools: [...pi.getActiveTools()],
	});

	/** 预设状态写进当前分支（与宿主的模型记录同一棵树）；重开会话按它恢复。 */
	function setActive(name: string | undefined, from: Snapshot | undefined, ctx: ExtensionContext): void {
		activeName = name;
		original = name === undefined ? undefined : from;
		const state = name === undefined ? { name: null } : { name, original };
		pi.appendEntry(STATE_ENTRY, { version: STATE_VERSION, ...state });
		updateStatus(ctx);
	}

	/** 预设的工具集；没写工具集（或写的全是未知工具）的预设用快照里的。 */
	function toolsFor(name: string, preset: Preset, from: Snapshot, ctx: ExtensionContext): string[] {
		if (!preset.tools?.length) return from.tools;
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		const unknown = preset.tools.filter((tool) => !known.has(tool));
		if (unknown.length) ctx.ui.notify(msg.presets.unknownTools(name, unknown), "warning");
		const valid = preset.tools.filter((tool) => known.has(tool));
		return valid.length ? valid : from.tools;
	}

	/** 先套模型；模型套用失败就整套不套（不动工具、不设预设名），只提示原因。 */
	async function applyPreset(name: string, ctx: ExtensionContext): Promise<void> {
		const preset = presets[name];
		const from = original ?? snapshot(ctx);
		applying = true;
		const failure = await applyModel(preset, ctx).finally(() => { applying = false; });
		if (failure) {
			ctx.ui.notify(msg.presets.notSwitched(name, failure), "warning");
			return;
		}
		pi.setActiveTools(toolsFor(name, preset, from, ctx));
		setActive(name, from, ctx);
		ctx.ui.notify(msg.presets.switched(name), "info");
	}

	/** 返回失败原因；成功或预设不管模型时为 undefined。 */
	async function applyModel(preset: Preset, ctx: ExtensionContext): Promise<string | undefined> {
		if (!preset.model) return undefined;
		const [provider, id] = splitModel(preset.model.model);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return msg.presets.modelNotFound(preset.model.model);
		if (!(await pi.setModel(model))) return msg.presets.modelNoCredentials(preset.model.model);
		pi.setThinkingLevel(preset.model.thinking);
		return undefined;
	}

	/** 预设不再生效（模型被手动切走，或预设已不在配置里）：清名字与指令，工具集还原，模型不动。 */
	function release(message: (restored: boolean) => string, ctx: ExtensionContext): void {
		const from = original;
		const restored = !!from && !sameTools(from.tools, pi.getActiveTools());
		setActive(undefined, undefined, ctx);
		if (from && restored) pi.setActiveTools(from.tools);
		ctx.ui.notify(message(restored), "info");
	}

	function dropIfDiverged(ctx: ExtensionContext): void {
		const active = activePreset();
		if (!activeName || !active || holds(active, ctx.model)) return;
		const name = activeName;
		release((restored) => (restored ? msg.presets.divergedRestored(name) : msg.presets.diverged(name)), ctx);
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		const from = original;
		if (!from) {
			ctx.ui.notify(msg.presets.noneActive, "info");
			return;
		}
		setActive(undefined, undefined, ctx);
		applying = true;
		const failure = await restoreModel(from.model, ctx).finally(() => { applying = false; });
		pi.setThinkingLevel(from.thinking);
		pi.setActiveTools(from.tools);
		ctx.ui.notify(failure ? msg.presets.clearedWithoutModel(failure) : msg.presets.cleared, failure ? "warning" : "info");
	}

	/** 还原快照里的模型；当前已是它、或快照没有模型时不动。返回失败原因。 */
	async function restoreModel(key: string | undefined, ctx: ExtensionContext): Promise<string | undefined> {
		if (!key || key === modelKey(ctx.model)) return undefined;
		const [provider, id] = splitModel(key);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return msg.presets.modelNotFound(key);
		return (await pi.setModel(model)) ? undefined : msg.presets.modelNoCredentials(key);
	}

	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			ctx.ui.notify(msg.presets.noneDefined, "warning");
			return;
		}

		const items: SelectItem[] = names.map((name) => ({
			value: name,
			label: name === activeName ? msg.presets.current(name) : name,
			description: describe(presets[name]),
		}));
		items.push({
			value: CLEAR_ITEM,
			label: CLEAR_ITEM,
			description: msg.presets.clearDescription,
		});

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold(msg.presets.selectTitle))));

			const selectList = new SelectList(items, Math.min(items.length, SELECTOR_MAX_ROWS), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", msg.presets.selectHint)));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!choice) return;
		if (choice === CLEAR_ITEM) await clearPreset(ctx);
		else await applyPreset(choice, ctx);
	}

	for (const [name, preset] of Object.entries(presets)) {
		if (!preset.key) continue;
		pi.registerShortcut(preset.key as never, {
			description: msg.presets.shortcutDescription(name),
			handler: (ctx) => applyPreset(name, ctx),
		});
	}

	pi.registerCommand("preset", {
		description: msg.presets.commandDescription,
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				await showSelector(ctx);
				return;
			}
			// 与选择器同一个“无”项：清除当前预设。
			if (name === CLEAR_ITEM) {
				await clearPreset(ctx);
				return;
			}
			if (!presets[name]) {
				unknownPreset(name, ctx, "error");
				return;
			}
			await applyPreset(name, ctx);
		},
	});

	pi.on("model_select", (_event, ctx) => {
		if (!applying) dropIfDiverged(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		dropIfDiverged(ctx);
		const instructions = activePreset()?.instructions;
		if (instructions) event.systemPromptOptions.sections.firecode_preset = instructions;
	});

	// 同会话切到另一分支：宿主按该分支恢复模型，预设也按该分支的记录重新判定。
	// 新开/恢复/分叉/重载会话时宿主重新调用本函数，状态天然是新的。
	pi.on("session_tree", (_event, ctx) => {
		activeName = undefined;
		original = undefined;
		restore(ctx);
		updateStatus(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		// 先按会话记录恢复：启动时命令行预设盖在已恢复的预设上，快照要沿用最初的，不能拿受限状态当默认。
		restore(ctx);
		// 命令行预设只管启动那一次：之后的重载、恢复、新会话按各自的会话记录走，不被它复活或覆盖。
		const flag = event.reason === "startup" ? pi.getFlag("preset") : undefined;
		if (typeof flag === "string" && flag) {
			if (presets[flag]) await applyPreset(flag, ctx);
			else unknownPreset(flag, ctx, "warning");
		}
		updateStatus(ctx);
	});

	/** 按当前分支最后一条预设记录恢复：宿主已恢复模型与工具集，模型仍是预设的才算生效。 */
	function restore(ctx: ExtensionContext): void {
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === STATE_ENTRY) as
			{ data?: unknown } | undefined;
		const state = parseState(entry?.data);
		if (!state?.name) return;
		const preset = presets[state.name];
		activeName = state.name;
		original = state.original;
		if (!preset) release(() => msg.presets.gone(state.name!), ctx);
		else if (!holds(preset, ctx.model)) dropIfDiverged(ctx);
	}
}

const sameTools = (left: readonly string[], right: readonly string[]) =>
	left.length === right.length && left.every((tool) => right.includes(tool));
