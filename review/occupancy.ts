/**
 * 审查占用频道：review 是唯一发布者，busy.ts（进而 herdr 投影）、输入框外壳与观察员订阅；频道名与 payload 只在这里定义。
 * 消费者按 active 取当前是否持有，所以进度变化不能靠重发 true：持有时带活的 progress 访问器，
 * 外壳每次绘制调用它。progress 是进程内求值函数，频道不可序列化转发。
 */
export const OCCUPANCY_CHANNEL = "firecode:review";

/** 审查此刻在哪一步：排队等回合结束、审查者在审、顾问介入、执行模型修复、总结回合。 */
export type ReviewStage = "queued" | "reviewing" | "advisor" | "fixing" | "summarizing";

export interface ReviewProgress {
	stage: ReviewStage;
	/** 当前轮次；排队时为 0。 */
	round: number;
	/** 本轮通过 / 阻断 / 审查者总数；只有 reviewing 有意义。 */
	passed: number;
	blocked: number;
	total: number;
}

export type OccupancyPayload =
	| { active: true; progress: () => ReviewProgress | undefined }
	| { active: false };
