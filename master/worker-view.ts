/**
 * 子代理全过程视图：点活动列表里的一行打开全屏浮层，用主会话同一套过程组投影（折叠、摘要行、点击展开、ctrl+o）
 * 看这个子代理的完整记录。轮与耗时读 Worker 会话自己的轮记录（与主会话同一个轮记录器写下）；
 * 在这里打字补话就是 Master 的 send 动作（视图来源），working 时 steer、idle 时唤醒。
 *
 * 资源纪律：关闭时零订阅零构建。打开时一次构建（热会话读内存分支、已释放的冷子代理读一次会话文件），
 * 之后只按子会话事件增量更新；切换与关闭时退订并丢掉组件。投影的时钟、展开档位与点击覆盖按视图各自构造。
 */
import { readFileSync } from "node:fs";
import type { AgentSession, AgentSessionEvent, EntryRenderer, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { flame, onFrame, phaseOf } from "../flame.js";
import { clip, formatDuration } from "../format.js";
import { projectProcessGroups, type ProjectionEnv } from "../tools/group-view.js";
import { ChatMirror, detachedTui, HostShapeError, type MirrorEntry } from "../tools/host.js";
import { toolDefinitions } from "../tools/index.js";
import { latestTurnRecord, renderRound, ROUND_ENTRY, type TurnRecord } from "../tools/round.js";
import { TurnClock } from "../tools/turn-clock.js";
import { ACTION_HANDLERS } from "./actions.js";
import { launchOrder } from "./activity-list.js";
import { modelAtomText } from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import type { WorkerRef } from "./state.js";

const STATUS_TEXT: Record<WorkerRef["status"], string> = { working: "运行中", idle: "空闲", reviewing: "审查中" };
/** 顶行、输入行、底行之外是正文（排队中的补话在输入行之上占行）。 */
const CHROME_ROWS = 3;
const REPLY_LINES = 3;
const HINT = "Tab 换子代理 · 点摘要展开 · ctrl+o 全部展开 · esc 返回";

/** 视图要的全部外部事实与动作：由 Master 运行时提供，测试替身同形。 */
export interface WorkerViewSource {
	/** 视图内的子代理顺序：启动序（不随状态分组变化）。 */
	names(): string[];
	worker(name: string): WorkerRef | undefined;
	/** 进程内热会话；已释放返回 undefined，记录改从会话文件读。 */
	session(worker: WorkerRef): AgentSession | undefined;
	/** 子代理会话接上订阅（冷启动、重开）时通知，在它的第一条事件之前。 */
	onSession(listener: (name: string) => void): () => void;
	/** 本次运行的起点（运行中才有），顶行实时耗时用。 */
	runStartedAt(name: string): number | undefined;
	/** 视图来源的 send：与指挥官 send 同一处理入口。 */
	send(name: string, prompt: string): Promise<void>;
}

/** 打开浮层；同一时刻只有一个。返回的 Promise 在浮层关闭时结束。 */
export async function openWorkerView(active: MasterRuntime, name: string): Promise<void> {
	if (viewOpen) return;
	viewOpen = true;
	try {
		await active.ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => new WorkerView(runtimeSource(active), name, tui, theme, keybindings, done),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
		);
	} finally {
		viewOpen = false;
	}
}
let viewOpen = false;

function runtimeSource(active: MasterRuntime): WorkerViewSource {
	return {
		names: () => launchOrder(active.activityFacts()),
		worker: (name) => active.store.state.workers.find((worker) => worker.name === name),
		session: (worker) => active.setup.pool.getSession(worker.sessionPath),
		onSession: (listener) => active.onWorkerSession(listener),
		runStartedAt: (name) => active.live.get(name)?.runStartedAt,
		send: async (name, prompt) => {
			await ACTION_HANDLERS.send(active, { worker: name, prompt, origin: "view" }, active.ctx);
		},
	};
}

/**
 * 一个子代理记录：宿主组件镜像（轮记录随分支进来，投影按它分轮）、这个子代理自己的轮次时钟、
 * 最近一轮的落定事实（顶行用），以及热会话时的事件订阅。
 */
