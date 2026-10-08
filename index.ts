/**
 * FireCode：个人 pi 定制层——启动横幅、状态栏、工具行渲染、预设、会话命名，
 * Claude 订阅适配、OpenAI 请求层、对抗审查与按需 Master。各功能可在 config.jsonc 的 features 里单独关闭。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, type Feature, loadConfig, seedConfig } from "./config.js";
import { registerHeader } from "./header.js";
import { registerClaudeSub } from "./provider/claude-sub.js";
import { registerOpenAINative } from "./provider/openai-native/index.js";
import { registerPresets } from "./session/presets.js";
import { registerHerdrProjection } from "./session/herdr-projection.js";
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
	stats: registerStats,
	claudeSub: registerClaudeSub,
	openaiNative: registerOpenAINative,
};

/** 只属于交互主会话的功能：子会话（Worker、观察员、审查者）没有界面与命令入口，注册了只会白占资源。 */
const MAIN_ONLY = new Set<SimpleFeature>(["header", "tools", "presets", "stats"]);

type FirecodeSessionRole = "main" | "worker" | "observer" | "reviewer" | "advisor";

export function registerFirecode(pi: ExtensionAPI, role: FirecodeSessionRole = "main"): void {
	let seeding = seedForMainSession(role);
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
	// herdr 投影没有开关：herdr 之外自我禁用。
	registerHerdrProjection(pi, subsession);
	// 历史卡渲染与 checkpoint 收口不受 feature 开关控制；开关只控制命令和执行循环。
	// features 整节类型错误会被安全回退成全关，但那是配置坏而非用户关闭：不封存 checkpoint。
	registerReview(pi, reviewEnabled, featuresBroken);

	if (problems.length === 0 && !seeding) return;
	pi.on("session_start", (_event, ctx) => {
		if (seeding) {
			// 无界面（print 等）时成功提示无处可显示，但失败必须到 stderr，不能静默。
			if (ctx.hasUI) ctx.ui.notify(seeding.message, seeding.level);
			else if (seeding.level === "error") console.error(seeding.message);
			seeding = undefined;
		}
		if (problems.length) ctx.ui.notify(`FireCode 配置有问题：${problems.join("；")}`, "warning");
	});
}

type SeedNotice = { message: string; level: "info" | "error" };

/** 主会话加载时补默认配置，必须先于 loadConfig；子会话不写盘。提示留到 session_start 有 UI 时显示。 */
function seedForMainSession(role: FirecodeSessionRole): SeedNotice | undefined {
	if (role !== "main") return undefined;
	try {
		return seedConfig()
			? { message: `已生成配置：${CONFIG_PATH}，按需修改模型后重启生效`, level: "info" }
			: undefined;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { message: `无法生成配置：${CONFIG_PATH}（${reason}）`, level: "error" };
	}
}

export default function firecode(pi: ExtensionAPI): void {
	registerFirecode(pi, currentSubsessionRole() ?? "main");
}
