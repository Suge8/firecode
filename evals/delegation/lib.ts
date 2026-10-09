// 委派评测的共享底座：工作目录、pi 启动、会话记录读取。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..");
export const WORK = process.env.EVAL_DIR ?? join(tmpdir(), "firecode-delegation-eval");
export const USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** 与 tests/loader.ts 同一套定位：设了 PI_PACKAGES_DIR 就跑那份源码，否则用 PATH 里的 pi。 */
function piCommand(): [string, string[]] {
	const packages = process.env.PI_PACKAGES_DIR;
	return packages ? ["bun", [join(packages, "coding-agent/src/cli.ts")]] : ["pi", []];
}

export function gitArchive(ref: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	execFileSync("sh", ["-c", 'git -C "$0" archive "$1" | tar -x -C "$2"', REPO, ref, dest]);
}

export function gitShow(ref: string, path: string): string {
	return execFileSync("git", ["-C", REPO, "show", `${ref}:${path}`], { encoding: "utf8" });
}

export function initGit(dir: string): void {
	const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=eval", "-c", "user.email=eval@example.com", ...a], { stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "eval fixture");
}

/** 每次运行一个独立的仓库副本与 TMPDIR。 */
export function prepareRun(dir: string, fixture: string): { repo: string; tmp: string } {
	rmSync(dir, { recursive: true, force: true });
	const repo = join(dir, "repo");
	const tmp = join(dir, "tmp");
	mkdirSync(tmp, { recursive: true });
	cpSync(fixture, repo, { recursive: true });
	return { repo, tmp };
}

/**
 * 子进程不继承任何 PI_* 与 HERDR_*：前者含外层 pi 给工具设的会话变量（PI_SESSION_FILE、PI_MODEL 等）和个人设置（PI_CACHE_RETENTION），
 * 会让不同人跑出的结果不可比；后者会让子进程回写用户自己的 herdr pane。评测需要的 PI_* 在下面显式给出。
 */
export function startPi(args: string[], o: { variant: string; cwd: string; tmp: string; stdin: "pipe" | "ignore"; env?: Record<string, string> }): ChildProcess {
	const env: Record<string, string | undefined> = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI|HERDR)_/u.test(key))),
		PI_CODING_AGENT_DIR: join(WORK, "variants", o.variant, "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		TMPDIR: o.tmp,
		...o.env,
	};
	const [cmd, base] = piCommand();
	return spawn(cmd, [...base, ...args], { cwd: o.cwd, env, detached: true, stdio: [o.stdin, "pipe", "pipe"] });
}

/** pi 的 bash 工具把命令放进自己的进程组，只杀 pi 的组会留下孤儿（比如 15 分钟的 e2e），所以先按父子关系收集全部后代。 */
function descendants(root: number): number[] {
	const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
	const found: number[] = [];
	for (let queue = [root]; queue.length; ) {
		const children = table.filter(([, ppid]) => queue.includes(ppid)).map(([pid]) => pid);
		found.push(...children);
		queue = children;
	}
	return found;
}

export function killTree(child: ChildProcess): void {
	const pids = [...descendants(child.pid!), child.pid!];
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

/** 逐行吃 stdout 的 JSON 事件。 */
export function onJsonLines(child: ChildProcess, handle: (event: any) => void): void {
	let pending = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		let nl: number;
		while ((nl = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, nl).trim();
			pending = pending.slice(nl + 1);
			if (!line) continue;
			try {
				handle(JSON.parse(line));
			} catch {}
		}
	});
}

export function readJsonl(path: string): any[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

export function jsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? jsonlFiles(path) : path.endsWith(".jsonl") ? [path] : [];
	});
}

export const entryCost = (entries: any[]): number => entries.reduce((sum, e) => sum + (e.message?.usage?.cost?.total ?? 0), 0);

/** 一次运行（主会话 + 全部 Worker）的美元花费。 */
export const runCost = (runDir: string): number => jsonlFiles(join(runDir, "sessions")).reduce((sum, f) => sum + entryCost(readJsonl(f)), 0);

export function finalText(sessionFile: string): string {
	let last = "";
	for (const e of readJsonl(sessionFile)) {
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const text = e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		if (text.trim()) last = text;
	}
	return last;
}

/** 最多 limit 个并发依次跑完。 */
export async function pool(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
		while (next < jobs.length) await jobs[next++]!();
	}));
}

export function parseList(value: string | undefined): string[] | undefined {
	return value?.split(",").filter(Boolean);
}
