import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REVIEW_OCCUPANCY_LABEL, readReviewOutcome, type ReviewOutcome } from "../review/outcome.js";
import {
	liveWorkers,
	requireWorker,
	THINKING_LEVELS,
	type MasterStore,
	type WorkerRef,
	type WorkerThinking,
} from "./state.js";

const RESULT_CONTEXT_LIMIT = 12_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** 占用信号失效时审查监听的轮询兑底间隔。 */
const REVIEW_POLL_DELAY_MS = 2_000;
/** 自审启动宽限：/fire-review 在实现回合结束后才执行并写 checkpoint/占用，
 * idle 与它们之间是跨进程异步窗口、无事件可等，只能有界复查；
 * 仅对 /skill:implement 委派生效，普通委派零额外延迟。 */
const SELF_REVIEW_GRACE_PROBES = 5;
const SELF_REVIEW_GRACE_DELAY_MS = 600;
const MAX_WORKERS_PER_TAB = 4;

interface HerdrAgent {
	pane_id: string;
	tab_id: string;
	name?: string | null;
	agent_status?: "idle" | "blocked" | "done";
	state_labels?: Record<string, string>;
	agent_session?: { kind?: string; value?: string } | null;
}

interface LatestAssistant {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface StartWorkerOptions {
	prompt: string;
	name?: string;
	model?: string;
	thinking?: string;
	session?: string;
}

/** 分配完成、尚待并行启动的工人：串行临界区的产出，交给 launchWorker 收尾。 */
interface WorkerLaunch {
	provisional: WorkerRef;
	prompt: string;
	model: string;
	thinking: WorkerThinking;
	sessionPath?: string;
	previous?: WorkerRef;
	shell: WorkerShell;
	shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>;
	controller: AbortController;
	signal: AbortSignal;
}

interface WorkerShell {
	paneId: string;
	tabId: string;
	close: "pane" | "tab";
}

type PositionedWorker = WorkerRef & { paneId: string; tabId: string };

export class HerdrWorkers {
	private readonly pi: ExtensionAPI;
	private readonly store: MasterStore;
	private readonly workspaceId: string;
	private readonly notifyMaster: (content: string) => void;
	private readonly runs = new Map<string, AbortController>();
	/** 池级生命周期：shutdown 后中止一切在飞启动，防止清理完成后孤儿工人复活。 */
	private readonly lifecycle = new AbortController();
	/** 在飞启动集合：shutdown 要等它们真正退出，reload 后新旧运行时才不会同时写状态文件。 */
	private readonly launches = new Set<Promise<unknown>>();
	private startQueue = Promise.resolve();

	constructor(options: {
		pi: ExtensionAPI;
		store: MasterStore;
		workspaceId: string;
		notifyMaster: (content: string) => void;
	}) {
		this.pi = options.pi;
		this.store = options.store;
		this.workspaceId = options.workspaceId;
		this.notifyMaster = options.notifyMaster;
	}

	/**
	 * 入队时能解析出的全部身份：显式命名，加 session/休眠引用反查出的旧名。
	 * 改名恢复期间工人池展示的仍是旧名，按两个身份 stop 都必须命中同一个取消控制器。
	 */
	private queuedStartNames(options: StartWorkerOptions): string[] {
		const names = new Set<string>();
		const explicit = options.name?.trim();
		if (explicit) names.add(explicit);
		const session = options.session?.trim();
		if (session) {
			const referenced = this.store.state.workers.find(
				(worker) => worker.name === session || worker.sessionPath === session,
			)?.name;
			if (referenced) names.add(referenced);
		}
		return [...names];
	}

	async start(ctx: ExtensionContext, options: StartWorkerOptions): Promise<WorkerRef> {
		// 入队即在全部身份下登记取消控制器；同名并发启动直接拒绝（排队等死还留取消盲区）。
		const names = this.queuedStartNames(options);
		for (const key of names)
			if (this.runs.has(key))
				throw new Error(`${key} 已有进行中的启动或监听任务，不能重复启动`);
		const pending = names.length > 0 ? new AbortController() : undefined;
		for (const key of names) if (pending) this.runs.set(key, pending);
		// 串行区只包住布局分配（读容量 + 建 shell + 写占位）；shell 握手与 agent 启动并行，
		// 首批工单才能真正并行启动。
		const allocated = this.startQueue.then(() => this.allocateWorker(ctx, options, pending));
		this.startQueue = allocated.then(() => undefined, () => undefined);
		const launched = allocated.then((launch) => this.launchWorker(launch));
		const tracked: Promise<WorkerRef> = launched.finally(() => {
			this.launches.delete(tracked);
			if (!pending) return;
			for (const key of names) if (this.runs.get(key) === pending) this.runs.delete(key);
		});
		this.launches.add(tracked);
		return tracked;
	}

