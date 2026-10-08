/**
 * 会话在 herdr 里的投影，也是这个 pane 唯一的 agent 状态上报者（herdr 官方 Pi 集成必须卸载：
 * 每个 pane 只有一个 hook authority，官方 source 在位时 firecode 的上报被静默丢弃）。
 *
 * 投影三件事：身份（agent 副标题 + `$session` token）、生命周期状态、恢复命令；退出时 release。
 * 状态只有 working / idle，唯一来源是 busy.ts 的“会话进行中”：指挥官回合在跑、子代理在飞、审查进行中都算 working，
 * 所以主回合歇下后侧边栏不会提前变 idle。审查不报 blocked：blocked 在 herdr 里意为“等用户决定”，会触发需要关注的
 * 通知，而审查期间不需要用户做任何事（只有 esc 取消）；审查与子代理靠 working 的状态标签区分。
 * 恢复命令（`pi --session <会话文件>`）随状态上报：自定义 source 拿不到官方会话恢复，herdr 重启后靠它把会话接回原 pane。
 *
 * 只保留最新意图：事件只改 desired，发送循环每次拿当前 desired 与已送达的对比，只送差异；失败重试一次，其后由下一事件补发。
 * herdr 之外、非 TUI 模式或 Master Worker 内自我禁用。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BusyView, watchBusy } from "../busy.js";
import { formatModelName } from "../format.js";
import { herdrPaneEnv, herdrRequest } from "../herdr-client.js";
import { msg } from "./messages.js";

const SOURCE = "firecode";
const AGENT = "pi";
const RETRY_TIMEOUT_MS = 1_500;
/** herdr 拒收含撇号或控制字符的恢复命令参数。 */
const UNSAFE_ARGUMENT = /['\u0000-\u001f\u007f]/;

/**
 * herdr 按 seq 丢弃过期上报，水位按 pane + source 记、进程退出也不清：同一 pane 里先后跑过的 firecode
 * （如嵌套启动的 pi）共用这一个水位。seq 取每次上报时的微秒级墙钟并保证本进程内单调，后启动进程留下的
 * 高水位因此只压住它启动前的那一刻，不会永久吞掉本进程之后的上报。身份与状态共用一个计数。
 */
let seq = 0;
const nextSeq = () => (seq = Math.max(seq + 1, Date.now() * 1000));

interface Projection {
	title: string;
	agent: string;
	working: boolean;
	/** working 状态下的侧边栏标签；无则不显示。 */
	label?: string;
	resume?: string[];
	released: boolean;
}

interface Sent {
	agent?: string;
	meta?: string;
	released?: boolean;
}

const agentKey = (p: Projection) => `${p.working}\u0000${p.resume?.join("\u0000") ?? ""}`;
const metaKey = (p: Projection) => `${p.title}\u0000${p.agent}\u0000${p.label ?? ""}`;

function identityOf(ctx: ExtensionContext, pi: ExtensionAPI) {
	const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
	const level = thinking && thinking !== "off" ? `/${thinking}` : "";
	return { title: ctx.sessionManager.getSessionName() ?? "", agent: `pi·${formatModelName(ctx.model?.id)}${level}` };
}

function resumeOf(ctx: ExtensionContext): string[] | undefined {
	const file = ctx.sessionManager.getSessionFile();
	return file && !UNSAFE_ARGUMENT.test(file) ? [AGENT, "--session", file] : undefined;
}

function labelOf(view: BusyView): string | undefined {
	if (view.review) return msg.herdr.review;
	return !view.agentRunning && view.inFlight > 0 ? msg.herdr.workers : undefined;
}

/** 返回 settled：等当前发送循环排空，只供测试。 */
export function registerHerdrProjection(pi: ExtensionAPI): () => Promise<void> {
	const env = herdrPaneEnv();
	if (!env) return () => Promise.resolve();
	const paneId = env.paneId;

	let enabled = false;
	let desired: Projection = { title: "", agent: "", working: false, released: false };
	let sent: Sent = {};
	let running: Promise<void> | undefined;
	/** 重载时回合已在跑：busy.ts 没见过 agent_start，到下一次 agent_settled 为止算 working。 */
	let carriedRun = false;
	let view: BusyView | undefined;

	const request = (method: string, params: Record<string, unknown>) => {
		const send = (timeout?: number) => herdrRequest(SOURCE, method, { pane_id: paneId, source: SOURCE, ...params, seq: nextSeq() }, timeout);
		return send().then((delivered) => delivered || send(RETRY_TIMEOUT_MS));
	};

	const metadata = (p: Projection) =>
		request("pane.report_metadata", {
			display_agent: p.agent || null,
			clear_display_agent: !p.agent,
			title: p.title || null,
			clear_title: !p.title,
			// 侧边栏行布局只能消费自定义 token（title 不在 token 集里）；null 即清除。
			tokens: { session: p.title || null },
			state_labels: p.label ? { working: p.label } : {},
			clear_state_labels: !p.label,
		});

	/** 下一个要送的请求；全部送达时为 undefined。release 之前先清身份。 */
	function nextStep(p: Projection): (() => Promise<boolean>) | undefined {
		const meta = () => metadata(p).then((ok) => ok && ((sent = { ...sent, meta: metaKey(p) }), true));
		if (p.released) {
			if (sent.meta !== metaKey(p)) return meta;
			if (sent.released) return undefined;
			return () => request("pane.release_agent", { agent: AGENT }).then((ok) => ok && ((sent = { ...sent, released: true }), true));
		}
		if (sent.agent !== agentKey(p))
			return () =>
				request("pane.report_agent", { agent: AGENT, state: p.working ? "working" : "idle", ...(p.resume ? { resume_argv: p.resume } : {}) })
					.then((ok) => ok && ((sent = { ...sent, agent: agentKey(p) }), true));
		return sent.meta !== metaKey(p) ? meta : undefined;
	}

	/** 返回是否排空；送不出去就停，等下一个事件再来。 */
	async function drain(): Promise<boolean> {
		while (enabled) {
			const step = nextStep(desired);
			if (!step) return true;
			if (!(await step())) return false;
		}
		return true;
	}

	const kick = () => {
		running ??= drain()
			.catch(() => false)
			.then((drained) => {
				running = undefined;
				if (drained && enabled && nextStep(desired)) void kick();
			});
		return running;
	};
	const update = (patch: Partial<Projection>) => {
		desired = { ...desired, ...patch };
		if (enabled) void kick();
	};
	const project = () => update({ working: Boolean(view?.busy) || carriedRun, label: view ? labelOf(view) : undefined });

	watchBusy(pi, {
		onChange: (next) => {
			view = next;
			project();
		},
	});
	pi.on("agent_settled", () => {
		carriedRun = false;
		project();
	});

	const syncIdentity = (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") update(identityOf(ctx, pi));
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		carriedRun = !ctx.isIdle();
		enabled = true;
		desired = { ...desired, ...identityOf(ctx, pi), resume: resumeOf(ctx) };
		project();
	});
	// 覆盖 /rename、快捷键与 pi 自动命名：宿主已把改名收口到这一个事件。
	pi.on("session_info_changed", (_event, ctx) => syncIdentity(ctx));
	pi.on("model_select", (_event, ctx) => syncIdentity(ctx));
	pi.on("thinking_level_select", (_event, ctx) => syncIdentity(ctx));
	// quit 后 pane 退回 shell；其它 session 切换会立刻由新 session_start 接管，已入队的旧意图不再发送。
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "quit") {
			enabled = false;
			return;
		}
		if (!enabled) return;
		update({ title: "", agent: "", label: undefined, released: true });
		return settled();
	});

	const settled = async () => {
		while (running) await running;
	};
	return settled;
}
