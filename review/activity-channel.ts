/** 审查向输入框外壳发布主会话审查进度的进程内频道；payload 为 undefined 表示审查已结束。 */
export const REVIEW_ACTIVITY_CHANNEL = "firecode:review-activity";

export interface ReviewActivity {
	/** 通过进度如 `2/3`；没有可数进度的阶段（顾问、修复、总结）为空串。 */
	counts: string;
}
