import { defineMessages } from "../i18n.js";

export const msg = defineMessages({
	zh: {
		tokenReissued: "Claude 令牌刚换发，已自动重试",
		fastUnsupported: "当前模型不支持加速档",
		fastToggled: (enabled: boolean) => `加速档：${enabled ? "开" : "关"}`,
		fastSaveFailed: (reason: string) => `加速档保存失败：${reason}`,
		verbosityFlag: "覆盖 OpenAI 回答详略：low、medium、high",
		fastCommand: "开关当前 OpenAI 系供应商的加速档",
		fastShortcut: "开关加速档",
		configWarning: (warning: string) => `FireCode openai 配置：${warning}`,
	},
	en: {
		tokenReissued: "Claude token was just reissued; retried automatically",
		fastUnsupported: "The current model does not support fast mode",
		fastToggled: (enabled: boolean) => `Fast mode: ${enabled ? "on" : "off"}`,
		fastSaveFailed: (reason: string) => `Could not save fast mode: ${reason}`,
		verbosityFlag: "Override OpenAI response verbosity: low, medium, high",
		fastCommand: "Toggle fast mode for the current OpenAI-family provider",
		fastShortcut: "Toggle fast mode",
		configWarning: (warning: string) => `FireCode openai config: ${warning}`,
	},
});
