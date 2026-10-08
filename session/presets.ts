/**
 * 预设：一键切换模型、思考等级、工具集与附加指令。
 * 入口有 `--preset`、`/preset [名字]` 与各预设的 key 快捷键。
 * 预设定义见 firecode/config.jsonc 的 presets 节。
 *
 * 模型、思考档与工具集的事实源是宿主：宿主把它们记在会话里，并在 session_start 之前（切分支时同样）恢复。
 * 这里只持有宿主不知道的两样——预设名与附加指令，且只在“当前模型仍是预设的模型”时成立：手动切走或重开会话时
 * 宿主恢复的不是它，预设即失效（名字与指令一并清掉并记入会话），不另存一份模型去覆盖宿主，也不动宿主的工具集。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { type Preset, loadConfig } from "../config.js";
import { msg } from "./messages.js";

const CLEAR_ITEM = msg.presets.clearItem;
const STATE_ENTRY = "preset-state";
const INSTRUCTIONS_PREVIEW_CHARS = 30;
const SELECTOR_MAX_ROWS = 10;

/** 会话可用的等级比预设可配置的多（含 max），快照要按前者存。重开会话后预设之前的模型已不可知，model 为空表示不动模型。 */
type OriginalState = {
	model: Model<Api> | undefined;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	tools: string[];
};

const title = (text: string): string =>
	text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;

/** 模型原子在配置层已校验为 provider/model；调 Pi 接口时才拆成两段。 */
function splitModel(id: string): [provider: string, model: string] {
	const slash = id.indexOf("/");
	return [id.slice(0, slash), id.slice(slash + 1)];
}

/** 预设对模型的要求：当前模型就是预设的模型，或预设根本不管模型。 */
function holds(preset: Preset, model: Model<Api> | undefined): boolean {
	return !preset.model || (!!model && `${model.provider}/${model.id}` === preset.model.model);
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
	let originalState: OriginalState | undefined;
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
			"preset",
			activeName && (active?.tools?.length || active?.instructions) ? ctx.ui.theme.fg("accent", title(activeName)) : undefined,
		);
	};

	const activePreset = () => (activeName === undefined ? undefined : presets[activeName]);

	/** 预设状态写进当前分支（与宿主的模型记录同一棵树），null 表示没有预设；重开会话按它恢复。 */
	function setActive(name: string | undefined, ctx: ExtensionContext): void {
		activeName = name;
		if (name === undefined) originalState = undefined;
		pi.appendEntry(STATE_ENTRY, { name: name ?? null });
		updateStatus(ctx);
	}

	function applyTools(name: string, preset: Preset, ctx: ExtensionContext): void {
		if (!preset.tools?.length) return;
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		const valid = preset.tools.filter((tool) => known.has(tool));
		const unknown = preset.tools.filter((tool) => !known.has(tool));
		if (unknown.length)
			ctx.ui.notify(msg.presets.unknownTools(name, unknown), "warning");
		if (valid.length) pi.setActiveTools(valid);
	}

	/** 先套模型；模型套用失败就整套不套（不动工具、不设预设名），只提示原因。 */
	async function applyPreset(name: string, ctx: ExtensionContext): Promise<void> {
		const preset = presets[name];
		// 首次应用前留一份快照，用于恢复默认。
		const snapshot = activeName === undefined
			? { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools() }
			: originalState;
		applying = true;
		const failure = await applyModel(preset, ctx).finally(() => { applying = false; });
		if (failure) {
			ctx.ui.notify(msg.presets.notSwitched(name, failure), "warning");
			return;
		}
		originalState = snapshot;
		applyTools(name, preset, ctx);
		setActive(name, ctx);
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

	/** 当前模型已不是预设的：预设失效。 */
	function dropIfDiverged(ctx: ExtensionContext): void {
		const active = activePreset();
		if (!activeName || !active || holds(active, ctx.model)) return;
		const name = activeName;
		setActive(undefined, ctx);
		ctx.ui.notify(msg.presets.diverged(name), "info");
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		const original = originalState;
		setActive(undefined, ctx);
		if (original) {
			if (original.model) await pi.setModel(original.model);
			pi.setThinkingLevel(original.thinkingLevel);
			pi.setActiveTools(original.tools);
		}
		ctx.ui.notify(msg.presets.cleared, "info");
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
				const available = Object.keys(presets).join(", ") || msg.presets.noneAvailable;
				ctx.ui.notify(msg.presets.unknown(name, available), "error");
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
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	/** 同进程内新开/切换会话或切分支复用本模块实例：上一处的预设不带进来。 */
	const reset = () => {
		activeName = undefined;
		originalState = undefined;
	};

	// 切到另一分支：宿主按该分支恢复模型，预设也按该分支的记录重新判定。
	pi.on("session_tree", (_event, ctx) => {
		reset();
		restore(ctx);
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		reset();
		const flag = pi.getFlag("preset");
		if (typeof flag === "string" && flag) {
			if (presets[flag]) {
				await applyPreset(flag, ctx);
			} else {
				const available = Object.keys(presets).join(", ") || msg.presets.noneAvailable;
				ctx.ui.notify(msg.presets.unknown(flag, available), "warning");
			}
		} else restore(ctx);
		updateStatus(ctx);
	});

	/** 按当前分支最后一条预设记录恢复：宿主已恢复模型与工具集，模型仍是预设的才算生效。 */
	function restore(ctx: ExtensionContext): void {
		const record = ctx.sessionManager
			.getBranch()
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_ENTRY)
			.pop() as { data?: { name: string | null } } | undefined;
		const name = record?.data?.name;
		if (!name) return;
		const preset = presets[name];
		if (!preset || !holds(preset, ctx.model)) {
			setActive(undefined, ctx);
			ctx.ui.notify(preset ? msg.presets.diverged(name) : msg.presets.gone(name), "info");
			return;
		}
		activeName = name;
		// 应用预设之前的状态不在会话记录里：清除时不动模型，思考档与工具集维持宿主恢复的。
		originalState = { model: undefined, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools() };
	}
}
