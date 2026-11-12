/**
 * 进展行：一句“它现在在做什么”，只给人看，不进任何模型的上下文。两处使用同一个生成器（ProgressLines）：
 * - 在跑子代理：显示在活动列表的在跑行、全过程视图头部，并随名册交给同进程的其他扩展（如 CuePad 桥），不发指挥官事件；接线在 master/。
 * - 主会话自己的回合：经宿主扩展状态交给输入框外壳，替换上边框的“处理中”（registerSessionProgress）；外壳关闭时不生成。
 *
 * 触发：回合进行中，且自上次生成后有新输出（助手正文或工具调用）才生成；运行满 Timing.progressFirstMs 出第一句，
 * 之后最多每 Timing.progressEveryMs 一次。没有新输出就不调用：计时器只在输出到达时挂，不轮询。落定、被移除与会话关闭都停。
 * 输入只给有界增量（工作说明首段、上一句、这段时间的正文片段与工具调用，不含工具结果与思考），总量约 3k 字符。
 * 单次失败不重试，那一行回到现在的阶段文字；连续失败只在界面提示一次，成功后重新计数。
 */
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelChain } from "../config.js";
import { clip, oneLine, textOf } from "../format.js";
import { readPrompt } from "../i18n.js";
import type { ChainCompletion } from "../model-route.js";
import type { InProcessSessionPool } from "../spawn.js";
import { STATUS_KEYS } from "../status-keys.js";
import { toolTargetText } from "../tools/actions.js";
import { msg } from "./messages.js";

const PROMPT = readPrompt(new URL("./prompts/", import.meta.url), "progress");

