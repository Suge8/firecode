/**
 * 预设：一键切换模型、思考等级、工具集与附加指令。
 * 入口有 `--preset`、`/preset [名字]`、Option+1-9、Ctrl+Shift+U 循环。
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

const CLEAR_ITEM = "（无）";
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
	let presets: Record<string, Preset> = {};
	let activeName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;
	/** 本模块自己切模型期间的 model_select 不算用户切走。 */
	let applying = false;

	pi.registerFlag("preset", {
		description: "要启用的预设名",
		type: "string",
	});

	const updateStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(
			"preset",
			activeName ? ctx.ui.theme.fg("accent", title(activeName)) : undefined,
		);

	const noPresetsHint = (ctx: ExtensionContext) =>
		ctx.ui.notify("未定义任何预设。在 firecode/config.jsonc 的 presets 里添加。", "warning");

	/** 预设状态写进当前分支（与宿主的模型记录同一棵树），null 表示没有预设；重开会话按它恢复。 */
	function setActive(name: string | undefined, ctx: ExtensionContext): void {
		activeName = name;
		activePreset = name === undefined ? undefined : presets[name];
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
			ctx.ui.notify(`预设「${name}」含未知工具：${unknown.join("、")}`, "warning");
		if (valid.length) pi.setActiveTools(valid);
	}

	/** 先套模型；模型套用失败就整套不套（不动工具、不设预设名），只提示原因。 */
	async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<void> {
		// 首次应用前留一份快照，用于恢复默认。
		const snapshot = activeName === undefined
			? { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools() }
			: originalState;
		applying = true;
		const failure = await applyModel(preset, ctx).finally(() => { applying = false; });
		if (failure) {
			ctx.ui.notify(`预设「${name}」未切换：${failure}`, "warning");
			return;
		}
		originalState = snapshot;
		applyTools(name, preset, ctx);
		setActive(name, ctx);
		ctx.ui.notify(`已切换预设「${name}」`, "info");
	}

	/** 返回失败原因；成功或预设不管模型时为 undefined。 */
	async function applyModel(preset: Preset, ctx: ExtensionContext): Promise<string | undefined> {
		if (!preset.model) return undefined;
		const [provider, id] = splitModel(preset.model.model);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return `找不到模型 ${preset.model.model}`;
		if (!(await pi.setModel(model))) return `模型 ${preset.model.model} 没有可用凭据`;
		pi.setThinkingLevel(preset.model.thinking);
		return undefined;
	}

	/** 当前模型已不是预设的：预设失效。 */
	function dropIfDiverged(ctx: ExtensionContext): void {
		if (!activeName || !activePreset || holds(activePreset, ctx.model)) return;
		const name = activeName;
		setActive(undefined, ctx);
		ctx.ui.notify(`模型已不是预设「${name}」的，预设已失效`, "info");
	}

	async function activate(name: string, ctx: ExtensionContext): Promise<void> {
		const preset = presets[name];
		if (!preset) return;
		await applyPreset(name, preset, ctx);
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		const original = originalState;
		setActive(undefined, ctx);
		if (original) {
			if (original.model) await pi.setModel(original.model);
			pi.setThinkingLevel(original.thinkingLevel);
			pi.setActiveTools(original.tools);
		}
		ctx.ui.notify("预设已清除，恢复默认", "info");
	}

	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			noPresetsHint(ctx);
			return;
		}

		const items: SelectItem[] = names.map((name) => ({
			value: name,
			label: name === activeName ? `${name}（当前）` : name,
			description: describe(presets[name]),
		}));
		items.push({
			value: CLEAR_ITEM,
			label: CLEAR_ITEM,
			description: "清除当前预设，恢复默认",
		});

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("选择预设"))));

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
			container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消")));
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
		else await activate(choice, ctx);
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			noPresetsHint(ctx);
			return;
		}
		const cycle = [CLEAR_ITEM, ...names];
		const current = cycle.indexOf(activeName ?? CLEAR_ITEM);
		const next = cycle[current === -1 ? 0 : (current + 1) % cycle.length];
		if (next === CLEAR_ITEM) await clearPreset(ctx);
		else await activate(next, ctx);
	}

	const { keys, presets: configured } = loadConfig().config;

	pi.registerShortcut(keys.cyclePreset as never, {
		description: "轮切预设",
		handler: (ctx) => cyclePreset(ctx),
	});

	for (const [name, preset] of Object.entries(configured)) {
		if (!preset.key) continue;
		pi.registerShortcut(preset.key as never, {
			description: `启用预设「${name}」`,
			handler: (ctx) => activate(name, ctx),
		});
	}

	pi.registerCommand("preset", {
		description: "切换预设",
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
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`未知预设「${name}」，可用：${available}`, "error");
				return;
			}
			await activate(name, ctx);
		},
	});

	pi.on("model_select", (_event, ctx) => {
		if (!applying) dropIfDiverged(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		dropIfDiverged(ctx);
		if (!activePreset?.instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}` };
	});

	/** 同进程内新开/切换会话或切分支复用本模块实例：上一处的预设不带进来。 */
	const reset = () => {
		activeName = undefined;
		activePreset = undefined;
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
		// 配置问题由 index.ts 统一提示，这里只取预设。
		presets = loadConfig().config.presets;

		const flag = pi.getFlag("preset");
		if (typeof flag === "string" && flag) {
			if (presets[flag]) {
				await applyPreset(flag, presets[flag], ctx);
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`未知预设「${flag}」，可用：${available}`, "warning");
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
			ctx.ui.notify(preset ? `模型已不是预设「${name}」的，预设已失效` : `预设「${name}」已不在配置里，已清除`, "info");
			return;
		}
		activeName = name;
		activePreset = preset;
		// 应用预设之前的状态不在会话记录里：清除时不动模型，思考档与工具集维持宿主恢复的。
		originalState = { model: undefined, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools() };
	}
}
