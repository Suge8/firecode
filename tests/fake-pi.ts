type Handler = (...args: any[]) => unknown;

/**
 * 测试共用的假 ExtensionAPI。与宿主一致：同名事件保留全部处理器，事件总线可发可收，on 返回退订函数；
 * 其余注册与发送方法默认只记录。个别测试需要的宿主行为（投递失败、前门唤起回合、模型切换）经 overrides 覆盖。
 */
export function fakePi(overrides: Record<string, unknown> = {}) {
	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Handler[]>();
	const subscribe = (table: Map<string, Handler[]>, name: string, handler: Handler) => {
		table.set(name, [...(table.get(name) ?? []), handler]);
		return () => { table.set(name, (table.get(name) ?? []).filter((candidate) => candidate !== handler)); };
	};
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const messageRenderers = new Map<string, unknown>();
	const entryRenderers = new Map<string, unknown>();
	const sent: { message: any; options: any }[] = [];
	const userMessages: string[] = [];
	const appended: [string, any][] = [];
	const emitted: [string, any][] = [];
	let activeTools: string[] = [];
	let thinking = "off";

	const pi: Record<string, any> = {
		on: (name: string, handler: Handler) => subscribe(handlers, name, handler),
		events: {
			on: (channel: string, handler: Handler) => subscribe(channels, channel, handler),
			emit: (channel: string, data?: unknown) => {
				emitted.push([channel, data]);
				for (const handler of [...(channels.get(channel) ?? [])]) handler(data);
			},
		},
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerShortcut: (key: string, shortcut: unknown) => shortcuts.set(key, shortcut),
		registerMessageRenderer: (type: string, renderer: unknown) => messageRenderers.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: unknown) => entryRenderers.set(type, renderer),
		registerFlag() {},
		getFlag: () => undefined,
		sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); },
		sendUserMessage: (content: string) => { userMessages.push(content); },
		appendEntry: (type: string, data: unknown) => { appended.push([type, data]); },
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = names; },
		getAllTools: () => [],
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; },
		...overrides,
	};

	/** 按注册顺序同步调用某事件的全部处理器；全是同步处理器时同步返回，否则返回 Promise。结果取最后一个非 undefined。 */
	const fire = (name: string, ...args: unknown[]): any => {
		const results = (handlers.get(name) ?? []).map((handler) => handler(...args));
		const last = (settled: unknown[]) => settled.findLast((value) => value !== undefined);
		return results.some((value) => value instanceof Promise) ? Promise.all(results).then(last) : last(results);
	};

	return {
		pi,
		handlers,
		commands,
		tools,
		shortcuts,
		messageRenderers,
		entryRenderers,
		sent,
		userMessages,
		appended,
		emitted,
		fire,
		/** 按宿主契约跑 before_agent_start：处理器往 systemPromptOptions.sections 登记段，返回宿主渲染出的系统提示。 */
		systemPrompt: async (initial: string, ctx?: unknown): Promise<string> => {
			const sections: Record<string, string> = {};
			await fire("before_agent_start", { systemPrompt: initial, systemPromptOptions: { sections } }, ctx);
			return [initial, ...Object.values(sections)].join("\n\n");
		},
	};
}
