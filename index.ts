/**
 * FireCode：个人 pi 定制层——启动横幅、状态栏、工具行渲染、预设、会话命名，
 * Claude 归因、OpenAI 请求层与对抗审查。各功能可在 config.jsonc 的 features 里单独关闭。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Feature, loadConfig } from "./config.js";
import { registerHeader } from "./header.js";
import { registerClaudeSub } from "./provider/claude-sub.js";
import { registerOpenAINative } from "./provider/openai-native/index.js";
import { registerPresets } from "./session/presets.js";
import { registerSessionName } from "./session/rename.js";
import { registerStats } from "./session/stats.js";
import { registerStatusBar } from "./statusbar/index.js";
import { registerToolRendering } from "./tools/index.js";
import { registerReview } from "./review/index.js";

const REGISTRARS: Record<Exclude<Feature, "review">, (pi: ExtensionAPI) => void> = {
	header: registerHeader,
	statusbar: registerStatusBar,
	tools: registerToolRendering,
	presets: registerPresets,
	rename: registerSessionName,
	stats: registerStats,
	claudeSub: registerClaudeSub,
	openaiNative: registerOpenAINative,
};

export default function firecode(pi: ExtensionAPI): void {
	const { config, problems } = loadConfig();

	// 会触发执行模型续跑的模块必须先注册；runner 按注册顺序 await 同类事件 handler。
	// review 最后注册，agent_settled 时先让续跑方决策，再判断能否开审。
	for (const [feature, register] of Object.entries(REGISTRARS)) {
		if (config.features[feature as Exclude<Feature, "review">] !== false) register(pi);
	}
	// 历史卡渲染与 checkpoint 收口不受 feature 开关控制；开关只控制命令和执行循环。
	registerReview(pi, config.features.review !== false);

	if (problems.length === 0) return;
	pi.on("session_start", (_event, ctx) => {
		for (const problem of problems) ctx.ui.notify(`FireCode 配置：${problem}`, "warning");
	});
}