	/**
	 * 串行临界区：名字/模型解析、布局容量计算、shell 创建与占位状态写入。
	 * shell 创建必须留在串行区：后一个工人的象限切分依赖前一个 pane 的落位，
	 * 并发创建会互相拿错容量、误切同一 pane；代价是宿主降级时（pane/tab 创建慢）
	 * 后续分配最长等 60 秒，这是保布局正确性的有意取舍；shell 握手与 agent 启动已在队外并行。
	 */
	private async allocateWorker(
		ctx: ExtensionContext,
		options: StartWorkerOptions,
		pending?: AbortController,
	): Promise<WorkerLaunch> {
		// 排队期间被 stop：在任何解析与副作用之前短路，休眠引用可能已被 forget。
		if (pending?.signal.aborted || this.lifecycle.signal.aborted)
			throw new Error("启动在排队阶段已被停止");
		const prompt = requiredText(options.prompt, "prompt");
		const referenced = options.session
			? this.store.state.workers.find(
				(worker) => worker.name === options.session || worker.sessionPath === options.session,
			)
			: undefined;
		if (referenced && referenced.status !== "dormant")
			throw new Error(`${referenced.name} 仍是 ${referenced.status}，无需恢复`);
		const dormant = referenced;
		const name = options.name?.trim() || dormant?.name;
		if (!name) throw new Error("start 需要 worker 名：用简短任务词命名（如 fix-outcome、scan-dups）");
		validateWorkerName(name);
		const existing = this.store.state.workers.find((worker) => worker.name === name);
		if (existing && existing !== dormant) throw new Error(`Worker 已存在：${name}`);
		const model = options.model?.trim() || dormant?.model || currentModel(ctx);
		const thinking = parseThinking(options.thinking) ?? dormant?.thinking ?? parseThinking(ctx.thinkingLevel) ?? "medium";
		const sessionPath = dormant?.sessionPath ?? options.session?.trim();
		const previous = dormant;
		if (dormant && dormant.name !== name)
			this.store.dispatch({ type: "REMOVE_WORKER", name: dormant.name });
		const provisional: WorkerRef = {
			name,
			model,
			thinking,
			status: "starting",
			paneId: "starting",
			tabId: "starting",
			...(sessionPath ? { sessionPath } : {}),
		};
		// 启动也注册进 runs：stop/shutdown 能中止在飞启动，不只是监听；排队期被 stop 的直接短路。
		const startController = pending ?? new AbortController();
		if (startController.signal.aborted || this.lifecycle.signal.aborted)
			throw new Error(`${name} 启动在排队阶段已被停止`);
		this.store.dispatch({ type: "UPSERT_WORKER", worker: provisional });
		this.runs.set(name, startController);
		const signal = AbortSignal.any([this.lifecycle.signal, startController.signal]);
		let shellReady: Awaited<ReturnType<typeof createShellReadyMarker>> | undefined;
		try {
			shellReady = await createShellReadyMarker();
			const shell = await this.createWorkerShell(ctx.cwd, name, displayName(name, model), shellReady, !sessionPath, signal);
			this.store.dispatch({
				type: "UPSERT_WORKER",
				worker: { ...provisional, paneId: shell.paneId, tabId: shell.tabId },
			});
			return { provisional, prompt, model, thinking, sessionPath, previous, shell, shellReady, controller: startController, signal };
		} catch (error) {
			await this.abandonStart(name, previous, undefined, startController);
			if (shellReady) await this.removeShellReady(name, shellReady);
			throw error;
		}
	}

	/** 串行区之外的长尾巴：shell 握手、agent 启动与监听，多个启动并行执行。 */
	private async launchWorker(launch: WorkerLaunch): Promise<WorkerRef> {
		const name = launch.provisional.name;
		try {
			await this.waitForShell(launch.shell.paneId, launch.shellReady.marker, launch.signal);
			const worker = await this.startAgent(
				launch.provisional,
				launch.shell.paneId,
				launch.model,
				launch.thinking,
				launch.sessionPath,
				launch.signal,
			);
			if (this.runs.get(name) === launch.controller) this.runs.delete(name);
			void this.monitorPrompt(worker, launch.prompt);
			return worker;
		} catch (error) {
			await this.abandonStart(name, launch.previous, launch.shell, launch.controller);
			throw error;
		} finally {
			if (this.runs.get(name) === launch.controller) this.runs.delete(name);
			await this.removeShellReady(name, launch.shellReady);
		}
	}

	private async abandonStart(
		name: string,
		previous: WorkerRef | undefined,
		shell: WorkerShell | undefined,
		controller: AbortController,
	): Promise<void> {
		// 池关闭（reload/退出）：零副作用——不关 shell、不写状态。reload 要保留工人现场
		// 交给下个运行时 reconcile；off/quit 的实体清理由 cleanup() 的 stop 负责。
		if (this.lifecycle.signal.aborted) return;
		if (shell) {
			try {
				await this.closeWorkerShell(shell, name);
			} catch (cleanupError) {
				this.notifyMaster(`Worker ${name} 启动失败后的 pane 清理也失败：${String(cleanupError)}`);
			}
		}
		this.store.dispatch({ type: "REMOVE_WORKER", name });
		// 回写策略按停止意图分流：自然失败与默认 stop 都恢复原休眠引用（契约：stop 保留
		// Dormant）；forget 与池关闭不回写，清理完成后的状态必须保持空。
		const reason = controller.signal.aborted
			? (controller.signal.reason as { keepDormant?: boolean } | undefined)
			: undefined;
		const keep = !controller.signal.aborted || reason?.keepDormant === true;
		if (previous && !this.lifecycle.signal.aborted && keep)
			this.store.dispatch({ type: "UPSERT_WORKER", worker: previous });
	}

	private async removeShellReady(
		name: string,
		shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
	): Promise<void> {
		try {
			await rm(shellReady.directory, { recursive: true, force: true });
		} catch (error) {
			this.notifyMaster(`Worker ${name} 的临时 shell 配置清理失败：${String(error)}`);
		}
	}

	async send(workerName: string, prompt: string): Promise<void> {
		const worker = requireWorker(this.store.state, workerName);
		if (worker.status === "reviewing")
			throw new Error(`${worker.name} 正在对抗审查，期间不能接收追问`);
		if (worker.status !== "idle" && worker.status !== "blocked")
			throw new Error(`${worker.name} 当前是 ${worker.status}，不能接收追问`);
		const text = requiredText(prompt, "prompt");
		const active = { ...worker, status: "working" as const };
		this.store.dispatch({ type: "UPSERT_WORKER", worker: active });
		void this.monitorPrompt(active, text);
	}

