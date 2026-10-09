/** 宿主扩展状态（setStatus）里各功能发布的键：发布方与输入框外壳（statusbar/）共用这一份，外壳按键读取串并原样组合。 */
export const STATUS_KEYS = {
	watcher: "watcher",
	master: "master",
	preset: "preset",
	fast: "pi-openai-native-fast",
} as const;
