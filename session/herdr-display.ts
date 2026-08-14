/**
 * 把 pi 的会话身份投影到 herdr agent 副标题：`pi·模型/思考等级` + 会话名。
 * 只写带 source 的 pane 显示元数据，不碰持久 pane/tab 名；失败静默，不影响会话。
 * herdr 之外、非 TUI 模式或 Master Worker 内自我禁用。
 */
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelName } from "../format.js";

const SOURCE = "firecode";
const REQUEST_TIMEOUT_MS = 500;

/** herdr 按 seq 丢弃过期上报，同一 pane 的元数据必须单调递增。 */
let seq = Date.now() * 1000;
const nextSeq = () => (seq += 1);

type Identity = { title: string; agent: string };

export function projectIdentity(
	sessionName: string | undefined,
	modelId: string | undefined,
	thinking: string | undefined,
): Identity {
	const level = thinking && thinking !== "off" ? `/${thinking}` : "";
	return {
		title: sessionName ?? "",
		agent: `pi·${formatModelName(modelId)}${level}`,
	};
}

export function registerHerdrDisplay(pi: ExtensionAPI): void {
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) return;
	if (process.env.FIRECODE_MASTER_WORKER) return;

	const request = herdrRequest(socketPath);
	let chain = Promise.resolve();
	let published: string | undefined;

	const publish = (identity: Identity): Promise<void> => {
		const key = `${identity.title}\u0000${identity.agent}`;
		if (key === published) return chain;
		chain = chain.then(async () => {
			const delivered = await request({
				pane_id: paneId,
				source: SOURCE,
				display_agent: identity.agent || null,
				clear_display_agent: !identity.agent,
				title: identity.title || null,
				clear_title: !identity.title,
				seq: nextSeq(),
			});
			published = delivered ? key : undefined;
		});
		return chain;
	};

	const sync = (ctx: ExtensionContext): Promise<void> =>
		ctx.mode === "tui"
			? publish(
					projectIdentity(
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
	// quit 后 pane 退回 shell；其它 session 切换会立刻由新 session_start 覆盖。
	pi.on("session_shutdown", (event, ctx) =>
		event.reason === "quit" && ctx.mode === "tui"
			? publish({ title: "", agent: "" })
			: undefined,
	);
}

/** 短连接单向上报：只有 herdr 返回 result 才算送达。 */
function herdrRequest(socketPath: string) {
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	return (params: Record<string, unknown>): Promise<boolean> =>
		new Promise((resolve) => {
			const socket = net.createConnection(endpoint);
			let buffer = "";
			const finish = (delivered: boolean) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(delivered);
			};
			const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
			timer.unref?.();
			socket.on("error", () => finish(false));
			socket.on("end", () => finish(false));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end >= 0) finish(hasResult(buffer.slice(0, end)));
			});
			socket.on("connect", () => {
				socket.write(
					`${JSON.stringify({ id: SOURCE, method: "pane.report_metadata", params })}\n`,
				);
			});
		});
}

function hasResult(line: string): boolean {
	try {
		const response = JSON.parse(line) as { result?: unknown; error?: unknown };
		return !response.error && typeof response.result === "object" && response.result !== null;
	} catch {
		return false;
	}
}