	async review(workerName: string): Promise<void> {
		const worker = requireWorker(this.store.state, workerName);
		if (worker.status !== "idle") throw new Error(`${worker.name} 当前是 ${worker.status}，只有 idle Worker 可以审查`);
		const previousRunId = worker.sessionPath
			? reviewRunId(readReviewOutcome(worker.sessionPath)) ?? null
			: null;
		// --wait 要求投递后观察到状态变化才返回：堵住“投递后 Worker 短暂仍报 idle、
		// 后续监听立即结算误报审查未启动”的竞态。审查启动后状态为 working（命令回合）或 blocked（占用信号）。
		try {
			await this.run("agent.prompt(review)", [
				"agent", "prompt", requiredPane(worker), "/fire-review",
				"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000",
			], 15_000);
		} catch (error) {
			if (!isPromptStall(error)) throw error;
			// 占用信号失效时会话可能全程观察不到状态变化：以 runId 是否推进判定审查是否真的启动。
			const observed = worker.sessionPath
				? reviewRunId(readReviewOutcome(worker.sessionPath)) ?? null
				: null;
			if (observed === previousRunId)
				throw new Error(`${worker.name} 审查未启动：投递后状态与 fire-review runId 均无变化`);
		}
		const reviewing = {
			...worker,
			status: "reviewing" as const,
			reviewPreviousRunId: previousRunId,
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker: reviewing });
		void this.monitorReview(reviewing);
	}

	async stop(workerName: string, forget = false): Promise<void> {
		// 无条件中止该名字的在飞/排队任务：休眠分支也不能跳过。
		// 停止意图随 abort reason 传给清理路径：默认 stop 保留原休眠引用，forget 才删。
		const pending = this.runs.get(workerName);
		pending?.abort({ keepDormant: !forget });
		this.runs.delete(workerName);
		const existing = this.store.state.workers.find((candidate) => candidate.name === workerName);
		if (!existing) {
			if (pending) return;
			throw new Error(`Worker 不存在：${workerName}`);
		}
		const worker = existing;
		if (worker.status !== "dormant") await this.closeOwnedWorker(worker);
		if (forget || !worker.sessionPath) {
			this.store.dispatch({ type: "REMOVE_WORKER", name: worker.name });
			return;
		}
		this.store.dispatch({ type: "UPSERT_WORKER", worker: dormantWorker(worker) });
	}

	async resume(): Promise<void> {
		for (const worker of liveWorkers(this.store.state)) {
			if (this.runs.has(worker.name)) continue;
			await this.reconcile(worker);
		}
	}

