/**
 * FireCode：个人 pi 定制层——启动横幅、状态栏、工具行渲染、预设、会话命名，
 * Claude 订阅适配、OpenAI 请求层、对抗审查与按需 Master。各功能可在 config.jsonc 的 features 里单独关闭。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_MISSING, CONFIG_PATH, type Feature, loadConfig, seedConfig } from "./config.js";
import { registerHeader } from "./header.js";
import { registerClaudeSub } from "./provider/claude-sub.js";
import { registerOpenAINative } from "./provider/openai-native/index.js";
import { registerPresets } from "./session/presets.js";
import { registerHerdrDisplay } from "./session/herdr-display.js";
import { registerSessionName } from "./session/rename.js";
import { registerStats } from "./session/stats.js";
import { registerStatusBar } from "./statusbar/index.js";
import { registerToolRendering } from "./tools/index.js";
import { registerReview } from "./review/index.js";
import { registerMaster } from "./master/index.js";
import { currentSubsessionRole } from "./master/role.js";
import { registerWatcher } from "./watcher/index.js";
import { registerRoundRecorder } from "./round-recorder.js";
import { registerTruncatedWriteGuard } from "./truncated-write.js";

type SimpleFeature = Exclude<Feature, "review" | "master" | "watcher" | "statusbar">;

const REGISTRARS: Record<SimpleFeature, (pi: ExtensionAPI) => void> = {
	header: registerHeader,
	tools: registerToolRendering,
	presets: registerPresets,
	rename: registerSessionName,
	stats: registerStats,
	claudeSub: registerClaudeSub,
	openaiNative: registerOpenAINative,
};

/** 只属于交互主会话的功能：子会话（Worker、观察员、审查者）没有界面与命令入口，注册了只会白占资源。 */
const MAIN_ONLY = new Set<SimpleFeature>(["header", "tools", "presets", "rename", "stats"]);

type FirecodeSessionRole = "main" | "worker" | "observer" | "reviewer" | "advisor";

export function registerFirecode(pi: ExtensionAPI, role: FirecodeSessionRole = "main"): void {
	const { config, problems, featuresBroken } = loadConfig();
	const subsession = role !== "main";
	const reviewEnabled = config.features.review !== false;
	// 轮记录不属于任何可关的功能：每个会话（含子代理）都写，界面、Master 耗时与子代理视图都只读它。
	registerRoundRecorder(pi);
	registerTruncatedWriteGuard(pi);
	for (const [feature, register] of Object.entries(REGISTRARS) as [SimpleFeature, (pi: ExtensionAPI) => void][]) {
		if (config.features[feature] === false || (subsession && MAIN_ONLY.has(feature))) continue;
		register(pi);
	}
	if (config.features.statusbar !== false) registerStatusBar(pi, subsession);
	if (config.features.watcher !== false) registerWatcher(pi, {}, subsession);
	if (config.features.master !== false) registerMaster(pi, {}, subsession);
	// herdr 显示投影没有开关：herdr 之外自我禁用，只写显示层。
	registerHerdrDisplay(pi, subsession);
	// 历史卡渲染与 checkpoint 收口不受 feature 开关控制；开关只控制命令和执行循环。
	// features 整节类型错误会被安全回退成全关，但那是配置坏而非用户关闭：不封存 checkpoint。
	registerReview(pi, reviewEnabled, featuresBroken);

	// 首次交互启动补默认配置：只有交互主会话写盘（子会话、print/rpc 不写），运行模式到 session_start 才知道。
	if (problems.length === 0) return;
	let seeded = false;
	pi.on("session_start", (_event, ctx) => {
		if (!seeded && !subsession && ctx.mode === "tui" && problems.includes(CONFIG_MISSING)) seeded = trySeed(ctx);
		const remaining = seeded ? problems.filter((problem) => problem !== CONFIG_MISSING) : problems;
		if (remaining.length) ctx.ui.notify(`FireCode 配置有问题：${remaining.join("；")}`, "warning");
	});
}

function trySeed(ctx: ExtensionContext): boolean {
	try {
		if (!seedConfig()) return false;
		ctx.ui.notify(`已生成配置：${CONFIG_PATH}，按需修改模型后重启生效`, "info");
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`无法生成配置：${CONFIG_PATH}（${reason}）`, "error");
		return false;
	}
}

export default function firecode(pi: ExtensionAPI): void {
	registerFirecode(pi, currentSubsessionRole() ?? "main");
}
