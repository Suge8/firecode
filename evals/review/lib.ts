// 审查评测的共享底座：工作目录、被审仓库来源、git 操作、额度闸门。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, USER_AGENT_DIR } from "../delegation/lib.ts";

export const WORK = process.env.EVAL_DIR ?? join(tmpdir(), "firecode-review-eval");

/** 用例取材的仓库。pi 默认用维护者本机的克隆，PI_REPO 可改。 */
export const SOURCES = {
	firecode: REPO,
	pi: process.env.PI_REPO ?? join(homedir(), "Project", "pi"),
} as const;
export type Source = keyof typeof SOURCES;

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=eval", "-c", "user.email=eval@example.com", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** 任一订阅低于停止线，或查询失败/窗口缺失，就停止付费调用；审查与裁判共用。 */
const GATEWAY = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425/v1";
export const QUOTA_FLOOR = {
	codex: { window: "7 days", min: 15 },
	claude: { window: "5 hours", min: 20 },
};
type Quotas = Array<{ provider: string; windows: Array<{ name: string; remaining: number }> }>;

export async function quotaSnapshot(): Promise<Record<string, number>> {
	const key = USER_MODELS.providers.magpie?.apiKey;
	const response = await fetch(`${GATEWAY}/magpie/quotas`, {
		headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`额度查询 HTTP ${response.status}`);
	const { data } = await response.json() as { data: Quotas };
	return Object.fromEntries(data.flatMap((entry) => entry.windows.map((window) => [`${entry.provider} ${window.name}`, window.remaining])));
}

export async function quotaBlock(): Promise<string | undefined> {
	try {
		const quotas = await quotaSnapshot();
		for (const [provider, floor] of Object.entries(QUOTA_FLOOR)) {
			const remaining = quotas[`${provider} ${floor.window}`];
			if (!Number.isFinite(remaining)) return `额度窗口缺失：${provider} ${floor.window}`;
			if (remaining! < floor.min) return `${provider} ${floor.window} 剩余 ${remaining}% < ${floor.min}%`;
		}
	} catch (error) {
		return `读不到额度：${error}`;
	}
	return undefined;
}

/** 被审代码的宿主版本只影响其验证命令；运行 /fire-review 的 pi 仍由 delegation/lib.ts 选取。 */
export function fixtureHost(repo: string): { version: string; env: Record<string, string> } {
	const source = join(repo, "scripts/pi-source.ts");
	const version = existsSync(source) ? /PI_VERSION = "([^"]+)"/u.exec(readFileSync(source, "utf8"))?.[1] : "v1.1.0";
	if (!version) throw new Error(`无法确定宿主版本：${source}`);
	const directory = join(WORK, "hosts", version);
	if (!existsSync(join(directory, ".firecode-ready"))) throw new Error(`先运行 bun evals/review/setup.ts ${version}`);
	return { version, env: { PI_PACKAGES_DIR: join(directory, "packages"), FIRECODE_PI_DIR: directory } };
}

export const USER_MODELS = JSON.parse(readFileSync(join(USER_AGENT_DIR, "models.json"), "utf8")) as { providers: Record<string, any> };

/** 原子 → models.json 里的物理模型；省略供应商时按段边界匹配（与 FireCode 的原子解析同一规则，取第一个）。 */
export function physical(atom: string): { provider: string; model: string; thinking: string } {
	const cut = atom.lastIndexOf("/");
	const name = atom.slice(0, cut);
	for (const [provider, entry] of Object.entries(USER_MODELS.providers))
		for (const model of entry.models ?? [])
			if (`${provider}/${model.id}` === name || model.id === name || `${provider}/${model.id}`.endsWith(`/${name}`)) return { provider, model: model.id, thinking: atom.slice(cut + 1) };
	throw new Error(`models.json 里找不到 ${atom}`);
}

/** pi 命令行的 --model 写法。 */
export const cliModel = (atom: string): string => {
	const { provider, model, thinking } = physical(atom);
	return `${provider}/${model}:${thinking}`;
};
