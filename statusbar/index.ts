/** 底部两行：目录/展示标题/模块状态 + 模型/上下文。 */
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { formatModelName, oneLine } from "../format.js";
import { thinkingColor } from "../theme.js";
import { alignRight, fitMetadataLine, fitStatusLine, reviewStatus, statusBadges, renderContext } from "./render.js";

const TITLE_CHARACTERS = 6;
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cleanTitle = (text: string) => oneLine(stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " "));

function userTitle(message: MessageStartEvent["message"]): string | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	const text = cleanTitle(typeof content === "string" ? content : content
		.filter((block) => block.type === "text").map((block) => block.text).join(" "));
	if (!text) return undefined;
	let title = "";
	let count = 0;
	for (const { segment } of characters.segment(text)) {
		if (count++ === TITLE_CHARACTERS) return `${title}…`;
		title += segment;
	}
	return title;
}

function displayTitle(ctx: ExtensionContext, incoming?: MessageStartEvent["message"]): string {
	const name = ctx.sessionManager.getSessionName();
	if (name) return cleanTitle(name);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const title = userTitle(entry.message);
		if (title) return title;
	}
	return (incoming && userTitle(incoming)) || "新会话";
}

export function registerStatusBar(pi: ExtensionAPI, subsession = false): void {
	if (subsession) return;
	let title = "新会话";
	let requestRender = () => {};
	const updateTitle = (ctx: ExtensionContext, incoming?: MessageStartEvent["message"]) => {
		title = displayTitle(ctx, incoming);
		requestRender();
	};
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") updateTitle(ctx, event.message);
	});
	pi.on("session_info_changed", (_event, ctx) => updateTitle(ctx));
	pi.on("session_tree", (_event, ctx) => updateTitle(ctx));
	pi.on("session_start", (_event, ctx) => {
		updateTitle(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			return {
				dispose() { requestRender = () => {}; },
				invalidate() {},
				render(width: number): string[] {
					const statuses = footerData.getExtensionStatuses();
					const model = ctx.model;
					const thinking = pi.getThinkingLevel();
					const modelCore = `${theme.fg("accent", `🧠 ${formatModelName(model?.id)}`)}${
						model?.reasoning ? theme.fg(thinkingColor(thinking), `/${thinking}`) : ""
					}`;
					const modelText = statuses.has("pi-openai-native-fast")
						? `${modelCore}${theme.fg("warning", " · ⚡fast")}` : modelCore;
					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const separator = ` ${theme.fg("dim", "｜")} `;
					return [
						alignRight(fitMetadataLine(
							theme.fg("dim", `📍${cleanTitle(basename(ctx.sessionManager.getCwd()) || "/")}`),
							theme.fg("dim", `💬 ${title}`), width, separator, statusBadges(statuses, separator),
						), reviewStatus(statuses), width),
						fitStatusLine({
							model: modelText, modelCompact: modelCore,
							context: renderContext(theme, usage?.percent, window),
							contextCompact: renderContext(theme, usage?.percent, window, true),
						}, width, separator),
					];
				},
			};
		});
	});
	pi.on("thinking_level_select", () => requestRender());
	pi.on("model_select", () => requestRender());
	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = () => {};
		ctx.ui.setFooter(undefined);
	});
}