class WorkerRecord {
	readonly mirror: ChatMirror;
	readonly clock = new TurnClock();
	latest: TurnRecord | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(worker: WorkerRef, readonly session: AgentSession | undefined, tui: TUI, theme: Theme, private readonly changed: () => void) {
		const definitions: Record<string, ReturnType<typeof toolDefinitions>[keyof ReturnType<typeof toolDefinitions>]> = toolDefinitions();
		this.mirror = new ChatMirror({
			ui: detachedTui(tui, changed),
			cwd: worker.cwd ?? process.cwd(),
			theme,
			toolDefinition: (tool) => definitions[tool],
			messageRenderer: (type) => session?.extensionRunner.getMessageRenderer(type),
			entryRenderer: (type) => (type === ROUND_ENTRY ? renderRound as EntryRenderer : undefined),
		});
		const branch = session ? session.sessionManager.getBranch() as MirrorEntry[] : fileBranch(worker.sessionPath);
		for (const entry of branch) this.mirror.replay(entry);
		this.latest = latestTurnRecord(branch as Parameters<typeof latestTurnRecord>[0]);
		this.sync(session?.isStreaming === true);
		if (session) this.unsubscribe = session.subscribe((event) => this.onEvent(event));
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.sync(true);
		if (event.type === "agent_end") this.sync(false);
		const touched = this.mirror.handle(event);
		if (event.type === "entry_appended" && event.entry.type === "custom" && event.entry.customType === ROUND_ENTRY && this.session)
			this.latest = latestTurnRecord(this.session.sessionManager.getBranch() as Parameters<typeof latestTurnRecord>[0]);
		if (touched || event.type === "agent_start" || event.type === "agent_end" || event.type === "queue_update") this.changed();
	}

	private sync(running: boolean): void {
		this.clock.sync({ agentRunning: running, inFlight: 0, busy: running, review: false, ...(running ? { since: Date.now() } : {}) });
	}
}

/** 已释放的冷子代理：读一次会话文件，从最后一条沿 parentId 回到根，得到当前分支。 */
function fileBranch(path: string): MirrorEntry[] {
	type Line = MirrorEntry & { id?: string; parentId?: string | null };
	const entries = new Map<string, Line>();
	let leaf: Line | undefined;
	for (const text of readFileSync(path, "utf8").split("\n")) {
		if (!text.trim()) continue;
		try {
			const entry = JSON.parse(text) as Line;
			if (!entry.id) continue;
			entries.set(entry.id, entry);
			leaf = entry;
		} catch {
			// 正在追加的尾行可能不完整。
		}
	}
	const branch: Line[] = [];
	for (let entry = leaf; entry; entry = entry.parentId ? entries.get(entry.parentId) : undefined) branch.unshift(entry);
	return branch;
}

export class WorkerView implements Component, Focusable {
	private readonly input = new Input({ prompt: "› ", placeholder: "补话给这个子代理，回车发送" });
	private readonly projection = new Container();
	private readonly overrides = new Set<object>();
	private readonly headless = {};
	private readonly stopSessionWatch: () => void;
	private record: WorkerRecord | undefined;
	private failure: string | undefined;
	private notice = "";
	private expanded = false;
	/** 正文的第一行；undefined 表示跟随末尾。 */
	private scrollTop: number | undefined;
	private bodyRows = 0;
	private bodyLines = 0;
	private stopFrames: (() => void) | undefined;
	private sending = false;

