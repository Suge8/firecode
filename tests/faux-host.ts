import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PI_AI_COMPAT_URL } from "./loader.ts";

const { registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;

/** 引用一个没有设置的环境变量：供应商与模型都在，但取不到凭据。 */
const MISSING_KEY = "$FIRECODE_TEST_UNSET_API_KEY";

/**
 * 把 faux 供应商装进测试 Agent 目录：模型原子 "provider/model" 写进真实的 models.json，
 * 池照生产路径读取它，模型解析、鉴权与流式都走宿主的真实链路，只有供应商的回答由测试脚本化。
 * keyless 里的供应商没有凭据（认证失败的场景）；windows 按模型原子改上下文窗口。调用方负责把 PI_CODING_AGENT_DIR 指向 agentDir。
 * faux 给回复盖上一个供应商名：只有一个供应商时盖它，宿主才能按回复找回产生它的物理模型（窗口、阈值）；多供应商时仍是 faux。
 */
export async function installFaux(agentDir: string, atoms: string[], keyless: string[] = [], windows: Record<string, number> = {}) {
	// 每次安装都是独立测试的供应商；同一次安装内的所有池仍共享冷却表。
	((globalThis as Record<symbol, unknown>)[Symbol.for("firecode.model-cooldowns")] as Map<string, unknown> | undefined)?.clear();
	const providerNames = new Set(atoms.map((atom) => atom.slice(0, atom.indexOf("/"))));
	const faux = registerFauxProvider(providerNames.size === 1 ? { provider: [...providerNames][0] } : {});
	const template = faux.getModel();
	const providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: unknown[] }> = {};
	for (const atom of atoms) {
		const slash = atom.indexOf("/");
		const provider = atom.slice(0, slash);
		providers[provider] ??= { baseUrl: template.baseUrl, api: faux.api, apiKey: keyless.includes(provider) ? MISSING_KEY : "faux-key", models: [] };
		providers[provider].models.push({
			id: atom.slice(slash + 1),
			name: atom,
			reasoning: template.reasoning,
			input: template.input,
			cost: template.cost,
			contextWindow: windows[atom] ?? template.contextWindow,
			maxTokens: template.maxTokens,
		});
	}
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }));
	return faux;
}
