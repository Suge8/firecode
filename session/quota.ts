/** /quota：按需查询 Pi OAuth 订阅额度，只投界面通知，不参与会话或模型调用。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 3_000;
const FABLE_WINDOW = "Fable 本周";
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const PROVIDERS = [
	{ id: "openai-codex", name: "Codex", url: "https://chatgpt.com/backend-api/wham/usage", parse: codexWindows },
	{ id: "anthropic", name: "Claude", url: "https://api.anthropic.com/api/oauth/usage", parse: claudeWindows },
] as const;
type QuotaProvider = (typeof PROVIDERS)[number];
type QuotaWindow = { label: string; remaining: number };
const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function changedFormat(): never {
	throw new Error("额度响应格式已变化");
}

function quotaWindow(label: string, used: unknown): QuotaWindow {
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return changedFormat();
	return { label, remaining: Math.max(0, Math.round(100 - used)) };
}

function codexWindows(value: unknown): QuotaWindow[] {
	const rate = record(record(value).rate_limit);
	const windows: QuotaWindow[] = [];
	for (const value of [rate.primary_window, rate.secondary_window]) {
		if (value == null) continue;
		const entry = record(value);
		const seconds = entry.limit_window_seconds;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return changedFormat();
		const label = seconds === WEEK_SECONDS ? "本周"
			: seconds % DAY_SECONDS === 0 ? `${seconds / DAY_SECONDS}天` : `${seconds / HOUR_SECONDS}小时`;
		windows.push(quotaWindow(label, entry.used_percent));
	}
	return windows;
}

function claudeWindows(value: unknown): QuotaWindow[] {
	const limits = record(value).limits;
	if (!Array.isArray(limits)) return changedFormat();
	return limits.flatMap((value): QuotaWindow[] => {
		const entry = record(value);
		if (entry.kind === "session") return [quotaWindow("5小时", entry.percent)];
		if (entry.kind === "weekly_all") return [quotaWindow("本周", entry.percent)];
		const model = record(record(entry.scope).model).display_name;
		if (entry.kind === "weekly_scoped" && model === "Fable") return [quotaWindow(FABLE_WINDOW, entry.percent)];
		return [];
	});
}

function codexAccountId(token: string): string {
	try {
		const claims = record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
		const id = record(claims["https://api.openai.com/auth"]).chatgpt_account_id;
		if (typeof id === "string" && id) return id;
	} catch {
		throw new Error("Codex 登录凭据无效");
	}
	throw new Error("Codex 登录凭据缺少账户信息");
}

async function query(
	provider: QuotaProvider,
	registry: ExtensionContext["modelRegistry"],
	signal: AbortSignal,
	fetcher: typeof fetch,
): Promise<string> {
	try {
		const model = registry.getAll().find((model) => model.provider === provider.id);
		if (!model || !registry.isUsingOAuth(model)) return `${provider.name}：未通过 Pi OAuth 登录`;
		const resolution = await registry.getProviderAuth(provider.id);
		const token = resolution?.auth.apiKey;
		if (!token) throw new Error("未取得 OAuth 登录凭据");
		const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
		if (provider.id === "anthropic") headers.set("anthropic-beta", "oauth-2025-04-20");
		else headers.set("ChatGPT-Account-Id", codexAccountId(token));
		const response = await fetcher(provider.url, {
			headers, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const windows = provider.parse(await response.json());
		if (!windows.length) return changedFormat();
		const parts = windows.map(({ label, remaining }) => `${label}剩余 ${remaining}%`);
		if (provider.id === "anthropic" && !windows.some(({ label }) => label === FABLE_WINDOW))
			parts.push(`${FABLE_WINDOW}：未提供独立额度`);
		return `${provider.name}：${parts.join(" ｜ ")}`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `${provider.name}：查询失败（${reason}）`;
	}
}

export function registerQuota(pi: ExtensionAPI, fetcher: typeof fetch = fetch): void {
	let inFlight: AbortController | undefined;
	pi.registerCommand("quota", {
		description: "查询 Codex、Claude 和 Fable 的订阅剩余额度，不打断当前任务",
		handler: async (args, ctx) => {
			if (args.trim()) return ctx.ui.notify("用法：/quota", "warning");
			if (inFlight) return ctx.ui.notify("额度正在查询，请稍候", "info");
			// 在首个 await 前占住唯一请求槽，重复命令不会叠加抓取。
			const owner = new AbortController();
			inFlight = owner;
			const { ui, modelRegistry } = ctx;
			ui.notify("正在查询订阅额度…", "info");
			try {
				const results = await Promise.all(PROVIDERS.map((provider) => query(provider, modelRegistry, owner.signal, fetcher)));
				if (inFlight !== owner) return;
				const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
				ui.notify(`订阅剩余额度 · 查询于 ${time}\n${results.join("\n")}`, "info");
			} finally {
				if (inFlight === owner) inFlight = undefined;
			}
		},
	});
	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
	});
}
