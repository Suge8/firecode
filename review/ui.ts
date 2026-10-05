/**
 * /fire-review 的界面接管：esc 取消的只读编辑器与终端标题。
 *
 * 审查进度不在这里画：它经占用频道（occupancy.ts）发布，由输入框外壳嵌进上边框，界面只此一处。
 * Working 指示的可见性归输入框外壳（statusbar）统一管理，这里不碰。
 */
import { basename } from "node:path";
import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
import { clip } from "../format.js";

let reviewTitleActive = false;

/**
 * 审查等模型结论时（排队/审查中/顾问仲裁）接管编辑器：禁止输入，esc/Ctrl+C 随时取消。
 * 返回解锁函数，还原成锁定前的编辑器工厂（可能是别的扩展设置的自定义编辑器）。
 *
 * 不能用全局输入钩子比对裸 \x1b：终端开启增强键盘协议后 esc 是带修饰的序列，
 * 字面量比较会漏。这里统一走 keybindings 匹配。
 * awaiting_fix 相不接管——那时是执行模型在改代码，用户应能正常输入与中断。
 */
export function lockEditor(ctx: ExtensionContext, cancel: () => void): () => void {
	if (ctx.hasUI === false || typeof ctx.ui.setEditorComponent !== "function") return () => {};
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const frame = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		return new ReviewEditor(tui, theme, keybindings, cancel, frame);
	});
	return () => ctx.ui.setEditorComponent(previous);
}

/**
 * 审查期间的只读编辑器：输入区收起成一行暗色提示，上下边框取自 frame（锁定前的编辑器），
 * 外壳状态（审查进度、会话标题、模型）因此保持可见。
 */
class ReviewEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly cancel: () => void,
		private readonly frame: EditorComponent,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		if (this.keys.matches(data, "app.interrupt") || this.keys.matches(data, "app.clear")) this.cancel();
		// 审查期间不接受任何其他输入：插话会污染本轮审查的会话证据。
	}

	override render(width: number): string[] {
		const lines = this.frame.render(width);
		if (lines.length < 2) return lines;
		const keys = this.keys.getKeys("app.interrupt").join("/").replaceAll("escape", "esc") || "esc";
		const hint = clip(`  审查进行中 · ${keys} 取消`, width, "end", "");
		return [lines[0], `\x1b[2m${hint}\x1b[22m`, lines[lines.length - 1]];
	}
}

/** 审查期间终端标题写明“审查中 R轮次 · 会话名”，结束后还原。 */
export function showReviewTitle(ctx: ExtensionContext, round: number, language: Language) {
	if (!ctx.hasUI || typeof ctx.ui.setTitle !== "function") return;
	const manager = ctx.sessionManager as { getSessionName?: () => unknown; getCwd?: () => unknown };
	const rawName = manager.getSessionName?.();
	const rawCwd = manager.getCwd?.();
	const who = typeof rawName === "string" && rawName
		? rawName
		: typeof rawCwd === "string" ? basename(rawCwd) : "";
	const label = language === "en" ? "Reviewing" : "审查中";
	reviewTitleActive = true;
	ctx.ui.setTitle(`${label}${round > 0 ? ` R${round}` : ""}${who ? ` · ${who}` : ""}`);
}

export function hideReviewTitle(ctx: ExtensionContext) {
	if (!reviewTitleActive || !ctx.hasUI || typeof ctx.ui.setTitle !== "function") return;
	reviewTitleActive = false;
	const manager = ctx.sessionManager as { getSessionName?: () => unknown; getCwd?: () => unknown };
	const rawName = manager.getSessionName?.();
	const rawCwd = manager.getCwd?.();
	const name = typeof rawName === "string" && rawName ? rawName : undefined;
	const dir = typeof rawCwd === "string" ? basename(rawCwd) : "";
	ctx.ui.setTitle(name ? `π - ${name} - ${dir}` : `π - ${dir}`);
}
