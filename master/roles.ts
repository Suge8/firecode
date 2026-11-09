/**
 * 角色表：配置的角色里此刻能解析出模型的那些。每次会话开始核对一次、交给那一次的运行时，不原地改；
 * 角色查找、“可用角色”的报错口径与提示词里的角色表都只读这一份。（子代理名册是另一回事，见 roster.ts。）
 */
import type { MasterRole, ModelAtom, ThinkingLevelValue } from "../config.js";
import type { InProcessSessionPool } from "../spawn.js";
import { msg } from "./messages.js";

export class Roles {
	private constructor(
		readonly available: readonly MasterRole[],
		private readonly missing: readonly MasterRole[],
		private readonly pool: InProcessSessionPool,
	) {}

	/** 逐个解析模型链：一个模型都解析不出的角色不可用（不进提示词，派发时报错）。 */
	static async check(configured: readonly MasterRole[], pool: InProcessSessionPool): Promise<Roles> {
		const checks = await Promise.all(configured.map(async (role) => !!(await pool.resolveChain(role.models))));
		return new Roles(configured.filter((_role, index) => checks[index]), configured.filter((_role, index) => !checks[index]), pool);
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

	/** 按名取可用角色；不在表里就报错并列出可用的。 */
	require(role: string): MasterRole {
		const found = this.available.find((candidate) => candidate.role === role);
		if (!found) throw this.gone(role);
		return found;
	}

	/** 派发前核对角色此刻仍能解析出模型（凭据可能在会话中途失效），返回链上选中的模型原子。 */
	async resolve(role: MasterRole, override?: ThinkingLevelValue): Promise<ModelAtom> {
		const selected = await this.pool.resolveChain(role.models, override);
		if (!selected) throw this.gone(role.role);
		return selected;
	}

	private gone(role: string): Error {
		return new Error(msg.run.roleGone(role, this.available.filter((candidate) => candidate.role !== role).map((candidate) => candidate.role).join(", ")));
	}
}
