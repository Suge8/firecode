/**
 * 子代理全过程视图：点活动列表里的一行打开全屏浮层，用主会话同一套过程组投影（折叠、摘要行、点击展开、ctrl+o）
 * 看这个子代理的完整记录。轮与耗时读 Worker 会话自己的轮记录（与主会话同一个轮记录器写下）；输入区上横线的状态与耗时读活动列表
 * 同一份行状态；在这里打字补话就是 Master 的 send 动作（视图来源），working 时 steer、idle 时唤醒。
 *
 * 资源纪律：关闭时零订阅零构建。打开时一次构建（热会话读内存分支、已释放的冷子代理读一次会话文件），之后只按子会话
 * 事件增量更新；打开期间看过的子代理各留一份记录与展开状态（切回原样），关闭时全部退订丢弃。草稿按子代理留在
 * 运行时内存里，到会话结束。
 */
import { readFileSync } from "node:fs";
import type { AgentSession, AgentSessionEvent, EntryRenderer, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { onFrame } from "../flame.js";
import { clip } from "../format.js";
import { ClickAnchor, type Scroller } from "../tools/click-anchor.js";
import { projectProcessGroups, type ProjectionEnv } from "../tools/group-view.js";
import { ChatMirror, detachedTui, HostShapeError, type MirrorEntry } from "../tools/host.js";
import { toolDefinitions } from "../tools/index.js";
import { roundFromEntry, roundMarker, ROUND_ENTRY } from "../tools/round.js";
import { TurnClock } from "../tools/turn-clock.js";
import { type BorderParts, fitBorder, SEPARATOR } from "../statusbar/render.js";
import { ACTION_HANDLERS } from "./actions.js";
import { ANIMATING_KINDS, launchOrder, rowState, type ActivityFacts, type RowKind } from "./activity-list.js";
import { msg } from "./messages.js";
import { modelAtomText } from "./run.js";
import type { MasterRuntime } from "./runtime.js";
import type { WorkerRef } from "./state.js";

/** 上横线状态词；卡住行用活动列表给的“N 分钟无输出”提醒代替。 */
const STATUS_WORD: Record<Exclude<RowKind, "stuck">, string> = msg.view.status;
/** 输入区的上横线、输入行、下横线之外是正文（排队中的补话在上横线之上占行）。 */
const CHROME_ROWS = 3;
/** 名字被迫截短时至少留的宽度；再窄就不写名字。 */
const MIN_NAME = 6;
/** 下横线右侧：按显示顺序；宽度不够时 drop 小的先让，“esc 返回”永远保留。text 缺省的一项是模型原子的位置。 */
const TAIL: { text?: string; drop: number }[] = [
	{ drop: 2 },
	{ text: msg.view.hints.tab, drop: 3 },
	{ text: msg.view.hints.expand, drop: 0 },
	{ text: msg.view.hints.expandAll, drop: 1 },
	{ text: msg.view.hints.back, drop: Infinity },
];
/** “已发出”替换按键提示的时长；任何按键也会提前收起。 */
const NOTICE_MS = 3_000;

/** 视图要的全部外部事实与动作：由 Master 运行时提供，测试替身同形。 */
interface WorkerViewSource {
	/** 活动列表的同一份事实：启动序名单与上横线的行状态都从它来。 */
	facts(): ActivityFacts;
	worker(name: string): WorkerRef | undefined;
	/** 进程内热会话；已释放返回 undefined，记录改从会话文件读。 */
	session(worker: WorkerRef): AgentSession | undefined;
	/** 子代理会话接上订阅（冷启动、重开）时通知，在它的第一条事件之前。 */
	onSession(listener: (name: string) => void): () => void;
	/** 子代理被移除（kill、启动失败撤票）时按名字通知。 */
	onWorkerRemoved(listener: (name: string) => void): () => void;
	/** 视图来源的 send：与指挥官 send 同一处理入口。 */
	send(name: string, prompt: string): Promise<void>;
	/** 名字 → 没发出的草稿；随运行时活到会话结束，不持久化。 */
	drafts: Map<string, string>;
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
const runtimeDrafts = new WeakMap<MasterRuntime, Map<string, string>>();

function runtimeSource(active: MasterRuntime): WorkerViewSource {
	let drafts = runtimeDrafts.get(active);
	if (!drafts) runtimeDrafts.set(active, drafts = new Map());
	return {
		facts: () => active.activityFacts(),
		worker: (name) => active.store.find(name),
		session: (worker) => active.setup.pool.getSession(worker.sessionPath),
		onSession: (listener) => active.onWorkerSession(listener),
		onWorkerRemoved: (listener) => active.onWorkerRemoved(listener),
		send: async (name, prompt) => {
			await ACTION_HANDLERS.send(active, { worker: name, prompt, origin: "view" }, active.ctx);
		},
		drafts,
	};
}

/**
 * 一个子代理记录：宿主组件镜像（轮记录随分支进来，投影按它分轮）、这个子代理自己的轮次时钟、热会话时的事件订阅，
 * 以及视图在它上面的状态（逐轮展开、全部展开档位、滚动与点击锚定），切走切回原样。
 */
class WorkerRecord {
	readonly mirror: ChatMirror;
	readonly clock = new TurnClock();
	readonly overrides = new Set<object>();
	expanded = false;
	/** 正文的第一行；undefined 表示跟随末尾。 */
	scrollTop: number | undefined;
	/** 上次布局的正文高与最大首行。 */
	contentHeight = 0;
	maxTop = 0;
	viewport = 0;
	readonly anchor: ClickAnchor;
	private unsubscribe: (() => void) | undefined;

	constructor(worker: WorkerRef, readonly session: AgentSession | undefined, tui: TUI, theme: Theme, private readonly changed: () => void) {
		const definitions: Record<string, ReturnType<typeof toolDefinitions>[keyof ReturnType<typeof toolDefinitions>]> = toolDefinitions();
		this.mirror = new ChatMirror({
			ui: detachedTui(tui, changed),
			cwd: worker.cwd ?? process.cwd(),
			theme,
			toolDefinition: (tool) => definitions[tool],
			messageRenderer: (type) => session?.extensionRunner.getMessageRenderer(type),
			// 轮记录逐条经 roundFromEntry 读出，以零行标记放进聊天树，投影按它分轮（与主会话同一份记录格式）。
			entryRenderer: (type) => (type === ROUND_ENTRY ? roundEntryRenderer : undefined),
		});
		const branch = session ? session.sessionManager.getBranch() as MirrorEntry[] : fileBranch(worker.sessionPath);
		for (const entry of branch) this.mirror.replay(entry);
		this.sync(session?.isStreaming === true);
		if (session) this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		const record = this;
		const scroller: Scroller = {
			get top() { return record.scrollTop ?? record.maxTop; },
			get following() { return record.scrollTop === undefined; },
			get viewport() { return record.viewport; },
			get contentHeight() { return record.contentHeight; },
			holdAt: (top) => { this.scrollTop = top; },
			follow: () => { this.scrollTop = undefined; },
		};
		this.anchor = new ClickAnchor(() => scroller);
	}

	/** 用户滚动：到底即恢复跟随末尾。 */
	scrollBy(delta: number): void {
		const next = Math.max(0, Math.min(this.maxTop, (this.scrollTop ?? this.maxTop) + delta));
		this.scrollTop = next >= this.maxTop ? undefined : next;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") this.sync(true);
		if (event.type === "agent_end") this.sync(false);
		const touched = this.mirror.handle(event);
		if (touched || event.type === "agent_start" || event.type === "agent_end" || event.type === "queue_update") this.changed();
	}

	private sync(running: boolean): void {
		this.clock.sync({ agentRunning: running, inFlight: 0, busy: running, review: false, ...(running ? { since: Date.now() } : {}) });
	}
}

const roundEntryRenderer: EntryRenderer = (entry) => {
	const round = roundFromEntry(entry);
	return round && roundMarker(round);
};

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
	private readonly input = new Input({ prompt: "› ", placeholder: msg.view.placeholder });
	private readonly projection = new Container();
	private readonly headless = {};
	/** 打开期间看过的子代理：名字 → 记录。 */
	private readonly records = new Map<string, WorkerRecord>();
	private readonly stopWatches: (() => void)[];
	private failure: string | undefined;
	/** 正在看的子代理已被移除：上横线写“已移除”，输入框停用。 */
	private removed = false;
	/** 在启动序里的位置；被移除后 Tab 从这里接着走。 */
	private index = 0;
	private notice: { text: string; until?: number } | undefined;
	private noticeTimer: ReturnType<typeof setTimeout> | undefined;
	private bodyRows = 0;
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
		this.stopWatches = [
			// 冷子代理被唤醒、或释放后重开：会话在第一条事件之前接上订阅，记录从新会话重建一次。
			source.onSession((worker) => {
				if (worker !== this.name || this.removed) return;
				this.load();
				this.tui.requestRender();
			}),
			source.onWorkerRemoved((worker) => this.onRemoved(worker)),
		];
		this.enter(name);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	invalidate(): void {}

	dispose(): void {
		this.saveDraft();
		for (const stop of this.stopWatches.splice(0)) stop();
		for (const record of this.records.values()) record.dispose();
		this.records.clear();
		clearTimeout(this.noticeTimer);
		this.stopFrames?.();
		this.stopFrames = undefined;
		this.projection.children = [];
	}

	private get record(): WorkerRecord | undefined {
		return this.records.get(this.name);
	}

	private worker(): WorkerRef | undefined {
		return this.source.worker(this.name);
	}

	private names(): string[] {
		return launchOrder(this.source.facts());
	}

	/** 换到某个子代理：草稿换成它的，记录与展开状态打开期间看过就原样接上。 */
	private enter(name: string): void {
		this.name = name;
		this.removed = false;
		this.notice = undefined;
		this.index = Math.max(0, this.names().indexOf(name));
		this.input.setValue(this.source.drafts.get(name) ?? "");
		this.load();
	}

	private saveDraft(): void {
		const draft = this.input.getValue();
		if (draft && !this.removed) this.source.drafts.set(this.name, draft);
		else this.source.drafts.delete(this.name);
	}

	/** 记录缺失或会话已换（释放后重开、冷启动）时构建一次；之后由事件增量。 */
	private load(): void {
		this.failure = undefined;
		const worker = this.worker();
		if (!worker) {
			this.failure = msg.view.gone(this.name);
			return;
		}
		const session = this.source.session(worker);
		const cached = this.record;
		if (cached && cached.session === session) return;
		cached?.dispose();
		this.records.delete(this.name);
		try {
			this.records.set(this.name, new WorkerRecord(worker, session, this.tui as TUI, this.theme, () => this.tui.requestRender()));
		} catch (error) {
			this.failure = error instanceof HostShapeError ? error.message : msg.view.unreadable(worker.name, error instanceof Error ? error.message : String(error));
		}
	}

	/** 被移除的子代理：别的直接丢掉；正在看的留着已有记录（不再更新），上横线写“已移除”，输入框停用。 */
	private onRemoved(name: string): void {
		this.records.get(name)?.dispose();
		this.source.drafts.delete(name);
		if (name === this.name) {
			this.removed = true;
			this.input.setValue("");
		} else this.records.delete(name);
		this.tui.requestRender();
	}

	private env(record: WorkerRecord): ProjectionEnv {
		return {
			ui: { theme: this.theme, getToolsExpanded: () => record.expanded },
			clock: record.clock, headless: this.headless,
			toggleRow: (row) => {
				row.setExpanded(!(row as unknown as { expanded: boolean }).expanded);
				this.tui.requestRender();
			},
			isOpen: (key) => record.overrides.has(key),
			toggleOpen: (key) => {
				if (!record.overrides.delete(key)) record.overrides.add(key);
				this.tui.requestRender();
			},
		};
	}

	render(width: number): string[] {
		const worker = this.removed ? undefined : this.worker();
		const facts = this.source.facts();
		const index = worker ? facts.workers.findIndex((entry) => entry.name === worker.name) : -1;
		const state = index < 0 ? undefined : rowState(facts, index, Date.now(), this.theme);
		const queued = this.queued(width);
		this.bodyRows = Math.max(1, this.tui.terminal.rows - CHROME_ROWS - queued.length);
		const { lines: body, animating } = this.body(width);
		// 动效与上横线耗时只在有东西在动时订阅全局时钟，静止即取消。
		this.syncFrames(animating || (state !== undefined && ANIMATING_KINDS.has(state.kind)));
		const record = this.record;
		let top = 0;
		if (record) {
			record.viewport = this.bodyRows;
			record.anchor.layout(body.length);
			record.contentHeight = body.length;
			record.maxTop = Math.max(0, body.length - this.bodyRows);
			top = Math.min(record.scrollTop ?? record.maxTop, record.maxTop);
		}
		const shown = body.slice(top, top + this.bodyRows);
		while (shown.length < this.bodyRows) shown.push("");
		return [...shown, ...queued, this.topLine(width, worker, state), this.inputLine(width), this.bottomLine(width, worker)];
	}

	private body(width: number): { lines: string[]; animating: boolean } {
		const record = this.record;
		if (!record) return { lines: [this.theme.fg("warning", ` ${this.failure ?? ""}`)], animating: false };
		const { nodes, animating } = projectProcessGroups(record.mirror.chat.children, this.env(record));
		this.projection.children = nodes;
		return { lines: this.projection.render(width), animating };
	}

	private syncFrames(moving: boolean): void {
		if (moving && !this.stopFrames) this.stopFrames = onFrame(() => this.tui.requestRender());
		else if (!moving && this.stopFrames) {
			this.stopFrames();
			this.stopFrames = undefined;
		}
	}

	/** 已发出、还没在句缝送达的补话：读 Worker 会话的排队事实，送达后自然消失。 */
	private queued(width: number): string[] {
		const steering = this.removed ? [] : this.record?.session?.getSteeringMessages() ?? [];
		return steering.map((text) => clip(this.theme.fg("dim", ` ${msg.view.queued(text)}`), width));
	}

	private readonly line = (text: string) => this.theme.fg("borderMuted", text);

	/** 上横线：左状态（字形、状态词、耗时，必保），右名字 · 角色；放不下时先让角色，再截短名字，最后不写名字。 */
	private topLine(width: number, worker: WorkerRef | undefined, state: ReturnType<typeof rowState> | undefined): string {
		const name = this.theme.bold(this.name);
		if (!worker || !state) {
			const status = this.removed ? this.theme.fg("warning", msg.view.removed) : "";
			return fitBorder(width, this.line, 0, [[status, name], [status, ""]]);
		}
		const { kind, row } = state;
		const word = kind === "stuck" ? this.theme.fg("warning", row.note?.short ?? "") : STATUS_WORD[kind];
		// 空闲的“·”标记紧挨状态词像个分隔符，不放。
		const status = [kind === "idle" ? "" : row.mark, word, row.elapsed && this.theme.fg("muted", row.elapsed)].filter(Boolean).join(" ");
		const role = this.theme.fg("muted", worker.role);
		function* candidates(): Generator<BorderParts> {
			yield [status, `${name}${SEPARATOR}${role}`];
			for (let room = visibleWidth(name); room >= MIN_NAME; room--) yield [status, clip(name, room)];
			yield [status, ""];
		}
		return fitBorder(width, this.line, ANIMATING_KINDS.has(kind) ? 1 : 0, candidates());
	}

	private inputLine(width: number): string {
		if (this.removed) return clip(`› ${this.theme.fg("dim", msg.view.removedInput)}`, width);
		return this.input.render(width)[0] ?? "";
	}

	/** 下横线：左位置 n/N（必保），右模型与按键提示（按宽度退让，“esc 返回”永远保留）；通知（已发出、未送达）替换右侧。 */
	private bottomLine(width: number, worker: WorkerRef | undefined): string {
		const names = this.names();
		const position = names.indexOf(this.name);
		if (position >= 0) this.index = position;
		const lead = position >= 0 ? `${position + 1}/${names.length}` : "";
		const notice = this.notice && (this.notice.until === undefined || Date.now() < this.notice.until) ? this.notice.text : undefined;
		const model = worker ? modelAtomText(worker) : "";
		const dim = (text: string) => this.theme.fg("dim", text);
		function* candidates(): Generator<BorderParts> {
			if (notice) {
				for (let room = visibleWidth(notice); room >= 1; room--) yield [lead, dim(clip(notice, room))];
				return;
			}
			const tail = TAIL.filter((item) => item.text !== undefined || model);
			for (;;) {
				yield [lead, dim(tail.map((item) => item.text ?? model).join(" · "))];
				const weakest = tail.reduce((a, b) => (b.drop < a.drop ? b : a));
				if (weakest.drop === Infinity) return;
				tail.splice(tail.indexOf(weakest), 1);
			}
		}
		return fitBorder(width, this.line, 0, candidates());
	}

	/**
	 * 浮层抢走焦点后宿主编辑器上的全局键不再生效，在这里给出同义行为：esc 返回；ctrl+c 先清输入、再按关闭视图；
	 * 空输入的 ctrl+d 关闭视图（不在浮层里退出整个 pi）；ctrl+o 是这个视图的全部展开；PageUp/PageDown 翻页。
	 */
	handleInput(data: string): void {
		const empty = !this.input.getValue();
		this.notice = undefined;
		if (this.keys.matches(data, "app.interrupt")) return this.done();
		if (this.keys.matches(data, "app.clear")) return empty ? this.done() : this.clearInput();
		if (this.keys.matches(data, "app.exit") && empty) return this.done();
		if (this.keys.matches(data, "app.tools.expand")) return this.toggleAll();
		if (matchesKey(data, "tab")) return this.step(1);
		if (matchesKey(data, "shift+tab")) return this.step(-1);
		if (matchesKey(data, "pageUp")) return this.scroll(1 - this.bodyRows);
		if (matchesKey(data, "pageDown")) return this.scroll(this.bodyRows - 1);
		if (!this.removed) this.input.handleInput(data);
		this.tui.requestRender();
	}

	private toggleAll(): void {
		const record = this.record;
		if (!record) return;
		record.expanded = !record.expanded;
		record.overrides.clear();
		this.tui.requestRender();
	}

	private scroll(delta: number): void {
		this.record?.scrollBy(delta);
		this.tui.requestRender();
	}

	private clearInput(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	private step(direction: number): void {
		const names = this.names();
		const count = names.length;
		if (count < (this.removed ? 1 : 2)) return;
		this.saveDraft();
		if (this.removed) {
			// 被移除的位置由后一个顶上：Tab 落在原位置，Shift+Tab 落在前一个。
			this.enter(names[(direction > 0 ? this.index : this.index - 1 + count) % count]);
		} else this.enter(names[(names.indexOf(this.name) + direction + count) % count]);
		this.tui.requestRender();
	}

	/**
	 * 只处理滚轮与点击：按下、拖动与松开交还宿主，宿主据此做文字选择（有浮层时按屏幕坐标选、松开即复制），
	 * 不拖动的松开再由宿主转成点击发回来；点到摘要、↳ 与工具行之外的地方也交还宿主。
	 */
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		const record = this.record;
		const row = event.y;
		if (event.type !== "click" || !record || row < 0 || row >= this.bodyRows) return undefined;
		const line = Math.min(record.scrollTop ?? record.maxTop, record.maxTop) + row;
		const result = this.projection.handleMouse({ ...event, y: line, height: record.contentHeight });
		if (result) record.anchor.click(line);
		return result;
	}

	private async send(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || this.sending || this.removed) return;
		const name = this.name;
		this.sending = true;
		this.showNotice(msg.view.sending);
		try {
			await this.source.send(name, prompt);
			if (name === this.name) this.input.setValue("");
			this.source.drafts.delete(name);
			this.showNotice(msg.view.sent, NOTICE_MS);
		} catch (error) {
			this.showNotice(msg.view.undelivered(error instanceof Error ? error.message : String(error)));
		} finally {
			this.sending = false;
		}
	}

	private showNotice(text: string, duration?: number): void {
		clearTimeout(this.noticeTimer);
		this.notice = { text, ...(duration === undefined ? {} : { until: Date.now() + duration }) };
		if (duration !== undefined) {
			this.noticeTimer = setTimeout(() => this.tui.requestRender(), duration);
			this.noticeTimer.unref?.();
		}
		this.tui.requestRender();
	}
}
