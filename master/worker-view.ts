/**
 * 子代理全过程视图（原型，proto/worker-view）：点活动列表里的一行打开全屏浮层，用主会话同一套过程组投影
 * （折叠、摘要行、点击展开、ctrl+o）看这个子代理的完整记录；每次 start/send 的派单是一轮的“人类消息”。
 * 在这里打字补话走与指挥官 send 完全相同的那条动作路径（working 时 steer、idle 时唤醒），不另起状态。
 *
 * 资源纪律：关闭时零订阅零构建；打开时一次构建（热会话读内存分支、已释放的冷子代理读一次会话文件），
 * 之后只按子会话事件增量更新镜像；切换与关闭时退订并丢掉组件。投影与时钟按视图各自构造，不碰主会话那份。
 */
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { onFrame, flame, phaseOf } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { projectProcessGroups, type ProjectionEnv } from "../tools/group-view.js";
import { ChatMirror, detachedTui, HostShapeError } from "../tools/host.js";
import { toolDefinitions } from "../tools/index.js";
import { roundMarker, type Round } from "../tools/round.js";
import { TurnClock } from "../tools/turn-clock.js";
import { ACTION_HANDLERS } from "./actions.js";
import { displayOrder } from "./activity-list.js";
import { modelAtomText } from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import type { WorkerRef } from "./state.js";

const STATUS_TEXT: Record<WorkerRef["status"], string> = { working: "运行中", idle: "空闲", reviewing: "审查中" };
/** 顶行、输入行、底行之外都是正文。 */
const CHROME_ROWS = 3;

/** 打开浮层；同一时刻只有一个。返回的 Promise 在浮层关闭时结束。 */
export async function openWorkerView(active: MasterRuntime, name: string): Promise<void> {
	if (viewOpen) return;
	viewOpen = true;
	try {
		await active.ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => new WorkerView(active, name, tui, theme, keybindings, done),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
		);
	} finally {
		viewOpen = false;
	}
}
let viewOpen = false;

/**
 * 一个子代理记录的数据源：宿主组件镜像、这个子代理自己的轮次时钟与（热会话时）事件订阅。
 * 子代理会话不写轮记录，轮界按运行边界合成：一次运行（start/send 的派单到回合落定）结束时放一个轮记录标记，
 * 其后的派单开新一轮；运行中的 steer 补话落在两次落定之间，按投影规则折进当前轮。
 */
class WorkerRecord {
	readonly mirror: ChatMirror;
	readonly clock = new TurnClock();
	/** 接上的热会话；冷记录为空，会话被重新打开时视图重建。 */
	readonly session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private runStart: number | undefined;
	private lastAt: number | undefined;
	private lastStop: string | undefined;

	constructor(worker: WorkerRef, session: AgentSession | undefined, tui: TUI, private readonly changed: () => void) {
		this.session = session;
		const definitions = toolDefinitions() as Record<string, ReturnType<typeof toolDefinitions>[keyof ReturnType<typeof toolDefinitions>] | undefined>;
		this.mirror = new ChatMirror({
			ui: detachedTui(tui, changed),
			cwd: worker.cwd ?? process.cwd(),
			toolDefinition: (tool) => definitions[tool],
			messageRenderer: (type) => session?.extensionRunner.getMessageRenderer(type),
		});
		const messages = session ? branchMessages(session.sessionManager.getBranch()) : fileMessages(worker.sessionPath);
		for (const message of messages) this.replay(message);
		// 上一次运行已落定（最后一条助手消息不是工具调用）就收尾；正在开跑的新一轮从它的派单起算。
		if (this.lastStop !== undefined && this.lastStop !== "toolUse") this.closeRun();
		const streaming = session?.isStreaming === true;
		this.sync(streaming);
		if (session) this.unsubscribe = session.subscribe((event) => this.onEvent(event));
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private replay(message: AgentMessage): void {
		this.note(message, message.timestamp);
		this.mirror.replay(message);
	}

	/**
	 * 运行边界：落定后的下一条派单开新一轮（先给上一次运行放轮记录标记）；运行中的派单（steer）只是补话。
	 * 只看对话消息：会话里的 system 记录（恢复会话时追加）不算运行的一部分。
	 */
	private note(message: AgentMessage, at: number): void {
		if (message.role === "user") {
			if (this.lastStop !== undefined && this.lastStop !== "toolUse") this.closeRun();
			this.runStart ??= at;
		}
		if (message.role === "assistant") this.lastStop = message.stopReason;
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") this.lastAt = at;
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.sync(true);
		if (event.type === "message_start" || event.type === "message_end") this.note(event.message, Date.now());
		const touched = this.mirror.handle(event);
		if (event.type === "agent_end") {
			this.closeRun();
			this.sync(false);
		}
		if (touched || event.type === "agent_start" || event.type === "agent_end") this.changed();
	}

	private closeRun(): void {
		if (this.runStart === undefined || this.lastAt === undefined) return;
		const outcome: Round["outcome"] = this.lastStop === "aborted" ? "aborted" : this.lastStop === "error" ? "error" : "complete";
		this.mirror.addEntry(roundMarker({ elapsed: this.lastAt - this.runStart, outcome, at: this.lastAt }));
		this.runStart = undefined;
		this.lastStop = undefined;
	}

	private sync(running: boolean): void {
		this.clock.sync({ agentRunning: running, inFlight: 0, busy: running, review: false, ...(running ? { since: this.runStart ?? Date.now() } : {}) });
	}
}

/** 会话分支条目里给人看的消息：消息条目与显示的自定义消息。 */
type BranchEntry = { type: string; message?: AgentMessage; customType?: string; content?: unknown; display?: boolean; details?: unknown; timestamp?: string; id?: string; parentId?: string | null };

function branchMessages(entries: readonly BranchEntry[]): AgentMessage[] {
	return entries.flatMap((entry): AgentMessage[] => {
		if (entry.type === "message" && entry.message) return [entry.message];
		if (entry.type === "custom_message" && entry.display)
			return [{ role: "custom", customType: entry.customType, content: entry.content, display: true, details: entry.details, timestamp: Date.parse(entry.timestamp ?? "") } as AgentMessage];
		return [];
	});
}

/** 已释放的冷子代理：读一次会话文件，从最后一条沿 parentId 回到根，得到当前分支。 */
function fileMessages(path: string): AgentMessage[] {
	const entries = new Map<string, BranchEntry>();
	let leaf: BranchEntry | undefined;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as BranchEntry;
			if (!entry.id) continue;
			entries.set(entry.id, entry);
			leaf = entry;
		} catch {
			// 正在追加的尾行可能不完整。
		}
	}
	const branch: BranchEntry[] = [];
	for (let entry = leaf; entry; entry = entry.parentId ? entries.get(entry.parentId) : undefined) branch.unshift(entry);
	return branchMessages(branch);
}

