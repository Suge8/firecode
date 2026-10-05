import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, type Component } from "@earendil-works/pi-tui";
import { textOf } from "../format.js";
import { assistantFacts } from "./host.js";

export type AssistantActivity = "thinking" | "replying";
type AssistantData = ReturnType<typeof assistantFacts>;

/** 流式中的助手在做什么：最后一块是有字的正文即在回复，其余（还没内容、思考、空块）都算思考。 */
function activity(data: AssistantData): AssistantActivity | undefined {
	if (!data.isStreaming || ["aborted", "error", "length"].includes(data.lastMessage?.stopReason ?? "")) return;
	const last = data.lastMessage?.content.at(-1);
	if (last?.type === "text" && last.text.trim()) return "replying";
	if (!last || last.type === "text" || last.type === "thinking") return "thinking";
}

function withoutThinking(children: readonly Component[]): Component[] {
	const visible: Component[] = [];
	for (const child of children) {
		if (child instanceof MouseRegion) continue;
		if (child instanceof Spacer && visible.at(-1) instanceof Spacer) continue;
		visible.push(child);
	}
	while (visible.at(-1) instanceof Spacer) visible.pop();
	return visible;
}

/** 宿主在 contentContainer 内只给思考块包 MouseRegion。 */
export function hasThinking(source: AssistantMessageComponent): boolean {
	return assistantFacts(source).contentContainer.children.some((child) => child instanceof MouseRegion);
}

/** 正文和错误复用原组件；折叠态藏起思考块。 */
export function assistantView(source: AssistantMessageComponent, expanded: boolean): {
	body?: Component;
	activity?: AssistantActivity;
} {
	const data = assistantFacts(source);
	const children = data.contentContainer.children;
	const thinking = hasThinking(source);
	const visible = expanded || !thinking ? children : withoutThinking(children);
	const hasBody = visible.some((child) => !(child instanceof Spacer))
		|| source.children.some((child) => child !== data.contentContainer);
	let body: Component | undefined;
	if (hasBody) {
		body = source;
		if (!expanded && thinking) {
			const content = new Container();
			content.children = visible;
			// 独立的渲染接收者保留原生 OSC133/鼠标布局逻辑；原消息、原树和思考展开状态不改写。
			const projection: AssistantMessageComponent = Object.create(source);
			projection.children = source.children.map((child) => child === data.contentContainer ? content : child);
			projection.invalidate = () => {};
			body = projection;
		}
	}
	return { body, activity: expanded ? undefined : activity(data) };
}

/** 助手消息里的正文文字（不含思考与工具调用），中间回复的一行预览用它取首句。 */
export function replyText(source: AssistantMessageComponent): string {
	const message = assistantFacts(source).lastMessage;
	return textOf(message?.content).trim();
}
