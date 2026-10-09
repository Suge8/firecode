/**
 * “会话进行中”的单一事实：指挥官回合在跑 || 有子代理在飞（定义见 master/outbox.ts）|| 主会话 /fire-review 进行中（review 的占用频道）。
 * 指挥官回合结束不等于歇下：回合结束后仍有子代理在飞、审查在跑，会话照旧进行中。
 * Master 是在飞子代理数的唯一发布者；轮记录器、上边框、本轮摘要与指挥官事件的耗时都经 watchBusy / busyView 读同一个事实并消费同一个歇下边沿。
 * 本段进行中的起点也只在这里记：首次变忙那一刻起，中途的人类输入与结果唤醒都不重置，歇下边沿报告整段时长（终态与均速的测量归 round.ts）。
 * 两个输入频道（在飞子代理数、审查占用）的名字与 payload 只在本文件定义，各有唯一发布者；读者一律经 watchBusy，不另订阅频道。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processShared } from "./process-shared.js";

/** 进程内事件总线：在飞子代理数变化时发布 `{ inFlight }`，激活/停用同步。 */
export const WORKERS_CHANNEL = "firecode:workers";
export interface WorkersPayload {
	inFlight: number;
	/** Master 停用遗弃在飞子代理：归零只结束本段，不是歇下。 */
	teardown?: true;
}

/**
 * 审查占用频道：review 是唯一发布者。进度变化不能靠重发 true：持有时带活的 progress 访问器，
 * 读者（输入框外壳）每次绘制调用它。progress 是进程内求值函数，频道不可序列化转发。
 */
export const OCCUPANCY_CHANNEL = "firecode:review";

/** 审查此刻在哪一步：排队等回合结束、审查者在审、顾问介入、执行模型修复、总结回合。 */
export type ReviewStage = "queued" | "reviewing" | "advisor" | "fixing" | "summarizing";

export interface ReviewProgress {
	stage: ReviewStage;
	/** 当前轮次；排队时为 0。 */
	round: number;
	/** 本轮通过 / 阻断 / 审查者总数；只有 reviewing 有意义。 */
	passed: number;
	blocked: number;
	total: number;
}

export type OccupancyPayload =
	| { active: true; progress: () => ReviewProgress | undefined }
	| { active: false };

export interface BusyView {
	agentRunning: boolean;
	inFlight: number;
	/** 主会话 /fire-review 进行中（含修复与总结回合之间的等待）时的进度访问器，否则 undefined：审查算会话进行中，审查时长计入这一段。 */
	review: (() => ReviewProgress | undefined) | undefined;
	/** 会话进行中 = 指挥官回合在跑 || 有子代理在飞 || 主会话审查进行中。 */
	busy: boolean;
	/** 本段进行中的起点（Date.now）；当且仅当 busy 时存在。 */
	since?: number;
}
export const IDLE: BusyView = { agentRunning: false, inFlight: 0, review: undefined, busy: false };

interface BusyHandlers {
	/** 任一来源变化后调用（含歇下那一次，先于 onSettled）。 */
	onChange?(view: BusyView): void;
	/** 会话歇下边沿：busy 由真变假时触发一次，带本段进行中的总时长（毫秒）。两个来源——agent_settled 时在飞数为 0，或在飞数归零时指挥官已空闲。 */
	onSettled?(elapsed: number): void;
}

/** 每个 pi 一份：订阅者与最近一次的视图（供拉取）。 */
interface Hub {
	subscribers: BusyHandlers[];
	view: BusyView;
}
const hubs = () => processShared("busy", () => new WeakMap<ExtensionAPI, Hub>());

/**
 * 会话进行中的唯一判定与歇下边沿：上边框、herdr 投影等都只订阅这里，不各自拼装。
 * 每个 pi 只有一份状态机，首个订阅者安装宿主事件，之后只追加订阅；登记跨模块拷贝共享（process-shared.ts），
 * 宿主按文件加载模块副本时同一个 pi 仍只命中一份。
 * 指挥官回合以 agent_start → agent_settled（且 ctx.isIdle()）为界。在飞数归零与回合落定先后不定
 * （闲时前门投递在宿主记录这条消息后才算送达，见 deliver.ts），歇下必须在两个来源都满足的那一刻触发。
 * 拆会话（session_shutdown）与 Master 停用遗弃子代理只结束本段，不发歇下边沿。
 */
export function watchBusy(pi: ExtensionAPI, handlers: BusyHandlers): void {
	hubOf(pi).subscribers.push(handlers);
}

/**
 * 当前会话进行中的快照（拉取，只在用到的那一刻读，不必为它订阅）。状态机在首次被引用时安装，只能看到安装之后的事件：
 * 入口最先注册轮记录器（每个会话都有），所以其余功能拉取时一个事件都没漏。
 */
export function busyView(pi: ExtensionAPI): BusyView {
	return hubOf(pi).view;
}

function hubOf(pi: ExtensionAPI): Hub {
	let hub = hubs().get(pi);
	if (!hub) {
		hub = { subscribers: [], view: IDLE };
		hubs().set(pi, hub);
		installBusy(pi, hub);
	}
	return hub;
}

function installBusy(pi: ExtensionAPI, hub: Hub): void {
	let agentRunning = false;
	let inFlight = 0;
	let review: BusyView["review"];
	/** 本段起点；有值即进行中。 */
	let since: number | undefined;
	let closed = false;
	const update = (teardown = false) => {
		if (closed) return;
		const now = Date.now();
		const busy = agentRunning || inFlight > 0 || review !== undefined;
		if (busy && since === undefined) since = now;
		const started = since;
		if (!busy) since = undefined;
		const view: BusyView = { agentRunning, inFlight, review, busy, since };
		hub.view = view;
		for (const subscriber of hub.subscribers) subscriber.onChange?.(view);
		if (busy || started === undefined || teardown) return;
		for (const subscriber of hub.subscribers) subscriber.onSettled?.(now - started);
	};
	pi.on("session_shutdown", () => {
		closed = true;
	});
	pi.on("agent_start", () => {
		agentRunning = true;
		update();
	});
	pi.on("agent_settled", (_event, context) => {
		// 宿主在 agent_settled 期间可能已有排队/延后的动作（isIdle 为 false），紧接着会再 agent_start：不算回合结束。
		agentRunning = context.isIdle() !== true;
		update();
	});
	// 主会话审查算会话进行中：审查与修复、总结回合同属这一段，审查时长计入轮记录。
	pi.events.on(OCCUPANCY_CHANNEL, (data) => {
		const occupancy = data as OccupancyPayload;
		review = occupancy.active ? occupancy.progress : undefined;
		update();
	});
	pi.events.on(WORKERS_CHANNEL, (data) => {
		const payload = data as WorkersPayload;
		inFlight = payload.inFlight;
		update(payload.teardown === true);
	});
}