	constructor(
		private readonly source: WorkerViewSource,
		private name: string,
		private readonly tui: Pick<TUI, "requestRender"> & { terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly keys: Pick<KeybindingsManager, "matches">,
		private readonly done: () => void,
	) {
		this.input.onSubmit = (text) => void this.send(text);
		// 冷子代理被唤醒、或释放后重开：会话在第一条事件之前接上订阅，记录从新会话重建一次。
		this.stopSessionWatch = source.onSession((worker) => {
			const current = this.worker();
			if (worker !== this.name || !current || source.session(current) === this.record?.session) return;
			this.load();
			this.tui.requestRender();
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
		return this.source.worker(this.name);
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
			this.record = new WorkerRecord(worker, this.source.session(worker), this.tui as TUI, this.theme, () => this.tui.requestRender());
		} catch (error) {
			this.failure = error instanceof HostShapeError ? error.message : `读不到 ${worker.name} 的记录：${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private env(record: WorkerRecord): ProjectionEnv {
		return {
			ui: { theme: this.theme, getToolsExpanded: () => this.expanded },
			clock: record.clock, replyLines: REPLY_LINES, headless: this.headless,
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
		const queued = this.queued(width);
		this.bodyRows = Math.max(1, this.tui.terminal.rows - CHROME_ROWS - queued.length);
		const body = this.body(width);
		this.bodyLines = body.length;
		const maxTop = Math.max(0, body.length - this.bodyRows);
		const top = Math.min(this.scrollTop ?? maxTop, maxTop);
		const shown = body.slice(top, top + this.bodyRows);
		while (shown.length < this.bodyRows) shown.push("");
		return [this.header(width), ...shown, ...queued, this.input.render(width)[0] ?? "", this.footer(width)];
	}

	private body(width: number): string[] {
		const record = this.record;
		if (!record) return [this.theme.fg("warning", ` ${this.failure ?? ""}`)];
		const { nodes, animating } = projectProcessGroups(record.mirror.chat.children, this.env(record));
		this.projection.children = nodes;
		const working = this.worker()?.status === "working";
		// 动效与顶行耗时只在有东西在动时订阅全局时钟，静止即取消。
		if ((animating || working) && !this.stopFrames) this.stopFrames = onFrame(() => this.tui.requestRender());
		else if (!animating && !working && this.stopFrames) {
			this.stopFrames();
			this.stopFrames = undefined;
		}
		return this.projection.render(width);
	}

	/** 已发出、还没在句缝送达的补话：读 Worker 会话的排队事实，送达后自然消失。 */
	private queued(width: number): string[] {
		const steering = this.record?.session?.getSteeringMessages() ?? [];
		return steering.map((text) => clip(this.theme.fg("dim", ` 排队中：${text}`), width));
	}

	private header(width: number): string {
		const worker = this.worker();
		if (!worker) return clip(` ${this.name}`, width);
		const started = this.source.runStartedAt(worker.name);
		const elapsed = worker.status === "working"
			? started === undefined ? undefined : Date.now() - started
			: this.record?.latest?.round.elapsed;
		const mark = worker.status === "working" ? `${flame(1, phaseOf(0))} ` : "";
		const parts = [
			this.theme.bold(worker.name),
			this.theme.fg("muted", worker.role),
			this.theme.fg("dim", modelAtomText(worker)),
			`${mark}${STATUS_TEXT[worker.status]}${elapsed === undefined ? "" : this.theme.fg("muted", ` ${formatDuration(Math.max(0, elapsed))}`)}`,
		];
		return clip(` ${parts.join(this.theme.fg("dim", " · "))}`, width);
	}

	private footer(width: number): string {
		const names = this.source.names();
		return clip(this.theme.fg("dim", ` ${this.notice || HINT} · ${names.indexOf(this.name) + 1}/${names.length}`), width);
	}

	/**
	 * 浮层抢走焦点后宿主编辑器上的全局键不再生效，在这里给出同义行为：esc 返回；ctrl+c 先清输入、再按关闭视图；
	 * 空输入的 ctrl+d 关闭视图（不在浮层里退出整个 pi）；ctrl+o 是这个视图的全部展开。
	 */
	handleInput(data: string): void {
		const empty = !this.input.getValue();
		if (this.keys.matches(data, "app.interrupt")) return this.done();
		if (this.keys.matches(data, "app.clear")) return empty ? this.done() : this.clearInput();
		if (this.keys.matches(data, "app.exit") && empty) return this.done();
		if (this.keys.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			this.overrides.clear();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab")) return this.step(1);
		if (matchesKey(data, "shift+tab")) return this.step(-1);
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private clearInput(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	private step(direction: number): void {
		const names = this.source.names();
		if (names.length < 2) return;
		const index = names.indexOf(this.name);
		this.name = names[(index + direction + names.length) % names.length];
		this.notice = "";
		this.load();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		const maxTop = Math.max(0, this.bodyLines - this.bodyRows);
		if (event.type === "wheel") {
			const next = Math.max(0, Math.min(maxTop, (this.scrollTop ?? maxTop) + (event.wheelDelta ?? 0)));
			this.scrollTop = next >= maxTop ? undefined : next;
			this.tui.requestRender();
			return { handled: true };
		}
		const row = event.y - 1;
		if (row < 0 || row >= this.bodyRows) return undefined;
		const top = Math.min(this.scrollTop ?? maxTop, maxTop);
		// 点开或收起时被点的那一行留在原位：先把视口钉在当前位置，再交给投影。
		this.scrollTop = top;
		const result = this.projection.handleMouse({ ...event, y: top + row, height: this.bodyLines });
		this.tui.requestRender();
		return result ?? { handled: true };
	}

	private async send(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || this.sending) return;
		this.sending = true;
		this.notice = "发送中…";
		this.tui.requestRender();
		try {
			await this.source.send(this.name, prompt);
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
