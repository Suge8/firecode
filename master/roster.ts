/**
 * 子代理名册：同进程里其他扩展（如 CuePad 桥）读的稳定接口。Master 在子代理的状态、动作或审查进度变化时，
 * 把整份名册发布在 `firecode:subagents` 频道（`{ workers }`，按启动序；停用时发空名册）。名册只是活动列表的投影，
 * 分组与动作文字取自 activity-list.ts 的 `workerPhase`，读者不要自己从会话文件推导。
 */
import { workerPhase, type ActivityFacts, type RowKind } from "./activity-list.js";

export const SUBAGENTS_CHANNEL = "firecode:subagents";

/** 活动列表的分组减去“卡住”（卡住仍是在跑，要靠计时才判得出，名册不发时间驱动的变化）。 */
export type SubagentState = Exclude<RowKind, "stuck">;

export interface SubagentInfo {
	name: string;
	/** 派发角色，取自角色表。 */
	role: string;
	/** 实际使用的模型原子（`provider/model`）与思考档。 */
	model: string;
	thinking: string;
	state: SubagentState;
	/** 在做什么的一句话（界面语言）：当前工具、审查进度，落定后是结果首句或失败原因；空闲为空串。 */
	action: string;
	/** 本次运行开始（Date.now 毫秒）；空闲且没有运行过时没有。 */
	startedAt?: number;
	/** 落定时刻；只有 done、failed、interrupted 有。 */
	settledAt?: number;
}

export interface SubagentsPayload {
	workers: SubagentInfo[];
}

/** 按启动序投影整份名册。 */
export function subagentInfos(facts: ActivityFacts, now: number): SubagentInfo[] {
	return facts.workers
		.map((worker, index) => {
			const { kind, action, startedAt, settledAt } = workerPhase(facts, index, now);
			return {
				launch: worker.launch,
				info: {
					name: worker.name,
					role: worker.role,
					model: worker.model,
					thinking: worker.thinking,
					state: kind === "stuck" ? "running" : kind,
					action,
					...(startedAt === undefined ? {} : { startedAt }),
					...(settledAt === undefined ? {} : { settledAt }),
				} satisfies SubagentInfo,
			};
		})
		.sort((a, b) => a.launch - b.launch)
		.map(({ info }) => info);
}
