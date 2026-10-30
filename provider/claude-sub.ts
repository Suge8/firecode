/**
 * Claude 订阅适配（Anthropic OAuth 会话）：
 * - 归因：仅订阅（OAuth）会话。请求头 user-agent 用本机 Claude Code 的版本号覆盖宿主的固定版本，与系统提示词首块 billing header
 *   里的 cc_version 保持一致（宿主已为 OAuth 请求带 x-app，不重复）；billing header 缺失时注入，已存在则原样通过。
 *   API key 与兼容代理的 anthropic 请求不带这些标识：头随当前凭据类型注册，登出订阅改用 API key 后在下一次提示前清掉。
 * - 换发自愈：Anthropic 换发订阅令牌即吊销旧令牌，换发时仍在途的请求以 401 落空；宿主不重试 401，
 *   这里把该失败从模型投影中省略并续跑一次，续跑请求由宿主重读令牌文件拿到新令牌。重试仍 401 即登录真失效，照常落定。
 *   是否已重试只看会话分支，不留内存标记；不交给角色 fallback，换模型解决不了令牌换发。宿主将来自行重试这类 401 时删除本自愈。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { textOf } from "../format.js";
import { isRecord } from "../jsonc.js";
import { physicalModel } from "../model-route.js";
import { msg } from "./messages.js";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.281";
const BILLING_SALT = "59cf53e54c78";

type TextBlock = {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

interface PayloadLike {
	system?: unknown;
	messages?: unknown;
}

function isTextBlock(value: unknown): value is TextBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function shouldApply(ctx: ExtensionContext): boolean {
	const model = physicalModel(ctx.model);
	return !!model && model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
}

function detectClaudeCodeVersion(): string {
	const explicit = process.env.PI_CLAUDE_CODE_VERSION;
	if (explicit) return explicit;

	try {
		const output = execFileSync("claude", ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		});
		const match = output.match(/\b\d+\.\d+\.\d+\b/);
		if (match) return match[0];
	} catch {
		// 本地未装 Claude Code 时用回退版本号，不阻塞启动。
	}

	return FALLBACK_CLAUDE_CODE_VERSION;
}

let detectedVersion: string | undefined;

function firstUserText(messages: unknown): string {
	const list = Array.isArray(messages) ? messages : [];
	const firstUser = list.find((message) => isRecord(message) && message.role === "user");
	return isRecord(firstUser) ? textOf(firstUser.content) : "";
}

function versionSuffix(messageText: string, claudeCodeVersion: string): string {
	const sampled = [4, 7, 20].map((index) => messageText[index] ?? "0").join("");
	return createHash("sha256")
		.update(`${BILLING_SALT}${sampled}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
}

function buildBillingHeader(messages: unknown, claudeCodeVersion: string): string {
	const version = `${claudeCodeVersion}.${versionSuffix(firstUserText(messages), claudeCodeVersion)}`;
	return `${BILLING_PREFIX} cc_version=${version}; cc_entrypoint=cli; cch=00000;`;
}

function isRevokedTokenFailure(entry: SessionEntry | undefined): entry is SessionMessageEntry {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
	const { stopReason, provider, errorMessage } = entry.message;
	return stopReason === "error" && provider === "anthropic" && !!errorMessage?.includes('"authentication_error"');
}

/** 分支上最后两条消息；中间的 context_edit 等非消息条目不算。 */
function lastTwoMessages(branch: SessionEntry[]): [SessionEntry | undefined, SessionEntry | undefined] {
	let last: SessionEntry | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type !== "message") continue;
		if (last) return [branch[index], last];
		last = branch[index];
	}
	return [undefined, last];
}

export function registerClaudeSub(pi: ExtensionAPI): void {
	// 探测同步起 `claude --version` 子进程：只在功能开启时做，且整个进程只做一次（子会话也会注册本功能）。
	const claudeCodeVersion = (detectedVersion ??= detectClaudeCodeVersion());
	// 供应商头注册对该供应商的全部请求生效，按当前凭据同步：订阅凭据时注册，换成 API key 后清空（headers: {} 整体替换，
	// 同一供应商上别的扩展注册的头也随之清掉，这只发生在订阅凭据登出之后）。
	let identified = false;
	const sync = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.model?.api === "pi-virtual") return;
		const wanted = shouldApply(ctx);
		if (wanted === identified) return;
		identified = wanted;
		pi.registerProvider("anthropic", { headers: wanted ? { "user-agent": `claude-cli/${claudeCodeVersion} (external, cli)` } : {} });
	};
	pi.on("session_start", sync);
	pi.on("model_select", sync);
	pi.on("before_agent_start", sync);

	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.api === "pi-virtual" && shouldApply(ctx))
			event.headers["user-agent"] = `claude-cli/${claudeCodeVersion} (external, cli)`;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!shouldApply(ctx) || !isRecord(payload)) return;

		const { system, messages } = payload as PayloadLike;
		const blocks = Array.isArray(system) ? system : [];
		if (blocks.some((block) => isTextBlock(block) && block.text.startsWith(BILLING_PREFIX))) return;

		const header: TextBlock = { type: "text", text: buildBillingHeader(messages, claudeCodeVersion) };
		return { ...payload, system: [header, ...blocks] };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error" || !shouldApply(ctx)) return;
		const [previous, failure] = lastTwoMessages(ctx.sessionManager.getBranch());
		// 紧挨着的上一条也是同类失败，说明这次已是自愈重试：登录真失效，交回宿主照常落定。
		if (!isRevokedTokenFailure(failure) || isRevokedTokenFailure(previous)) return;
		ctx.ui.notify(msg.tokenReissued, "info");
		return { entries: [...event.entries, { type: "context_edit", targetId: failure.id, replacement: null }], continue: true };
	});
}
