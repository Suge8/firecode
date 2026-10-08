/** 会话重命名：输入框里按宿主的改名键（app.session.rename，与 /resume 会话列表同一个键位）弹输入框改 pi 会话名。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 外壳（statusbar）在输入框收到改名键时发布，payload 是当时的 ExtensionContext。
 * 不用 registerShortcut：宿主把扩展快捷键与全部内置键位比对，宿主默认就把 ctrl+r 绑给 app.session.rename，
 * 注册同键必报冲突提示；改走编辑器动作则键位只归宿主配置，用户在 keybindings.json 改键即同步改到这里。
 */
export const RENAME_REQUEST_CHANNEL = "firecode:rename-request";

const MAX_TITLE_CHARS = 160;
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;

function cleanTitle(raw: string): string {
	const title = raw
		.replace(CONTROL_CHARS, " ")
		.replace(INVISIBLE_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(title).slice(0, MAX_TITLE_CHARS).join("");
}

export function registerSessionName(pi: ExtensionAPI): void {
	pi.events.on(RENAME_REQUEST_CHANNEL, async (data) => {
		const ctx = data as ExtensionContext;
		const next = await ctx.ui.input("重命名会话", pi.getSessionName() ?? "新名字");
		const name = cleanTitle(next ?? "");
		if (!name) return;
		pi.setSessionName(name);
		ctx.ui.notify(`会话已改名：${name}`, "info");
	});
}
