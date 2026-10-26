/**
 * Claude 图片走 Files API：发往 Anthropic 的请求里，每张内嵌 base64 图片换成上传一次得到的 file_id。
 * 多轮对话每轮重发完整历史，内嵌图片每轮重传，请求体随截图数线性涨（实测 84 张截图的会话约 11MB/轮，
 * 慢上行链路上单轮数分钟）；换成 file_id 后每张图只上传一次，请求体只剩文字。图片字节原样上传，画质不变。
 *
 * - 只改发出的请求，不改会话历史：会话里仍存原图，换模型、换供应商、导出都不受影响。
 * - 同一会话里同一张图永远换成同一个 file_id：映射按内容哈希记在会话分支的自定义条目里（会话是唯一事实源，
 *   重启、续开、fork 照用）。每轮请求的历史前缀因此逐字节不变——Opus 5.5 等模型把思考块绑定在前缀上，
 *   提示缓存也按前缀命中，改写旧图会让两者从改动处起失效，所以这里绝不删图、不重编码旧图。
 * - file_id 只在上传它的组织里有效：映射记组织 id（凭据第一次带图时问一次接口的响应头，按凭据记在内存），
 *   换号、订阅与 API key 互换后只认新组织的映射，旧图按新凭据重新上传一次。不带组织 id 的旧版映射一律不认。
 * - 同一组织里文件仍可能失效（被删除）：请求报某个 file_id 不存在时，这条映射作废（记一条 fileId 为 null 的条目），
 *   失败的回复从模型投影里省略并续跑一次，续跑时这张图重新上传。只对仍在用的映射续跑，所以不会循环。
 * - 上传失败的图这一轮原样内嵌并提示；下一轮上传成功后它的表示变了，前缀从这张图起失效一次。
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../jsonc.js";
import { msg } from "./messages.js";

const ENTRY_TYPE = "firecode-claude-file";
const ANTHROPIC_VERSION = "2023-06-01";
const ORGANIZATION_HEADER = "anthropic-organization-id";
const FILE_GONE = /File `(file_\w+)` not found/;

/** fileId 为 null 表示这张图在该组织里的文件已失效。 */
type FileEntry = { hash: string; org: string; fileId: string | null };
type Base64Source = { type: "base64"; media_type: string; data: string };
type ImageBlock = { type: "image"; source: Base64Source };
type Client = { org: string; upload: (hash: string, source: Base64Source) => Promise<string> };

function isBase64Image(block: unknown): block is ImageBlock {
	if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) return false;
	return block.source.type === "base64" && typeof block.source.data === "string";
}

/** 按块改写请求里的全部图片：用户消息内容与 tool_result 内容两层。 */
function mapImages(messages: unknown[], fn: (block: ImageBlock) => unknown): unknown[] {
	const mapBlocks = (blocks: unknown[]): unknown[] =>
		blocks.map((block) => {
			if (isBase64Image(block)) return fn(block);
			if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content))
				return { ...block, content: mapBlocks(block.content) };
			return block;
		});
	return messages.map((message) =>
		isRecord(message) && Array.isArray(message.content) ? { ...message, content: mapBlocks(message.content) } : message,
	);
}

function fileEntries(branch: SessionEntry[]): FileEntry[] {
	return branch.flatMap((entry) => (entry.type === "custom" && entry.customType === ENTRY_TYPE ? [entry.data as FileEntry] : []));
}

/** 该组织下每张图当前的 file_id：分支上后写的条目覆盖先写的。 */
function knownFiles(entries: FileEntry[], org: string): Map<string, string> {
	const known = new Map<string, string>();
	for (const entry of entries) {
		if (entry.org !== org) continue;
		if (entry.fileId) known.set(entry.hash, entry.fileId);
		else known.delete(entry.hash);
	}
	return known;
}