/** 一行的显示宽度上限：提示词要求中文 10 字（20 列）、英文 30 字符，这里只挡模型不听话。 */
const LINE_WIDTH = 30;
/** 输入各段上限：合计（含标签）约 3k 字符。 */
const BRIEF_CHARS = 600;
const SAID_CHARS = 300;
const TOOL_CHARS = 200;
const NOTES_CHARS = 2_000;
/** 低思考档的推理也计入输出额度，留够免得一句话被截断。 */
const MAX_TOKENS = 1_024;
const FAILURES_BEFORE_NOTICE = 3;
const WRAPPING = /^["'`“”‘’「」]+|["'`“”‘’「」]+$/gu;

export interface ProgressHost {
	complete(chain: ModelChain, context: Context, options: { maxTokens: number; signal: AbortSignal }): Promise<ChainCompletion>;
	timing: { progressFirstMs: number; progressEveryMs: number };
	/** 某一句变了：重绘。 */
	changed(): void;
	warn(text: string): void;
}

interface Entry {
	brief: string;
	running: boolean;
	startedAt: number;
	/** 最近一次生成开始的时刻：两次生成的间隔从它起算。 */
	lastAt?: number;
	/** 显示中的一句，也是下一次的“上一句”；失败时清掉。 */
	text?: string;
	notes: string[];
	noteChars: number;
	timer?: NodeJS.Timeout;
	busy?: AbortController;
}

export class ProgressLines {
	private readonly entries = new Map<string, Entry>();
	private failures = 0;
	private warned = false;

	constructor(private readonly chain: ModelChain, private readonly host: ProgressHost) {}

	/** 显示用的那一句；没有或不在跑时 undefined。 */
	text(name: string): string | undefined {
		const entry = this.entries.get(name);
		return entry?.running ? entry.text : undefined;
	}

	/** 新一次运行：以工作说明首段为背景，清掉上次的句子与笔记。 */
	begin(name: string, prompt: string): void {
		this.remove(name);
		const brief = clip(oneLine(prompt.trim().split(/\n\s*\n/u)[0] ?? ""), BRIEF_CHARS);
		this.entries.set(name, { brief, running: true, startedAt: Date.now(), notes: [], noteChars: 0 });
	}

	/** 暂停后的自动续跑：沿用这次运行的工作说明，重新计时。 */
	resume(name: string): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		entry.running = true;
		entry.startedAt = Date.now();
		entry.lastAt = undefined;
	}

	said(name: string, text: string): void {
		const line = clip(oneLine(text), SAID_CHARS);
		if (line) this.note(name, msg.progress.said(line));
	}

	toolCall(name: string, tool: string, args: unknown, cwd: string): void {
		this.note(name, clip(oneLine(`${tool} ${toolTargetText(tool, args, cwd)}`), TOOL_CHARS));
	}

	/** 落定、被中断或暂停：不再生成，那一句作废（它描述的是已经结束的运行）。 */
	stop(name: string): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		entry.running = false;
		entry.text = undefined;
		this.cancel(entry);
		entry.notes = [];
		entry.noteChars = 0;
	}

	remove(name: string): void {
		this.stop(name);
		this.entries.delete(name);
	}

	close(): void {
		for (const name of [...this.entries.keys()]) this.remove(name);
	}

	private note(name: string, line: string): void {
		const entry = this.entries.get(name);
		if (!entry?.running) return;
		entry.notes.push(line);
		entry.noteChars += line.length;
		// 只留最近的：超出就丢最早的。
		while (entry.noteChars > NOTES_CHARS && entry.notes.length > 1) entry.noteChars -= entry.notes.shift()!.length;
		this.arm(name, entry);
	}

	private arm(name: string, entry: Entry): void {
		if (!entry.running || entry.timer || entry.busy || !entry.notes.length) return;
		const { progressFirstMs, progressEveryMs } = this.host.timing;
		const due = entry.lastAt === undefined ? entry.startedAt + progressFirstMs : entry.lastAt + progressEveryMs;
		entry.timer = setTimeout(() => void this.generate(name, entry), Math.max(0, due - Date.now()));
		entry.timer.unref?.();
	}

	private cancel(entry: Entry): void {
		clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.busy?.abort();
		entry.busy = undefined;
	}

	private async generate(name: string, entry: Entry): Promise<void> {
		entry.timer = undefined;
		if (!entry.running || !entry.notes.length) return;
		const notes = entry.notes.join("\n");
		entry.notes = [];
		entry.noteChars = 0;
		entry.lastAt = Date.now();
		const controller = entry.busy = new AbortController();
		const user = [msg.progress.brief(entry.brief), ...(entry.text ? [msg.progress.previous(entry.text)] : []), msg.progress.notes(notes)].join("\n");
		try {
			const { message } = await this.host.complete(
				this.chain,
				{ systemPrompt: PROMPT, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
				{ maxTokens: MAX_TOKENS, signal: controller.signal },
			);
			if (controller.signal.aborted) return;
			const line = lineOf(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
			if (!line) throw new Error(msg.progress.empty);
			entry.text = line;
			this.failures = 0;
			this.warned = false;
		} catch (error) {
			if (controller.signal.aborted) return;
			entry.text = undefined;
			this.failures += 1;
			if (this.failures >= FAILURES_BEFORE_NOTICE && !this.warned) {
				this.warned = true;
				this.host.warn(msg.progress.failing(this.failures, error instanceof Error ? error.message : String(error)));
			}
		} finally {
			if (entry.busy === controller) {
				entry.busy = undefined;
				this.host.changed();
				this.arm(name, entry);
			}
		}
	}
}

/** 模型回复里的第一行有效文字：去掉包裹的引号，裁到一行宽度。 */
function lineOf(text: string): string {
	const first = text.split("\n").map((line) => oneLine(line).replace(WRAPPING, "").trim()).find(Boolean) ?? "";
	return clip(first, LINE_WIDTH);
}

/** 主会话只有一个回合在跑，生成器里就这一个名字。 */
const SESSION = "session";

/**
 * 主会话的进展行。工作说明取最近一条人类输入：结果唤醒的回合仍在做用户上一次要的事。
 * 发布只经宿主扩展状态（STATUS_KEYS.progress），外壳按键读取；回合落定与拆会话时清掉。
 */
export function registerSessionProgress(pi: ExtensionAPI, pool: InProcessSessionPool, chain: ModelChain): void {
	let brief = "";
	let ui: ExtensionUIContext | undefined;
	const publish = () => ui?.setStatus(STATUS_KEYS.progress, lines.text(SESSION));
	const lines = new ProgressLines(chain, {
		complete: (candidates, context, options) => pool.complete(candidates, context, options),
		timing: pool.timing,
		changed: publish,
		warn: (text) => ui?.notify(text, "warning"),
	});
	pi.on("input", (event) => {
		if (event.text.trim()) brief = event.text;
		return { action: "continue" };
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		lines.begin(SESSION, brief);
	});
	pi.on("tool_execution_start", (event, ctx) => lines.toolCall(SESSION, event.toolName, event.args, ctx.cwd));
	// 只记带工具调用的正文（边说边做）；以 stop 收尾的最终回复意味着回合马上落定，为它再调一次模型是白花。
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && event.message.stopReason === "toolUse") lines.said(SESSION, textOf(event.message.content));
	});
	const end = () => {
		lines.remove(SESSION);
		publish();
	};
	pi.on("agent_settled", end);
	pi.on("session_shutdown", end);
}
