/**
 * 当前模型提供哪些加速档：/fast、状态栏与请求发送共用这一个判定。
 * 网关（如 magpie）的模型列表按账号逐模型给出 service_tiers，向它要；
 * OpenAI 与 xAI 自己的列表不带档位（ChatGPT 订阅的那份目录在不公开保证的私有路由上），按供应商给定，由用户自己选。
 */
import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SERVICE_TIERS, type ServiceTier } from "../../../config.js";
import { isRecord } from "../../../jsonc.js";
import { isOpenAIResponsesApi } from "./native-details.js";

const VENDOR_TIERS: Record<string, readonly ServiceTier[]> = {
	openai: SERVICE_TIERS,
	"openai-codex": SERVICE_TIERS,
	xai: ["fast"],
};

/** 请求与模型列表里的档位 id：Fast 在 OpenAI 协议里叫 priority。 */
export const WIRE_TIER: Record<ServiceTier, string> = { fast: "priority", ultrafast: "ultrafast" };

const LIST_TIMEOUT_MS = 10_000;
/** 套餐或网关的档位变了，最迟这么久后生效。 */
const LIST_TTL_MS = 5 * 60_000;

/** 地址 + 全部请求头（凭据、项目头）→ 那份列表里每个模型的档位。成功的留 LIST_TTL_MS，失败的不留，下次再问。 */
const catalogs = new Map<string, { at: number; tiers: Promise<Map<string, ServiceTier[]>> }>();

async function fetchCatalog(url: string, headers: Record<string, string>): Promise<Map<string, ServiceTier[]>> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.data)) throw new Error(`unexpected model list: ${JSON.stringify(body).slice(0, 200)}`);
	const tiers = new Map<string, ServiceTier[]>();
	for (const entry of body.data) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.service_tiers)) continue;
		const ids = new Set(entry.service_tiers.map((tier: unknown) => (isRecord(tier) ? tier.id : tier)));
		tiers.set(entry.id, SERVICE_TIERS.filter((tier) => ids.has(WIRE_TIER[tier])));
	}
	return tiers;
}

/** 某个模型发请求用的地址与凭据从哪取：会话里问它的模型注册表，不开会话的后台请求问模型运行时。 */
export type RequestAuth = (model: Model<Api>) => Promise<ModelAuth>;
export const sessionAuth = (ctx: ExtensionContext): RequestAuth => async (model) => {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	return auth;
};
export const runtimeAuth = (runtime: ModelRuntime): RequestAuth => async (model) => (await runtime.getAuth(model))?.auth ?? {};

/** 从慢到快排；不是 OpenAI 线格式（Responses / Chat Completions）的模型没有档位。列表读不到时抛错，由调用处告诉用户。 */
export async function offeredTiers(model: Model<Api>, requestAuth: RequestAuth): Promise<readonly ServiceTier[]> {
	if (!isOpenAIResponsesApi(model.api) && model.api !== "openai-completions") return [];
	const vendor = VENDOR_TIERS[model.provider];
	if (vendor) return vendor;
	const auth = await requestAuth(model);
	const url = `${(auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "")}/models`;
	// null 是宿主的「删掉这个头」。
	const merged = { ...model.headers, ...auth.headers, ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}) };
	const headers = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null).sort());
	const key = JSON.stringify([url, headers]);
	const cached = catalogs.get(key);
	let catalog = cached && Date.now() - cached.at < LIST_TTL_MS ? cached.tiers : undefined;
	if (!catalog) {
		const entry = { at: Date.now(), tiers: fetchCatalog(url, headers) };
		catalogs.set(key, entry);
		entry.tiers.catch(() => {
			if (catalogs.get(key) === entry) catalogs.delete(key);
		});
		catalog = entry.tiers;
	}
	return (await catalog).get(model.id) ?? [];
}

/** 选的档这个模型没有时：Ultrafast 落到 Fast（与网关在套餐不含 Ultrafast 时的做法一致），否则不加速。 */
export function effectiveTier(chosen: ServiceTier | undefined, offered: readonly ServiceTier[]): ServiceTier | undefined {
	if (!chosen) return undefined;
	if (offered.includes(chosen)) return chosen;
	return chosen === "ultrafast" && offered.includes("fast") ? "fast" : undefined;
}
