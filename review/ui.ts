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
import { clip } from "../format.js";
import { msg } from "./messages.js";

/**
 * 审查等模型结论时（排队/审查中/顾问仲裁）接管编辑器：禁止输入，esc/Ctrl+C 随时取消。
 * 返回解锁函数，还原成锁定前的编辑器工厂（可能是别的扩展设置的自定义编辑器）。
 *
 * 不能用全局输入钩子比对裸 \x1b：终端开启增强键盘协议后 esc 是带修饰的序列，
 * 字面量比较会漏。这里统一走 keybindings 匹配。
 * awaiting_fix 相不接管——那时是执行模型在改代码，用户应能正常输入与中断。
 */
function lockEditor(ctx: ExtensionContext, cancel: () => void): () => void {
	const previous = ctx.ui.getEditorComponent();
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
		const hint = clip(msg.ui.editorHint(keys), width, "end", "");
		return [lines[0], `\x1b[2m${hint}\x1b[22m`, lines[lines.length - 1]];
	}
}

/** 一场审查的界面接管：终端标题与只读编辑器，各自记着要还原的东西；只在有 UI 的会话里使用。 */
export class ReviewUi {
	private unlockEditor: (() => void) | undefined;
	private titleShown = false;

	/** 标题始终写明审查轮次；canCancel 为真（等模型结论）时才接管编辑器，修复/总结相把输入交还用户。 */
	show(ctx: ExtensionContext, round: number, canCancel: boolean, cancel: () => void): void {
		this.showTitle(ctx, round);
		if (!canCancel) return this.releaseEditor();
		this.unlockEditor ??= lockEditor(ctx, cancel);
	}

	clear(ctx: ExtensionContext): void {
		if (this.titleShown) ctx.ui.setTitle(restoredTitle(ctx));
		this.titleShown = false;
		this.releaseEditor();
	}

	private showTitle(ctx: ExtensionContext, round: number): void {
		const who = ctx.sessionManager.getSessionName() || basename(ctx.sessionManager.getCwd());
		this.titleShown = true;
		ctx.ui.setTitle(`${msg.ui.reviewing}${round > 0 ? ` R${round}` : ""}${who ? ` · ${who}` : ""}`);
	}

	private releaseEditor(): void {
		this.unlockEditor?.();
		this.unlockEditor = undefined;
	}
}

/** 与宿主默认终端标题同一写法。 */
function restoredTitle(ctx: ExtensionContext): string {
	const name = ctx.sessionManager.getSessionName();
	const dir = basename(ctx.sessionManager.getCwd());
	return name ? `π - ${name} - ${dir}` : `π - ${dir}`;
}
