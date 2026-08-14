/**
 * 把 pi 的会话身份投影到 herdr 的两个可见位置：tab 标签（会话名）与 agent 副标题
 * （`pi·模型/思考等级` + 会话名）。单向只写、失败静默——显示信号不该影响会话。
 * herdr 之外、非 TUI 模式或 Master Worker 内自我禁用：Worker 的 pane/tab 名归 master 所有。
 */
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelName } from "../format.js";

const SOURCE = "firecode";
const REQUEST_TIMEOUT_MS = 500;

/** herdr 按 seq 丢弃过期上报，同一 pane 的元数据必须单调递增。 */
let seq = Date.now() * 1000;
const nextSeq = () => (seq += 1);

type Slots = { tab: string; agent: string };
type Reply = Record<string, unknown> | undefined;

/** 会话名进 tab、模型与思考等级进 agent 副标题：两处各说一件事，窄侧栏各自截断。 */
export function projectSlots(
	sessionName: string | undefined,
	modelId: string | undefined,
	thinking: string | undefined,
): Slots {
	const level = thinking && thinking !== "off" ? `/${thinking}` : "";
	return { tab: sessionName ?? "", agent: `pi·${formatModelName(modelId)}${level}` };
}

export function registerHerdrDisplay(pi: ExtensionAPI): void {
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) return;
	if (process.env.FIRECODE_MASTER_WORKER) return;

	const request = herdrRequest(socketPath);

	const writeSubtitle = (slots: Slots): Promise<Reply> =>
		request("pane.report_metadata", {
			pane_id: paneId,
			source: SOURCE,
			display_agent: slots.agent || null,
			clear_display_agent: !slots.agent,
			title: slots.tab || null,
			clear_title: !slots.tab,
			seq: nextSeq(),
		});

	/**
	 * tab 标签由同 tab 的所有 pane 共享，且 herdr 只有覆盖没有清除语义（写空串会留下持久空标签）。
	 * 因此只在本 pane 独占 tab 且会话有名字时写；tab 归属实时查询，env 里的 tab id 在 pane 被移动后会过期。
	 * 共享 tab 返回 false：投影并未完成，不能记为已发布，否则 tab 退回独占后再无人补写。
	 */
	const writeTabLabel = async (label: string): Promise<boolean> => {
		const tabId = field(await request("pane.get", { pane_id: paneId }), "pane", "tab_id");
		if (typeof tabId !== "string") return false;
		const paneCount = field(await request("tab.get", { tab_id: tabId }), "tab", "pane_count");
		if (paneCount !== 1) return false;
		return Boolean(await request("tab.rename", { tab_id: tabId, label }));
	};

	let chain = Promise.resolve();
	let published: string | undefined;

	const publish = (slots: Slots): Promise<void> => {
		const key = `${slots.tab}\u0000${slots.agent}`;
		if (key === published) return chain;
		chain = chain.then(async () => {
			// 只有确认送达才记为已发布：否则一次瞬时故障会让后续相同身份被永久去重掉。
			const delivered =
				Boolean(await writeSubtitle(slots)) && (!slots.tab || (await writeTabLabel(slots.tab)));
			published = delivered ? key : undefined;
		});
		return chain;
	};

	const sync = (ctx: ExtensionContext): Promise<void> =>
		ctx.mode === "tui"
			? publish(
					projectSlots(
						ctx.sessionManager.getSessionName(),
						ctx.model?.id,
						ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
					),
				)
			: Promise.resolve();

	pi.on("session_start", (_event, ctx) => sync(ctx));
	// 覆盖 /rename、快捷键与 pi 自动命名：宿主已把改名收口到这一个事件。
	pi.on("session_info_changed", (_event, ctx) => sync(ctx));
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	// 只有 quit 后 pane 才退回 shell，副标题留着旧身份比空着更误导；
	// reload/new/resume/fork 会立刻被新会话的 session_start 覆盖，清空只会闪。
	pi.on("session_shutdown", (event, ctx) =>
		event.reason === "quit" && ctx.mode === "tui"
			? publish({ tab: "", agent: "" })
			: undefined,
	);
}

function field(reply: Reply, container: string, name: string): unknown {
	const result = reply?.[container];
	return result && typeof result === "object"
		? (result as Record<string, unknown>)[name]
		: undefined;
}

/** 短连接单向请求：成功返回 result，超时/断开/herdr 报错一律返回 undefined。 */
function herdrRequest(socketPath: string) {
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

	return (method: string, params: Record<string, unknown>): Promise<Reply> =>
		new Promise((resolve) => {
			const socket = net.createConnection(endpoint);
			let buffer = "";
			const finish = (reply: Reply) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(reply);
			};
			const timer = setTimeout(() => finish(undefined), REQUEST_TIMEOUT_MS);
			timer.unref?.();
			socket.on("error", () => finish(undefined));
			socket.on("end", () => finish(undefined));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const line = buffer.slice(0, buffer.indexOf("\n"));
				if (!buffer.includes("\n")) return;
				finish(parseResult(line));
			});
			socket.on("connect", () => {
				socket.write(`${JSON.stringify({ id: SOURCE, method, params })}\n`);
			});
		});
}

function parseResult(line: string): Reply {
	try {
		const response = JSON.parse(line) as { result?: unknown; error?: unknown };
		return response.error || !response.result || typeof response.result !== "object"
			? undefined
			: (response.result as Record<string, unknown>);
	} catch {
		return undefined;
	}
}
