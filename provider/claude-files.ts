/**
 * Claude 图片走 Files API：发往 Anthropic 的请求里，每张内嵌 base64 图片换成上传一次得到的 file_id。
 * 多轮对话每轮重发完整历史，内嵌图片每轮重传，请求体随截图数线性涨（实测 84 张截图的会话约 11MB/轮，
 * 慢上行链路上单轮数分钟）；换成 file_id 后每张图只上传一次，请求体只剩文字。图片字节原样上传，画质不变。
 *
 * - 只改发出的请求，不改会话历史：会话里仍存原图，换模型、换供应商、导出都不受影响。
 * - 同一会话里同一张图永远换成同一个 file_id：映射按内容哈希记在会话分支的自定义条目里（会话是唯一事实源，
 *   重启、续开、fork 照用）。每轮请求的历史前缀因此逐字节不变——Opus 5.5 等模型把思考块绑定在前缀上，
 *   提示缓存也按前缀命中，改写旧图会让两者从改动处起失效，所以这里绝不删图、不重编码旧图。
 * - file_id 属于上传它的组织：映射带凭据类型，订阅与 API key 互换后按新凭据重新上传。
 * - 上传失败的图这一轮原样内嵌并提示；下一轮上传成功后它的表示变了，前缀从这张图起失效一次。
 * - 上传不设过期：历史里引用的文件一旦失效，这个会话之后的请求都会被拒。
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../jsonc.js";
import { msg } from "./messages.js";

const ENTRY_TYPE = "firecode-claude-file";
const ANTHROPIC_VERSION = "2023-06-01";

type Uploaded = { hash: string; fileId: string; oauth: boolean };
type Base64Source = { type: "base64"; media_type: string; data: string };
type ImageBlock = { type: "image"; source: Base64Source };

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

function knownFiles(ctx: ExtensionContext, oauth: boolean): Map<string, string> {
	const known = new Map<string, string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const uploaded = entry.data as Uploaded;
		if (uploaded.oauth === oauth) known.set(uploaded.hash, uploaded.fileId);
	}
	return known;
}

/** 用当前模型的凭据与地址上传；鉴权按请求解析一次，供这一请求里的全部新图共用。 */
async function uploader(ctx: ExtensionContext, oauth: boolean): Promise<(hash: string, source: Base64Source) => Promise<string>> {
	const model = ctx.model!;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const credential: Record<string, string> = oauth
		? { authorization: `Bearer ${auth.apiKey}` }
		: { "x-api-key": auth.apiKey ?? "" };
	const url = `${(auth.baseUrl ?? model.baseUrl).replace(/\/$/, "")}/v1/files`;
	const headers = { ...model.headers, ...auth.headers, ...credential, "anthropic-version": ANTHROPIC_VERSION };

	return async (hash, source) => {
		const form = new FormData();
		const extension = source.media_type.split("/")[1];
		form.append("file", new Blob([Buffer.from(source.data, "base64")], { type: source.media_type }), `${hash}.${extension}`);
		const response = await fetch(url, { method: "POST", headers, body: form });
		if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
		return ((await response.json()) as { id: string }).id;
	};
}

export function registerClaudeFiles(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event, ctx) => {
		const payload = event.payload;
		if (ctx.model?.provider !== "anthropic" || !isRecord(payload) || !Array.isArray(payload.messages)) return;

		const oauth = ctx.modelRegistry.isUsingOAuth(ctx.model);
		const known = knownFiles(ctx, oauth);
		const hashes = new Map<string, string>();
		const hashOf = (data: string) => {
			let hash = hashes.get(data);
			if (!hash) hashes.set(data, (hash = createHash("sha256").update(data).digest("hex")));
			return hash;
		};

		const pending = new Map<string, Base64Source>();
		mapImages(payload.messages, ({ source }) => {
			const hash = hashOf(source.data);
			if (!known.has(hash)) pending.set(hash, source);
		});
		if (hashes.size === 0) return;

		let failure: string | undefined;
		const fail = (error: unknown) => void (failure ??= error instanceof Error ? error.message : String(error));
		if (pending.size > 0)
			await uploader(ctx, oauth).then(
				(upload) =>
					Promise.all(
						[...pending].map(([hash, source]) =>
							upload(hash, source).then((fileId) => {
								known.set(hash, fileId);
								pi.appendEntry<Uploaded>(ENTRY_TYPE, { hash, fileId, oauth });
							}, fail),
						),
					),
				fail,
			);
		if (failure) ctx.ui.notify(msg.imageUploadFailed(failure), "warning");

		return {
			...payload,
			messages: mapImages(payload.messages, (block) => {
				const fileId = known.get(hashOf(block.source.data));
				return fileId ? { ...block, source: { type: "file", file_id: fileId } } : block;
			}),
		};
	});
}
