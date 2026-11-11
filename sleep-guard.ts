/**
 * 拦截 bash 里等待超过 30 秒的 sleep：提示词写了五处不准裸 sleep 轮询，审计里仍有约 6,000 次不带条件的长 sleep，
 * 措辞已失效，改成机制。盲等拖住回合也看不到状态变化，短步长条件循环状态一变就返回。不属于任何可关的功能，每个会话都注册。
 * 同样拦下时长超过 120 秒的 timeout：它另开进程组，宿主中止命令时只收 shell 所在的组，漏下的 timeout 连同它跑的命令一直跑到自己的时限
 * （实测 timeout 3600 go test 在回合中止后又跑了 50 分钟）；短的漏下也很快自己结束，所以只拦长的。
 * codemode 脚本里的嵌套 bash 走宿主同一条 tool_call 钩子（事件带 parentToolCallId），不需要另一个入口。
 * 只认命令位置上的 sleep 与 timeout：引号里的文字、heredoc 正文与注释常提到它们（commit message、echo），不算；
 * 代价是 bash -c "sleep 120" 这类引号里的命令漏拦。不论在不在循环里都按时长判，算不出时长的按命中。
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { msg } from "./messages.js";

const MAX_SLEEP_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
/** 说明里推荐的条件循环步长。 */
const POLL_STEP_SECONDS = 10;
/** GNU sleep 的单位；多个参数时长相加。 */
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
/** 不是纯字面量的引号内容换成它：落在时长参数里就算不出时长。 */
const OPAQUE = "?";
const SEPARATORS = ";&|(){}`\n";
/** 命令位置上的这个命令与它的参数；参数止于分隔符，止于重定向的那个（如 2>&1 的 2）不算参数。 */
const commandAt = (name: string) =>
	new RegExp(
		String.raw`(?:^|[${SEPARATORS}]|\b(?:do|then|else|exec|nohup|time|command)\s)\s*(?:\S*/)?${name}(?![\w.-])((?:[ \t]+[^\s${SEPARATORS}<>]+(?=[\s${SEPARATORS}]|$))*)`,
		"g",
	);
const SLEEP = commandAt("sleep");
const TIMEOUT = commandAt("g?timeout");
/** timeout 时长之前、自己带一个值的选项（其余选项不带值）。 */
const TIMEOUT_VALUED = new Set(["-k", "-s", "--kill-after", "--signal"]);
const DURATION = /^(\d+\.?\d*|\.\d+)([smhd]?)$/;
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/;

export function registerSleepGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const { command } = event.input;
		if (hasLongSleep(command)) return { block: true, reason: msg.longSleep(MAX_SLEEP_SECONDS, POLL_STEP_SECONDS) };
		if (hasLongTimeout(command)) return { block: true, reason: msg.longTimeout(MAX_TIMEOUT_SECONDS) };
	});
}

function hasLongSleep(command: string): boolean {
	return [...skeleton(command).matchAll(SLEEP)].some((match) => {
		const args = match[1].trim().split(/\s+/).filter((arg) => arg && arg !== "--");
		return args.length > 0 && !(seconds(args) <= MAX_SLEEP_SECONDS);
	});
}

function hasLongTimeout(command: string): boolean {
	return [...skeleton(command).matchAll(TIMEOUT)].some((match) => {
		const args = match[1].trim().split(/\s+/).filter(Boolean);
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--") continue;
			if (TIMEOUT_VALUED.has(arg)) i++;
			else if (!arg.startsWith("-")) return !(seconds([arg]) <= MAX_TIMEOUT_SECONDS);
		}
		return false;
	});
}

function seconds(args: string[]): number {
	let total = 0;
	for (const arg of args) {
		if (arg === "inf" || arg === "infinity") return Infinity;
		const duration = DURATION.exec(arg);
		if (!duration) return NaN;
		total += Number(duration[1]) * UNIT_SECONDS[duration[2]];
	}
	return total;
}

/** 只留命令结构：去掉注释与 heredoc 正文，引号内容是纯字面量（sleep "120"）时保留，否则换成 OPAQUE。 */
function skeleton(command: string): string {
	let out = "";
	const heredocs: { tag: string; tabs: boolean }[] = [];
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "\\") {
			out += command.slice(i, i + 2);
			i++;
		} else if (c === "'" || c === '"') {
			let end = i + 1;
			while (end < command.length && command[end] !== c) end += c === '"' && command[end] === "\\" ? 2 : 1;
			const inner = command.slice(i + 1, end);
			out += /^[\w.]*$/.test(inner) ? inner : OPAQUE;
			i = end;
		} else if (c === "#" && (out === "" || /\s$/.test(out))) {
			const end = command.indexOf("\n", i);
			if (end < 0) break;
			i = end - 1;
		} else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const heredoc = HEREDOC.exec(command.slice(i));
			if (!heredoc) {
				out += "<<";
				i++;
				continue;
			}
			heredocs.push({ tag: heredoc[3], tabs: heredoc[1] === "-" });
			out += "<<";
			i += heredoc[0].length - 1;
		} else if (c === "\n" && heredocs.length > 0) {
			// 跳过各 heredoc 正文，停在最后一个结束行的换行之前，下一轮照常输出这个换行作分隔。
			let next = i + 1;
			for (const { tag, tabs } of heredocs.splice(0)) {
				while (next < command.length) {
					const end = command.indexOf("\n", next);
					const line = command.slice(next, end < 0 ? command.length : end);
					next = end < 0 ? command.length + 1 : end + 1;
					if ((tabs ? line.replace(/^\t+/, "") : line) === tag) break;
				}
			}
			i = next - 2;
		} else out += c;
	}
	return out;
}