class WorkerView implements Component, Focusable {
	private readonly input = new Input({ prompt: "› ", placeholder: "补话给这个子代理，回车发送" });
	private readonly projection = new Container();
	private readonly overrides = new Set<object>();
	private readonly headless = {};
	private name: string;
	private record: WorkerRecord | undefined;
	private failure: string | undefined;
	private notice = "";
	private expanded = false;
	/** 正文的第一行；undefined 表示跟随末尾。 */
	private scrollTop: number | undefined;
	private bodyRows = 0;
	private bodyLines = 0;
	private stopFrames: (() => void) | undefined;
	private readonly stopSessionWatch: () => void;
	private sending = false;

	constructor(
		private readonly active: MasterRuntime,
		name: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly done: () => void,
	) {
		this.name = name;
		this.input.onSubmit = (text) => void this.send(text);
		// 冷子代理被唤醒、或释放后重开：会话在第一条事件之前接上订阅，记录从新会话重建一次。
		this.stopSessionWatch = active.onWorkerSession((worker) => {
			if (worker !== this.name) return;
			const session = this.active.setup.pool.getSession(this.worker()?.sessionPath ?? "");
			if (session && session !== this.record?.session) {
				this.load();
				this.tui.requestRender();
			}
		});
		this.load();
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	invalidate(): void {}

	dispose(): void {
		this.stopSessionWatch();
		this.record?.dispose();
		this.record = undefined;
		this.stopFrames?.();
		this.stopFrames = undefined;
		this.projection.children = [];
	}

	private worker(): WorkerRef | undefined {
		return this.active.store.state.workers.find((worker) => worker.name === this.name);
	}

	/** 打开或切换时的一次构建；之后由事件增量。 */
	private load(): void {
		this.record?.dispose();
		this.record = undefined;
		this.failure = undefined;
		this.overrides.clear();
		this.scrollTop = undefined;
		const worker = this.worker();
		if (!worker) {
			this.failure = `${this.name} 已不在池里`;
			return;
		}
		try {
			this.record = new WorkerRecord(worker, this.active.setup.pool.getSession(worker.sessionPath), this.tui, () => this.tui.requestRender());
		} catch (error) {
			this.failure = error instanceof HostShapeError ? error.message : `读不到 ${worker.name} 的记录：${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private env(record: WorkerRecord): ProjectionEnv {
		const ui: Pick<ExtensionUIContext, "theme" | "getToolsExpanded"> = { theme: this.theme, getToolsExpanded: () => this.expanded };
		return {
			ui, clock: record.clock, replyLines: 3, headless: this.headless,
			toggleRow: (row) => {
				row.setExpanded(!(row as unknown as { expanded: boolean }).expanded);
				this.tui.requestRender();
			},
			isOpen: (key) => this.overrides.has(key),
			toggleOpen: (key) => {
				if (!this.overrides.delete(key)) this.overrides.add(key);
				this.tui.requestRender();
			},
		};
	}

	render(width: number): string[] {
		const rows = Math.max(CHROME_ROWS + 1, this.tui.terminal.rows);
		this.bodyRows = rows - CHROME_ROWS;
		const body = this.body(width);
		this.bodyLines = body.length;
		const maxTop = Math.max(0, body.length - this.bodyRows);
		const top = Math.min(this.scrollTop ?? maxTop, maxTop);
		const shown = body.slice(top, top + this.bodyRows);
		while (shown.length < this.bodyRows) shown.push("");
		return [this.header(width), ...shown, this.input.render(width)[0] ?? "", this.footer(width)];
	}

	private body(width: number): string[] {
		const record = this.record;
		if (!record) return [this.theme.fg("warning", ` ${this.failure ?? ""}`)];
		const { nodes, animating } = projectProcessGroups(record.mirror.chat.children, this.env(record));
		this.projection.children = nodes;
		const working = this.worker()?.status === "working";
		// 动效与顶行耗时只在有东西在动时订阅全局时钟，静止即取消。
		if ((animating || working) && !this.stopFrames) this.stopFrames = onFrame(() => this.tui.requestRender());
		else if (!animating && !working && this.stopFrames) { this.stopFrames(); this.stopFrames = undefined; }
		return this.projection.render(width);
	}

	private header(width: number): string {
		const worker = this.worker();
		if (!worker) return clip(` ${this.name}`, width);
		const live = this.active.live.get(worker.name);
		const now = Date.now();
		const end = worker.status === "idle" ? live?.idleAt : now;
		const elapsed = live?.runStartedAt !== undefined && end !== undefined ? ` ${formatDuration(Math.max(0, end - live.runStartedAt))}` : "";
		const mark = worker.status === "working" ? `${flame(1, phaseOf(0))} ` : "";
		const parts = [
			this.theme.bold(worker.name),
			this.theme.fg("muted", worker.role),
			this.theme.fg("dim", modelAtomText(worker)),
			`${mark}${STATUS_TEXT[worker.status]}${this.theme.fg("muted", elapsed)}`,
		];
		return clip(` ${parts.join(this.theme.fg("dim", " · "))}`, width);
	}

	private footer(width: number): string {
		const names = this.names();
		const position = `${names.indexOf(this.name) + 1}/${names.length}`;
		const hint = this.notice || "←/→ 换子代理 · 点摘要展开 · ctrl+o 全部展开 · esc 返回";
		return clip(this.theme.fg("dim", ` ${hint} · ${position}`), width);
	}

	/** 与活动列表同一顺序（需要处理的在前，然后在跑、已完成、空闲）。 */
	private names(): string[] {
		return displayOrder(this.active.activityFacts(), this.theme);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.done();
		if (this.keys.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			this.overrides.clear();
			this.tui.requestRender();
			return;
		}
		const empty = !this.input.getValue();
		if (empty && (matchesKey(data, "left") || matchesKey(data, "right"))) return this.step(matchesKey(data, "left") ? -1 : 1);
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private step(direction: number): void {
		const names = this.names();
		if (names.length < 2) return;
		const index = names.indexOf(this.name);
		this.name = names[(index + direction + names.length) % names.length];
		this.notice = "";
		this.load();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") {
			const maxTop = Math.max(0, this.bodyLines - this.bodyRows);
			const next = Math.max(0, Math.min(maxTop, (this.scrollTop ?? maxTop) + (event.wheelDelta ?? 0)));
			this.scrollTop = next >= maxTop ? undefined : next;
			this.tui.requestRender();
			return { handled: true };
		}
		const row = event.y - 1;
		if (row < 0 || row >= this.bodyRows) return undefined;
		const maxTop = Math.max(0, this.bodyLines - this.bodyRows);
		const top = Math.min(this.scrollTop ?? maxTop, maxTop);
		// 点开或收起时被点的那一行留在原位：先把视口钉在当前位置，再交给投影。
		this.scrollTop = top;
		const result = this.projection.handleMouse({ ...event, y: top + row, height: this.bodyLines });
		this.tui.requestRender();
		return result ?? { handled: true };
	}

	/** 与指挥官 send 同一条动作路径：working 时 steer、idle 时唤醒；不通知指挥官。 */
	private async send(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || this.sending) return;
		this.sending = true;
		this.notice = "发送中…";
		this.tui.requestRender();
		try {
			await ACTION_HANDLERS.send(this.active, { worker: this.name, prompt }, this.active.ctx);
			this.input.setValue("");
			this.notice = "已送达";
		} catch (error) {
			this.notice = `未送达：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.sending = false;
			this.tui.requestRender();
		}
	}
}