	async cleanup(): Promise<string[]> {
		const failures: string[] = [];
		for (const worker of [...this.store.state.workers]) {
			try {
				await this.stop(worker.name, true);
			} catch (error) {
				failures.push(`${worker.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failures;
	}

	async shutdown(): Promise<void> {
		this.lifecycle.abort();
		for (const controller of this.runs.values()) controller.abort();
		this.runs.clear();
		// 等在飞启动真正退出：reload 后新实例才恢复，避免新旧运行时交错写同一状态文件。
		await Promise.allSettled([this.startQueue, ...this.launches]);
	}

	private async createWorkerShell(
		cwd: string,
		name: string,
		display: string,
		shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
		allowSplit: boolean,
		signal?: AbortSignal,
	): Promise<WorkerShell> {
		const plan = allowSplit ? this.splitPlan() : undefined;
		if (plan) {
			try {
				const created = await this.run("pane.split", [
					"pane", "split", requiredPane(plan.target), "--direction", plan.direction, "--cwd", cwd,
					...workerShellEnv(name, shellReady), "--no-focus",
				], 60_000, signal);
				const pane = nestedRecord(created, ["result", "pane"]);
				const paneId = requiredField(pane, "pane_id", "pane.split.pane");
				await this.renamePane(paneId, display);
				// tab 从“首工人专属”变成分组：标签改组名，不再冒用首工人的名字。
				await this.renameTab(plan.target.tabId, "workers");
				return { paneId, tabId: plan.target.tabId, close: "pane" };
			} catch (error) {
				// Layout is best-effort: a fresh tab keeps Worker startup independent of split support.
				// 但中止不是布局失败，不得退化继续建 tab。
				if (signal?.aborted) throw error;
			}
		}
		const created = await this.run("tab.create", [
			"tab", "create", "--workspace", this.workspaceId, "--cwd", cwd, "--label", display,
			...workerShellEnv(name, shellReady), "--no-focus",
		], 60_000, signal);
		const rootPane = nestedRecord(created, ["result", "root_pane"]);
		const tab = nestedRecord(created, ["result", "tab"]);
		const paneId = requiredField(rootPane, "pane_id", "tab.create.root_pane");
		await this.renamePane(paneId, display);
		return {
			paneId,
			tabId: requiredField(tab, "tab_id", "tab.create.tab"),
			close: "tab",
		};
	}

	/** pane 命名纯属显示，失败不影响 Worker 启动，但要告知 Master。 */
	private async renamePane(paneId: string, label: string): Promise<void> {
		try {
			await this.run("pane.rename", ["pane", "rename", paneId, label]);
		} catch (error) {
			this.notifyMaster(`pane 命名失败（不影响 Worker）：${String(error)}`);
		}
	}

	/** tab 命名同样纯属显示，失败只通知。 */
	private async renameTab(tabId: string, label: string): Promise<void> {
		try {
			await this.run("tab.rename", ["tab", "rename", tabId, label]);
		} catch (error) {
			this.notifyMaster(`tab 命名失败（不影响 Worker）：${String(error)}`);
		}
	}

	/**
	 * 2×2 象限布局：第 2 个右切首 pane，第 3 个下切首 pane，第 4 个下切第 2 个 pane。
	 * 嵌套同向切会把后来者挤成 1/8 宽，象限切保证四个 Worker 各占ᵇ四分之一。
	 */
	private splitPlan(): { target: PositionedWorker; direction: "right" | "down" } | undefined {
		const positioned = liveWorkers(this.store.state).filter(hasPaneLocation);
		const latest = positioned.at(-1);
		if (!latest) return undefined;
		const occupants = positioned.filter((worker) => worker.tabId === latest.tabId);
		if (occupants.length >= MAX_WORKERS_PER_TAB) return undefined;
		if (occupants.length === 1) return { target: occupants[0], direction: "right" };
		if (occupants.length === 2) return { target: occupants[0], direction: "down" };
		return { target: occupants[1], direction: "down" };
	}

	private async startAgent(
		provisional: WorkerRef,
		paneId: string,
		model: string,
		thinking: WorkerThinking,
		sessionPath?: string,
		signal?: AbortSignal,
	): Promise<WorkerRef> {
		const args = [
			"agent",
			"start",
			agentName(provisional.name, model),
			"--kind",
			"pi",
			"--pane",
			paneId,
			"--timeout",
			"60000",
			"--",
			"--name",
			`↳${displayName(provisional.name, model)}`,
			"--model",
			model,
			"--thinking",
			thinking,
		];
		if (sessionPath) args.push("--session", sessionPath);
		const agent = parseAgent(await this.run("agent.start", args, 90_000, signal));
		const worker: WorkerRef = {
			name: provisional.name,
			paneId: agent.pane_id,
			tabId: agent.tab_id,
			sessionPath: requireSessionPath(agent),
			model,
			thinking,
			status: "working",
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker });
		return worker;
	}

	private async waitForShell(paneId: string, marker: string, signal?: AbortSignal): Promise<void> {
		await this.run("pane.wait-output(shell ready)", [
			"pane",
			"wait-output",
			paneId,
			"--match",
			marker,
			"--source",
			"recent-unwrapped",
			"--lines",
			"120",
			"--timeout",
			"60000",
		], 65_000, signal);
	}

	private async reconcile(worker: WorkerRef): Promise<void> {
		const live = await this.findLiveAgent(worker);
		if (!live) {
			if (worker.status === "starting") await this.closeStartingShell(worker);
			this.makeDormantOrForget(worker, "Worker 进程已不存在");
			return;
		}
		const sessionPath = optionalSessionPath(live);
		if (!sessionPath || (worker.sessionPath && worker.sessionPath !== sessionPath)) {
			this.makeDormantOrForget(worker, "Worker session 身份已变化");
			return;
		}
		const refreshed: WorkerRef = {
			...worker,
			paneId: live.pane_id,
			tabId: live.tab_id,
			sessionPath,
			status: reconciledStatus(worker.status),
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker: refreshed });
		if (refreshed.status === "reviewing") void this.monitorReview(refreshed);
		else if (refreshed.status === "working") void this.monitorWait(refreshed);
	}

	private makeDormantOrForget(worker: WorkerRef, reason: string): void {
		if (worker.sessionPath)
			this.store.dispatch({ type: "UPSERT_WORKER", worker: dormantWorker(worker) });
		else this.store.dispatch({ type: "REMOVE_WORKER", name: worker.name });
		this.notifyMaster(`${worker.name} ${reason}`);
	}

	private async findLiveAgent(worker: WorkerRef): Promise<HerdrAgent | undefined> {
		const label = agentName(worker.name, worker.model);
		const targets = worker.paneId && worker.paneId !== "starting" ? [worker.paneId, label] : [label];
		for (const target of targets) {
			try {
				return parseAgent(await this.run("agent.get(reconcile)", ["agent", "get", target]));
			} catch (error) {
				if (!isMissingAgent(error)) throw error;
			}
		}
		return undefined;
	}

	private async closeStartingShell(worker: WorkerRef): Promise<void> {
		const tabId = await this.findStartingTab(displayName(worker.name, worker.model));
		if (tabId) await this.closeTab(tabId);
		else if (worker.paneId && worker.paneId !== "starting") await this.closePane(worker.paneId);
	}

	private async findStartingTab(label: string): Promise<string | undefined> {
		const response = await this.run("tab.list(reconcile)", ["tab", "list", "--workspace", this.workspaceId]);
		const matches = parseTabs(response).filter((tab) => tab.label === label);
		if (matches.length > 1) {
			this.notifyMaster(`${label} 有多个同名启动残留，未自动关闭`);
			return undefined;
		}
		return matches[0]?.tab_id;
	}

	private monitorPrompt(worker: WorkerRef, prompt: string): Promise<void> {
		// /skill:implement 委派自带 fire-review 自审：结算前需要启动宽限窗口。
		const expectSelfReview = prompt.startsWith("/skill:implement ");
		return this.monitorSettlement(worker, "agent.prompt", [
			"agent", "prompt", requiredPane(worker), prompt, "--wait",
		], "work", undefined, expectSelfReview);
	}

	private monitorWait(worker: WorkerRef): Promise<void> {
		// reload 重挂无委派文本可判：已启动的自审由占用/checkpoint 路径覆盖，
		// 恰落在启动窗口内的 reload 极罕见，不为它付全员宽限成本。
		return this.monitorSettlement(worker, "agent.wait", settlementWaitArgs(worker), "work");
	}

	private monitorReview(worker: WorkerRef): Promise<void> {
		return this.monitorSettlement(
			worker,
			"agent.wait(review)",
			reviewWaitArgs(worker),
			"review",
			worker.reviewPreviousRunId,
		);
	}

	private async monitorSettlement(
		worker: WorkerRef,
		operation: string,
		args: string[],
		mode: "work" | "review",
		previousReviewRunId?: string | null,
		expectSelfReview = false,
	): Promise<void> {
		const controller = new AbortController();
		this.runs.set(worker.name, controller);
		// 自审基线：工作监听开始时的审查 runId；结算时 runId 推进才算本次任务内的自审终态。
		// reload 后重挂若错过已完结的自审，只损失一行判定信息，不会误报旧结果。
		const selfReviewBaseline = mode === "work" && worker.sessionPath
			? reviewRunId(readReviewOutcome(worker.sessionPath)) ?? null
			: null;
		let failures = 0;
		try {
			while (!controller.signal.aborted) {
				try {
					const settlement = await this.run(operation, args, null, controller.signal);
					if (controller.signal.aborted) return;
					if (mode === "review") {
						const finished = await this.handleReviewSettlement(
							worker,
							settlement,
							controller.signal,
							previousReviewRunId,
						);
						if (finished) return;
						// 审查仍在循环却观测到 idle：占用信号失效时没有事件可等，
						// 这里是有意的轮询兑底：退避后重挂等待直到审查落终态。
						operation = "agent.wait(review)";
						args = reviewWaitArgs(worker);
						await retryDelay(REVIEW_POLL_DELAY_MS, controller.signal);
						continue;
					}
					const verdict = await this.handleSettlement(
						worker,
						settlement,
						controller.signal,
						selfReviewBaseline,
						expectSelfReview,
					);
					if (verdict === "done") return;
					// 技能内自审：占用态（reviewing）或占用失效的轮间 idle（poll）都不是终态，
					// 换用跳过 blocked 的等待直到审查落终态。
					operation = "agent.wait(review)";
					args = reviewWaitArgs(worker);
					if (verdict === "poll") await retryDelay(REVIEW_POLL_DELAY_MS, controller.signal);
					continue;
				} catch (error) {
					if (controller.signal.aborted) return;
					const current = currentWorkerRun(this.store.state.workers, worker);
					if (!current || current.status === "dormant") return;
					if (isMissingAgent(error)) {
						this.makeDormantOrForget(current, "Worker 进程已不存在");
						return;
					}
					if (failures === 0)
						this.notifyMaster(`Worker ${worker.name} ${mode === "review" ? "审查" : ""}监听失败，正在恢复：${error instanceof Error ? error.message : String(error)}`);
					else await retryDelay(Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS), controller.signal);
					failures += 1;
					operation = mode === "review" ? "agent.wait(review)" : "agent.wait";
					args = mode === "review" ? reviewWaitArgs(worker) : settlementWaitArgs(worker);
				}
			}
		} finally {
			if (this.runs.get(worker.name) === controller) this.runs.delete(worker.name);
		}
	}

	/** 工作结算裁定：done=已终结；reviewing=自审占用中；poll=自审进行中但占用信号失效。 */
	private async handleSettlement(
		worker: WorkerRef,
		response: Record<string, unknown>,
		signal: AbortSignal,
		selfReviewBaseline: string | null = null,
		expectSelfReview = false,
	): Promise<"done" | "reviewing" | "poll"> {
		const agent = parseAgent(response);
		const status = settlementStatus(agent);
		const current = currentWorkerRun(this.store.state.workers, worker);
		if (!current || current.status === "dormant") return "done";
		if (status === "blocked") {
			const label = stateLabel(agent);
			// 审查占用不是 Worker 提问：转 reviewing（send 守卫随之拒绝追问），继续等终态。
			if (label?.includes(REVIEW_OCCUPANCY_LABEL)) {
				this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "reviewing" } });
				return "reviewing";
			}
			const question = label ?? (await readLatestAssistant(current.sessionPath))?.text;
			if (signal.aborted) return "done";
			const blocked = currentWorkerRun(this.store.state.workers, worker);
			if (!blocked || blocked.status === "dormant") return "done";
			this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...blocked, status } });
			this.notifyMaster(workerBlockedText(blocked, question));
			return "done";
		}
		let outcome = worker.sessionPath ? readReviewOutcome(worker.sessionPath) : undefined;
		let runId = outcome ? reviewRunId(outcome) : undefined;
		let advanced = runId !== undefined && runId !== selfReviewBaseline;
		// 实现回合结束到自审写入 checkpoint/占用之间是跨进程异步窗口：
		// 对 /skill:implement 委派做有界宽限复查（无事件可等，只能短暂轮询），
		// 确认既无新 runId 也无占用才结算，否则审查尚未启动就会被假完成。
		for (let probe = 0; expectSelfReview && !advanced && probe < SELF_REVIEW_GRACE_PROBES; probe += 1) {
			await retryDelay(SELF_REVIEW_GRACE_DELAY_MS, signal);
			if (signal.aborted) return "done";
			outcome = worker.sessionPath ? readReviewOutcome(worker.sessionPath) : undefined;
			runId = outcome ? reviewRunId(outcome) : undefined;
			advanced = runId !== undefined && runId !== selfReviewBaseline;
		}
		// 自审仍在进行却观测到 idle：占用信号失效或刚启动的窗口，不能就此结算。
		if (advanced && outcome?.status === "in_progress") return "poll";
		const latest = await this.latest(worker);
		if (signal.aborted) return "done";
		const settled = currentWorkerRun(this.store.state.workers, worker);
		if (!settled || settled.status === "dormant") return "done";
		this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...settled, status: "idle" } });
		// 宽限耗尽仍未观测到自审：不得静默吞成普通成功，Master 要拿到补审/查配置的决策依据。
		const review = advanced && outcome && outcome.status !== "none"
			? `自审判定：${reviewOutcomeText(outcome)}`
			: expectSelfReview
				? "自审判定：未观测到自审启动（宽限窗口内无新审查 runId）——用 review action 补审或检查 fire-review 配置"
				: undefined;
		if (!latest || latest.stopReason !== "stop" || latest.errorMessage)
			this.notifyMaster(workerFailureText(settled, latest, review));
		else this.notifyMaster(workerResultText(settled, latest, review));
		return "done";
	}

	/** 返回审查监听是否已终结；false 表示审查仍在循环，调用方需重挂等待。 */
	private async handleReviewSettlement(
		worker: WorkerRef,
		response: Record<string, unknown>,
		signal: AbortSignal,
		previousRunId?: string | null,
	): Promise<boolean> {
		const status = settlementStatus(parseAgent(response));
		if (status === "blocked") throw new Error("Herdr 审查等待错误返回 blocked");
		const latest = await this.latest(worker);
		if (signal.aborted) return true;
		const settled = currentWorkerRun(this.store.state.workers, worker);
		if (!settled || settled.status !== "reviewing") return true;
		const observed: ReviewOutcome = settled.sessionPath
			? readReviewOutcome(settled.sessionPath)
			: { status: "error", message: "Worker 缺少 Pi session 路径" };
		const stale = previousRunId !== undefined && (reviewRunId(observed) ?? null) === previousRunId;
		// runId 已推进但仍在循环中：占用信号失效时轮间会观测到 idle，不能就此结算。
		if (!stale && observed.status === "in_progress") return false;
		const outcome: ReviewOutcome = stale
			? { status: "error", message: "审查未启动：未观察到新的 fire-review runId" }
			: observed;
		const { reviewPreviousRunId: _previousRunId, ...finished } = settled;
		this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...finished, status: "idle" } });
		this.notifyMaster(reviewResultText(settled, outcome, latest));
		return true;
	}

	private async latest(worker: WorkerRef): Promise<LatestAssistant | undefined> {
		const live = parseAgent(await this.run("agent.get", ["agent", "get", requiredPane(worker)]));
		return readLatestAssistant(requireSessionPath(live));
	}

	private async closeOwnedWorker(worker: WorkerRef): Promise<void> {
		const live = await this.findLiveAgent(worker);
		if (!live) {
			// agent 从未启动的 starting 壳（如 reload 遗留）也要收，共享 tab 只收自己的 pane。
			if (worker.paneId && worker.paneId !== "starting") {
				const shared = liveWorkers(this.store.state).some((candidate) =>
					candidate.name !== worker.name && candidate.tabId === worker.tabId
				);
				if (shared || !worker.tabId || worker.tabId === "starting") await this.closePane(worker.paneId);
				else await this.closeTab(worker.tabId);
			}
			return;
		}
		const sessionPath = optionalSessionPath(live);
		const owned = worker.sessionPath
			? sessionPath === worker.sessionPath
			: live.pane_id === worker.paneId && live.tab_id === worker.tabId;
		if (!owned) return;
		const sharedTab = liveWorkers(this.store.state).some((candidate) =>
			candidate.name !== worker.name && candidate.tabId === live.tab_id
		);
		if (sharedTab) await this.closePane(live.pane_id);
		else await this.closeTab(live.tab_id);
	}

	private async closeWorkerShell(shell: WorkerShell, ownerName?: string): Promise<void> {
		if (shell.close === "pane") return this.closePane(shell.paneId);
		// 开 tab 的首工人被中止时，同 tab 可能已有并行启动的其他工人：不能连坐关整 tab。
		const shared = liveWorkers(this.store.state).some((candidate) =>
			candidate.name !== ownerName && candidate.tabId === shell.tabId
		);
		if (shared) return this.closePane(shell.paneId);
		return this.closeTab(shell.tabId);
	}

	private async closePane(paneId: string): Promise<void> {
		if (!paneId || paneId === "starting") return;
		try {
			await this.run("pane.close", ["pane", "close", paneId]);
		} catch (error) {
			if (!String(error).includes("pane_not_found")) throw error;
		}
	}

	private async closeTab(tabId: string): Promise<void> {
		if (!tabId || tabId === "starting") return;
		try {
			await this.run("tab.close", ["tab", "close", tabId]);
		} catch (error) {
			if (!String(error).includes("tab_not_found")) throw error;
		}
	}

	private async run(
		operation: string,
		args: string[],
		timeout: number | null = 60_000,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const result = await this.pi.exec(process.env.HERDR_BIN_PATH ?? "herdr", args, {
			...(timeout === null ? {} : { timeout }),
			signal,
		});
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
			throw new Error(`Herdr ${operation} 失败：${detail}`);
		}
		try {
			return JSON.parse(result.stdout) as Record<string, unknown>;
		} catch {
			throw new Error(`Herdr ${operation} 返回了无效 JSON`);
		}
	}
}

async function createShellReadyMarker(): Promise<{ directory: string; marker: string }> {
	if (!process.env.SHELL?.endsWith("/zsh")) throw new Error("Master Worker 当前只支持 zsh 启动握手");
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-shell-"));
	const marker = `firecode-shell-ready-${crypto.randomUUID()}`;
	try {
		await Promise.all([
			writeFile(join(directory, ".zshenv"), '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n'),
			writeFile(join(directory, ".zprofile"), '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n'),
			writeFile(join(directory, ".zshrc"), [
				'[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
				"autoload -Uz add-zsh-hook",
				"function _firecode_shell_ready() {",
				'  print -r -- "$FIRECODE_SHELL_READY_MARKER"',
				"  add-zsh-hook -d precmd _firecode_shell_ready",
				"}",
				"add-zsh-hook precmd _firecode_shell_ready",
				"",
			].join("\n")),
		]);
		return { directory, marker };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function workerShellEnv(
	name: string,
	shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
): string[] {
	return [
		"--env", `FIRECODE_MASTER_WORKER=${name}`,
		"--env", `FIRECODE_SHELL_READY_MARKER=${shellReady.marker}`,
		"--env", `ZDOTDIR=${shellReady.directory}`,
	];
}

function hasPaneLocation(worker: WorkerRef): worker is PositionedWorker {
	return !!worker.paneId && worker.paneId !== "starting" && !!worker.tabId && worker.tabId !== "starting";
}

function currentModel(ctx: ExtensionContext): string {
	if (!ctx.model) throw new Error("当前会话没有可继承的模型");
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function parseThinking(value?: string): WorkerThinking | undefined {
	if (!value) return undefined;
	if (THINKING_LEVELS.includes(value as WorkerThinking)) return value as WorkerThinking;
	throw new Error(`thinking 必须是 ${THINKING_LEVELS.join(" / ")}`);
}

function validateWorkerName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name))
		throw new Error("Worker name 必须匹配 [a-z][a-z0-9_-]{0,31}");
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	return value.trim();
}

function requiredPane(worker: WorkerRef): string {
	if (!worker.paneId || worker.paneId === "starting") throw new Error(`${worker.name} 缺少可用 pane`);
	return worker.paneId;
}

function parseAgent(response: Record<string, unknown>): HerdrAgent {
	const result = nestedRecord(response, ["result"]);
	const value = (result.agent ?? result) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr 响应缺少 agent");
	const agent = value as Record<string, unknown>;
	const name = agent.name;
	const stateLabels = stringRecord(agent.state_labels);
	return {
		pane_id: requiredField(agent, "pane_id", "agent"),
		tab_id: requiredField(agent, "tab_id", "agent"),
		...(typeof name === "string" || name === null ? { name } : {}),
		...(agent.agent_status === "idle" || agent.agent_status === "blocked" || agent.agent_status === "done"
			? { agent_status: agent.agent_status }
			: {}),
		...(stateLabels ? { state_labels: stateLabels } : {}),
		...(typeof agent.agent_session === "object" ? { agent_session: agent.agent_session as HerdrAgent["agent_session"] } : {}),
	};
}

function requireSessionPath(agent: HerdrAgent): string {
	const path = optionalSessionPath(agent);
	if (path) return path;
	throw new Error("Herdr 响应缺少持久 Pi session 路径");
}

function optionalSessionPath(agent: HerdrAgent): string | undefined {
	return agent.agent_session?.kind === "path" && typeof agent.agent_session.value === "string"
		? agent.agent_session.value
		: undefined;
}

function parseTabs(response: Record<string, unknown>): { tab_id: string; label?: string }[] {
	const tabs = nestedRecord(response, ["result"]).tabs;
	if (!Array.isArray(tabs)) throw new Error("Herdr 响应缺少 result.tabs");
	return tabs.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Herdr result.tabs 包含无效 tab");
		const tab = value as Record<string, unknown>;
		return {
			tab_id: requiredField(tab, "tab_id", "tab"),
			...(typeof tab.label === "string" ? { label: tab.label } : {}),
		};
	});
}

function isMissingAgent(error: unknown): boolean {
	return error instanceof Error && error.message.includes("agent_not_found");
}

/** prompt --wait 在投递后未观察到状态变化时的两种超时形态。 */
function isPromptStall(error: unknown): boolean {
	const text = String(error);
	return text.includes("agent_prompt_stalled") || text.includes("timeout");
}

/** pane/tab/Pi 会话的统一显示名：任务名-模型名，一眼认出谁在干什么、用的什么。 */
function displayName(name: string, model: string): string {
	return `${name}-${model.split("/").pop()}`;
}

/**
 * Herdr agent 名硬约束 [a-z][a-z0-9_-]{0,31}：点号等字符降为 "-"；
 * 超长时裁任务词保模型尾——模型名被挤掉就违背“任务-模型一眼可见”。
 */
function agentName(name: string, model: string): string {
	const modelPart = sanitizeAgentChars(String(model.split("/").pop()));
	const task = sanitizeAgentChars(name);
	const taskBudget = 31 - modelPart.length;
	if (taskBudget < 1) return `${task}-${modelPart}`.slice(0, 32);
	return `${task.slice(0, taskBudget)}-${modelPart}`;
}

function sanitizeAgentChars(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
}

async function readLatestAssistant(path?: string): Promise<LatestAssistant | undefined> {
	if (!path) return undefined;
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const nodes = new Map<string, { parentId?: string; assistant?: LatestAssistant }>();
	let leaf: string | undefined;
	for (const line of text.split("\n")) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof entry.id !== "string") continue;
		const node: { parentId?: string; assistant?: LatestAssistant } = {};
		if (typeof entry.parentId === "string") node.parentId = entry.parentId;
		const message = entry.message;
		if (message && typeof message === "object" && !Array.isArray(message)) {
			const record = message as Record<string, unknown>;
			if (record.role === "assistant") {
				const assistant: LatestAssistant = { text: messageText(record.content) };
				if (typeof record.stopReason === "string") assistant.stopReason = record.stopReason;
				if (typeof record.errorMessage === "string") assistant.errorMessage = record.errorMessage;
				node.assistant = assistant;
			}
		}
		nodes.set(entry.id, node);
		leaf = entry.id;
	}
	const visited = new Set<string>();
	while (leaf && !visited.has(leaf)) {
		visited.add(leaf);
		const node = nodes.get(leaf);
		if (!node) break;
		if (node.assistant) return node.assistant;
		leaf = node.parentId;
	}
	return undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return [];
		const record = part as Record<string, unknown>;
		return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
	}).join("\n");
}

function currentWorkerRun(workers: WorkerRef[], expected: WorkerRef): WorkerRef | undefined {
	return workers.find((worker) =>
		worker.name === expected.name &&
		worker.paneId === expected.paneId &&
		worker.tabId === expected.tabId &&
		worker.sessionPath === expected.sessionPath
	);
}

function settlementStatus(agent: HerdrAgent): "idle" | "blocked" | "done" {
	const status = agent.agent_status;
	if (status) return status;
	throw new Error("Herdr 等待响应缺少有效 agent_status");
}

function dormantWorker(worker: WorkerRef): WorkerRef {
	if (!worker.sessionPath) throw new Error(`${worker.name} 缺少可恢复 session`);
	return {
		name: worker.name,
		model: worker.model,
		thinking: worker.thinking,
		status: "dormant",
		sessionPath: worker.sessionPath,
	};
}

function workerBlockedText(worker: WorkerRef, question?: string): string {
	return [
		`Worker ${worker.name} 等待输入`,
		...workerHeader(worker),
		question ? `问题：\n${bounded(question)}` : "Worker 未提供具体问题，请检查对应 pane。",
		"使用 herdr_agents send 回答后继续。",
	].join("\n");
}

function reviewResultText(worker: WorkerRef, outcome: ReviewOutcome, latest: LatestAssistant | undefined): string {
	return [
		`Worker ${worker.name} 审查结束`,
		`判定：${reviewOutcomeText(outcome)}`,
		...workerHeader(worker),
		latest?.text ? `最终回复：\n${bounded(latest.text)}` : "最终回复为空。",
	].join("\n");
}

function reviewRunId(outcome: ReviewOutcome): string | undefined {
	return "runId" in outcome ? outcome.runId : undefined;
}

function reviewOutcomeText(outcome: ReviewOutcome): string {
	if (outcome.status === "passed") return `通过（${outcome.rounds} 轮）`;
	if (outcome.status === "stopped") {
		const first = outcome.advisorAdvice?.split(/\r?\n/u).find((line) => line.trim())?.trim();
		return `停止（${outcome.rounds} 轮${first ? `，顾问：${first.slice(0, 160)}` : ""}）`;
	}
	if (outcome.status === "failed") return `审查未完成（${outcome.reason}，第 ${outcome.rounds} 轮）`;
	if (outcome.status === "in_progress") return "判定异常（审查仍在进行中）";
	if (outcome.status === "none") return "判定异常（未找到审查）";
	return `判定读取失败（${outcome.message}）`;
}

function workerFailureText(
	worker: WorkerRef,
	latest: LatestAssistant | undefined,
	review?: string,
): string {
	const details = latest ? [
		latest.stopReason ? `停止原因：${latest.stopReason}` : undefined,
		latest.errorMessage,
		latest.text,
	].filter(Boolean).join("\n") : "未找到最终 assistant 回复";
	return [
		`Worker ${worker.name} 执行失败`,
		...workerHeader(worker),
		...(review ? [review] : []),
		`错误：\n${bounded(details)}`,
	].join("\n");
}

function workerResultText(worker: WorkerRef, latest: LatestAssistant, review?: string): string {
	return [
		`Worker ${worker.name} 已停下`,
		...workerHeader(worker),
		...(review ? [review] : []),
		latest.text ? `回复：\n${bounded(latest.text)}` : "回复为空。",
	].join("\n");
}

function workerHeader(worker: WorkerRef): string[] {
	return [
		`模型：${worker.model} · ${worker.thinking}`,
		`session：${worker.sessionPath ?? "未知"}`,
	];
}

function bounded(value: string): string {
	return value.length > RESULT_CONTEXT_LIMIT
		? `${value.slice(0, RESULT_CONTEXT_LIMIT)}\n…（完整内容保留在 Worker session）`
		: value;
}

function settlementWaitArgs(worker: WorkerRef): string[] {
	return ["agent", "wait", requiredPane(worker)];
}

function reviewWaitArgs(worker: WorkerRef): string[] {
	return ["agent", "wait", requiredPane(worker), "--until", "idle", "--until", "done"];
}

function reconciledStatus(status: WorkerRef["status"]): WorkerRef["status"] {
	return status === "idle" || status === "blocked" || status === "reviewing" ? status : "working";
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		timer.unref?.();
		signal.addEventListener("abort", finish, { once: true });
	});
}

function stateLabel(agent: HerdrAgent): string | undefined {
	const labels = Object.values(agent.state_labels ?? {}).filter((label) => label.trim());
	return labels.length ? [...new Set(labels)].join("\n") : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
		? Object.fromEntries(entries)
		: undefined;
}

function nestedRecord(value: unknown, path: string[]): Record<string, unknown> {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object" || Array.isArray(current))
			throw new Error(`Herdr 响应缺少 ${path.join(".")}`);
		current = (current as Record<string, unknown>)[key];
	}
	if (!current || typeof current !== "object" || Array.isArray(current))
		throw new Error(`Herdr 响应缺少 ${path.join(".")}`);
	return current as Record<string, unknown>;
}

function requiredField(value: Record<string, unknown>, key: string, path: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`Herdr ${path}.${key} 必须是字符串`);
	return field;
}
