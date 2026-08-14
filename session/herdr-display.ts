/**
 * 把 pi 的会话身份投影到 herdr 的两个可见位置：tab 标签（会话名）与 agent 副标题
 * （`pi·模型/思考等级` + 会话名）。单向只写、失败静默——显示信号不该影响会话。
 * herdr 之外或 Master Worker 内自我禁用：Worker 的 pane/tab 名归 master 所有。
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
	const tabId = process.env.HERDR_TAB_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_ENV !== "1" || !paneId || !tabId || !socketPath) return;
	if (process.env.FIRECODE_MASTER_WORKER) return;

	const client = herdrClient(socketPath);
	let published: string | undefined;

	const publish = (slots: Slots): Promise<void> => {
		const key = `${slots.tab}\u0000${slots.agent}`;
		if (key === published) return Promise.resolve();
		published = key;
		return client.send([
			{
				method: "pane.report_metadata",
				params: {
					pane_id: paneId,
					source: SOURCE,
					display_agent: slots.agent || null,
					clear_display_agent: !slots.agent,
					title: slots.tab || null,
					clear_title: !slots.tab,
					seq: nextSeq(),
				},
			},
			{ method: "tab.rename", params: { tab_id: tabId, label: slots.tab } },
		]);
	};

	const sync = (ctx: ExtensionContext): Promise<void> =>
		publish(
			projectSlots(
				ctx.sessionManager.getSessionName(),
				ctx.model?.id,
				ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
			),
		);

	pi.on("session_start", (_event, ctx) => sync(ctx));
	// 覆盖 /rename、快捷键与 pi 自动命名：宿主已把改名收口到这一个事件。
	pi.on("session_info_changed", (_event, ctx) => sync(ctx));
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	// 只有 quit 后 pane 才退回 shell，留着旧身份比空着更误导；
	// reload/new/resume/fork 会立刻由新会话的 session_start 覆盖，清空只会闪。
	pi.on("session_shutdown", (event) =>
		event.reason === "quit" ? publish({ tab: "", agent: "" }) : undefined,
	);
}

/** 短连接单向请求：失败即放弃，串行保证 tab 名与副标题不被乱序覆盖。 */
function herdrClient(socketPath: string) {
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	let queue = Promise.resolve();

	const request = (method: string, params: Record<string, unknown>): Promise<void> =>
		new Promise((resolve) => {
			const socket = net.createConnection(endpoint);
			const finish = () => {
				clearTimeout(timer);
				socket.destroy();
				resolve();
			};
			const timer = setTimeout(finish, REQUEST_TIMEOUT_MS);
			timer.unref?.();
			socket.on("error", finish);
			socket.on("end", finish);
			socket.on("data", finish);
			socket.on("connect", () => {
				socket.write(`${JSON.stringify({ id: SOURCE, method, params })}\n`);
			});
		});

	return {
		send(requests: ReadonlyArray<{ method: string; params: Record<string, unknown> }>) {
			queue = queue.then(async () => {
				for (const { method, params } of requests) await request(method, params);
			});
			return queue;
		},
	};
}