export function registerClaudeFiles(pi: ExtensionAPI): void {
	// 凭据 → 组织 id。令牌换发后凭据变了，重新问一次；只留最近一份。
	let organization: { apiKey: string; org: Promise<string> } | undefined;

	/** 用当前模型的凭据与地址建客户端；鉴权按请求解析一次，供这一请求里的全部新图共用。 */
	async function client(ctx: ExtensionContext): Promise<Client> {
		const model = ctx.model!;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const apiKey = auth.apiKey ?? "";
		const credential: Record<string, string> = ctx.modelRegistry.isUsingOAuth(model)
			? { authorization: `Bearer ${apiKey}` }
			: { "x-api-key": apiKey };
		const url = `${(auth.baseUrl ?? model.baseUrl).replace(/\/$/, "")}/v1/files`;
		const headers = { ...model.headers, ...auth.headers, ...credential, "anthropic-version": ANTHROPIC_VERSION };

		if (organization?.apiKey !== apiKey) {
			const org = fetch(`${url}?limit=1`, { headers }).then(async (response) => {
				const id = response.headers.get(ORGANIZATION_HEADER);
				if (!response.ok || !id) throw new Error(`HTTP ${response.status} ${await response.text()}`);
				return id;
			});
			const current = (organization = { apiKey, org });
			org.catch(() => {
				if (organization === current) organization = undefined;
			});
		}
		return {
			org: await organization!.org,
			upload: async (hash, source) => {
				const form = new FormData();
				const extension = source.media_type.split("/")[1];
				form.append("file", new Blob([Buffer.from(source.data, "base64")], { type: source.media_type }), `${hash}.${extension}`);
				const response = await fetch(url, { method: "POST", headers, body: form });
				if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
				return ((await response.json()) as { id: string }).id;
			},
		};
	}

	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload;
		if (ctx.model?.provider !== "anthropic" || !isRecord(payload) || !Array.isArray(payload.messages)) return;

		const hashes = new Map<string, string>();
		const hashOf = (data: string) => {
			let hash = hashes.get(data);
			if (!hash) hashes.set(data, (hash = createHash("sha256").update(data).digest("hex")));
			return hash;
		};
		const sources = new Map<string, Base64Source>();
		mapImages(payload.messages, ({ source }) => sources.set(hashOf(source.data), source));
		if (sources.size === 0) return;

		let known = new Map<string, string>();
		let failure: string | undefined;
		const fail = (error: unknown) => void (failure ??= error instanceof Error ? error.message : String(error));
		await client(ctx).then(async ({ org, upload }) => {
			known = knownFiles(fileEntries(ctx.sessionManager.getBranch()), org);
			await Promise.all(
				[...sources].filter(([hash]) => !known.has(hash)).map(([hash, source]) =>
					upload(hash, source).then((fileId) => {
						known.set(hash, fileId);
						pi.appendEntry<FileEntry>(ENTRY_TYPE, { hash, org, fileId });
					}, fail),
				),
			);
		}, fail);
		if (failure) ctx.ui.notify(msg.imageUploadFailed(failure), "warning");

		return {
			...payload,
			messages: mapImages(payload.messages, (block) => {
				const fileId = known.get(hashOf(block.source.data));
				return fileId ? { ...block, source: { type: "file", file_id: fileId } } : block;
			}),
		};
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error") return;
		const branch = ctx.sessionManager.getBranch();
		const failure = branch.findLast((entry) => entry.type === "message");
		if (failure?.type !== "message" || failure.message.role !== "assistant" || failure.message.provider !== "anthropic") return;
		const fileId = failure.message.errorMessage?.match(FILE_GONE)?.[1];
		const entries = fileEntries(branch);
		const gone = fileId && entries.find((entry) => entry.fileId === fileId);
		// 只作废仍在用的映射：已作废过或不是本扩展上传的文件，续跑也解决不了，照常落定。
		if (!gone || knownFiles(entries, gone.org).get(gone.hash) !== fileId) return;
		ctx.ui.notify(msg.imageFileGone, "info");
		return {
			entries: [
				...event.entries,
				{ type: "context_edit", targetId: failure.id, replacement: null },
				{ type: "custom", customType: ENTRY_TYPE, data: { hash: gone.hash, org: gone.org, fileId: null } satisfies FileEntry },
			],
			continue: true,
		};
	});
}
