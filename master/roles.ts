/**
 * 角色表：每次会话开始核对一次哪些配置的角色能解析出模型、交给那一次的运行时，不原地改；只决定提示词里的角色表与不可用告警
 * （系统提示是缓存前缀，会话内不变）。派发只认配置里的角色名，不拿这份核对挡：凭据会在会话中途增减，模型解析与凭据核对
 * 只在开会话后第一次请求时由路由做，解析不出按失败落定。（子代理名册是另一回事，见 roster.ts。）
 */
import type { MasterRole } from "../config.js";
import type { InProcessSessionPool } from "../spawn.js";
import { msg } from "./messages.js";

export class Roles {
	private constructor(
		readonly available: readonly MasterRole[],
		private readonly missing: readonly MasterRole[],
	) {}

	/** 逐个解析模型链：一个模型都解析不出的角色不可用（不进提示词，派发时报错）。 */
	static async check(configured: readonly MasterRole[], pool: InProcessSessionPool): Promise<Roles> {
		const checks = await Promise.all(configured.map(async (role) => !!(await pool.resolveChain(role.models))));
		return new Roles(configured.filter((_role, index) => checks[index]), configured.filter((_role, index) => !checks[index]));
	}

	/** 不可用角色的告警（角色与它的候选模型）；都可用时 undefined。 */
	get warning(): string | undefined {
		if (!this.missing.length) return undefined;
		return msg.roles.unavailable(this.missing.map((role) => `${role.role}: ${role.models.map((atom) => atom.model).join(", ")}`).join("; "));
	}

	/** 提示词里的角色表。 */
	get promptText(): string {
		return this.available.map((entry) => msg.roles.entry(entry.role, entry.use)).join(msg.roles.join);
	}

	/** 按名取配置的角色；不在配置里（配置改过、档案还是旧角色）就报错并列出此刻可用的。 */
	require(role: string): MasterRole {
		const found = [...this.available, ...this.missing].find((candidate) => candidate.role === role);
		if (!found) throw new Error(msg.run.roleGone(role, this.available.map((candidate) => candidate.role).join(", ")));
		return found;
	}
}
