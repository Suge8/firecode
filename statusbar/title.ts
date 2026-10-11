/**
 * 展示标题与改名：外壳下边框左侧的会话标题只在这里得来、清洗、修改。
 * 正式会话名优先，否则取当前分支首条非空用户文本的首句，尚无文本显示“新会话”；不写回会话名。
 * 改名走宿主的 app.session.rename 键位（与 /resume 会话列表同一个键），弹输入框后设会话名。
 * 不用 registerShortcut：宿主把扩展快捷键与全部内置键位比对，宿主默认就把 ctrl+r 绑给 app.session.rename，
 * 注册同键必报冲突提示；改走编辑器动作则键位只归宿主配置，用户在 keybindings.json 改键即同步改到这里。
 */
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { clip, firstSentence, oneLine, textOf } from "../format.js";
import { msg } from "./messages.js";

/** 展示标题的上限（列）：实际宽度由下边框布局按终端宽度逐级裁。 */
const TITLE_MAX_WIDTH = 60;
const MAX_NAME_CHARS = 160;
/** 控制字符换成空格，换行留给首句规则识别 Markdown 结构。 */
const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;

/** 去掉终端控制序列、控制字符与零宽字符：标题来自模型输入与用户输入，不能带样式或改写终端。 */
const clean = (text: string) => stripVTControlCharacters(text).replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "");

function userTitle(message: MessageStartEvent["message"]): string | undefined {
	if (message.role !== "user") return undefined;
	return clip(firstSentence(clean(textOf(message.content))), TITLE_MAX_WIDTH) || undefined;
}

/** incoming：刚开始、尚未落盘的用户消息，让标题在消息进分支之前就能显示。 */
export function displayTitle(ctx: ExtensionContext, incoming?: MessageStartEvent["message"]): string {
	const name = ctx.sessionManager.getSessionName();
	if (name) return oneLine(clean(name));
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const title = userTitle(entry.message);
		if (title) return title;
	}
	return (incoming && userTitle(incoming)) || msg.newSession;
}

export async function promptRename(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const next = await ctx.ui.input(msg.rename.title, pi.getSessionName() ?? msg.rename.placeholder);
	const name = Array.from(oneLine(clean(next ?? ""))).slice(0, MAX_NAME_CHARS).join("");
	if (!name) return;
	pi.setSessionName(name);
	ctx.ui.notify(msg.rename.done(name), "info");
}
