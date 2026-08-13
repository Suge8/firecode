/**
 * FireCode：个人 pi 定制层——启动横幅、状态栏、工具行渲染、预设、会话命名，
 * Claude 归因与 OpenAI 请求层。各功能可在 config.json 的 features 里单独关闭。
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

const REGISTRARS: Record<Feature, (pi: ExtensionAPI) => void> = {
	header: registerHeader,
	statusbar: registerStatusBar,
	tools: registerToolRendering,
	presets: registerPresets,
	rename: registerSessionName,
	stats: registerStats,
	claudeSub: registerClaudeSub,
	openaiNative: registerOpenAINative,
	review: registerReview,
};

export default function firecode(pi: ExtensionAPI): void {
	const { config, problems } = loadConfig();

	for (const [feature, register] of Object.entries(REGISTRARS)) {
		if (config.features[feature as Feature] !== false) register(pi);
	}

	if (problems.length === 0) return;
	pi.on("session_start", (_event, ctx) => {
		for (const problem of problems) ctx.ui.notify(`FireCode 配置：${problem}`, "warning");
	});
}
