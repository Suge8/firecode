import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, type Component } from "@earendil-works/pi-tui";

export type AssistantActivity = "thinking" | "processing";
type AssistantData = { contentContainer: Container; lastMessage?: AssistantMessage; isStreaming: boolean };

function activity(data: AssistantData): AssistantActivity | undefined {
	if (!data.isStreaming || ["aborted", "error", "length"].includes(data.lastMessage?.stopReason ?? "")) return;
	const last = data.lastMessage?.content.at(-1);
	if (last?.type === "thinking" && last.thinking.trim()) return "thinking";
	if (!last || (last.type === "text" && !last.text.trim()) || (last.type === "thinking" && !last.thinking.trim()))
		return "processing";
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

/** 宿主在 contentContainer 内只给思考块包 MouseRegion；正文和错误仍复用原组件。 */
export function assistantView(source: AssistantMessageComponent, expanded: boolean): {
	body?: Component;
	activity?: AssistantActivity;
} {
	const data = source as unknown as AssistantData;
	const children = data.contentContainer.children;
	const hasThinking = children.some((child) => child instanceof MouseRegion);
	const visible = expanded || !hasThinking ? children : withoutThinking(children);
	const hasBody = visible.some((child) => !(child instanceof Spacer))
		|| source.children.some((child) => child !== data.contentContainer);
	let body: Component | undefined;
	if (hasBody) {
		body = source;
		if (!expanded && hasThinking) {
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
