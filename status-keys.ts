/** 宿主扩展状态（setStatus）里各功能发布的键：发布方与输入框外壳（statusbar/）共用这一份，外壳按键读取串并原样组合。 */
export const STATUS_KEYS = {
	master: "master",
	/** 主会话的进展行（background/progress.ts）：回合进行时替换上边框的“处理中”。 */
	progress: "firecode-progress",
	/** 闲置压缩的预告（background/idle.ts）：接在下边框上下文占用之后。 */
	idleCompaction: "firecode-idle-compaction",
	fast: "pi-openai-native-fast",
} as const;
