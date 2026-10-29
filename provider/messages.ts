import { defineMessages } from "../i18n.js";
import type { NativeCompactionFailureReason } from "./openai-native/src/compact-client.js";

/** 原生压缩没能继续使用上次压缩窗口的原因，决定提示里怎么说、用户怎么办。 */
export type WindowLoss = { kind: "switched" | "disabled" | "unreplayable"; from: string };

export const msg = defineMessages({
	zh: {
		tokenReissued: "Claude 令牌刚换发，已自动重试",
		imageUploadFailed: (reason: string) => `图片上传 Claude Files 失败，没传上的本轮原样内嵌，下一轮重试：${reason}`,
		imageFileGone: "Claude Files 里的图片文件已失效，重新上传后重试本轮",
		fastUnsupported: "当前模型不支持加速档",
		fastToggled: (enabled: boolean) => `加速档：${enabled ? "开" : "关"}`,
		fastSaveFailed: (reason: string) => `加速档保存失败：${reason}`,
		verbosityFlag: "覆盖 OpenAI 回答详略：low、medium、high",
		fastCommand: "开关当前 OpenAI 系供应商的加速档",
		fastShortcut: "开关加速档",
		compaction: {
			guidance: (text: string) => `本次手动 /compact 的补充要求：\n${text}`,
			failed: (reason: NativeCompactionFailureReason, status?: number, detail?: string) => {
				const what: Record<NativeCompactionFailureReason, string> = {
					"network-error": "请求没能发出，或网络失败",
					"non-2xx": "接口拒绝了请求",
					"empty-body": "接口返回了空内容",
					"malformed-response": "接口返回了无法识别的内容",
					"missing-compaction": "接口没有返回压缩结果",
					"input-too-large": "对话超出了模型的上下文窗口",
					"response-failed": "接口报告压缩失败",
				};
				return `原生压缩失败：${what[reason]}${status ? `（HTTP ${status}）` : ""}${detail ? `：${detail}` : ""}`;
			},
			cancelled: (cause: string) => `FireCode：${cause}。压缩已取消，历史保留，可以稍后重试。`,
			fallback: (cause: string) => `FireCode：${cause}。这次自动压缩改用完整原文生成普通摘要。`,
			replayDeclined: (loss: WindowLoss) => {
				const cause = {
					switched: `当前模型不是做那次原生压缩的 ${loss.from}`,
					disabled: "features.openaiNative 或 openai.nativeCompaction 已关闭",
					unreplayable: "原生检查点版本不受支持，或这次请求的内容与会话记录对不上",
				}[loss.kind];
				const remedy = {
					switched: `切回 ${loss.from} 可恢复这段历史`,
					disabled: "把 features.openaiNative 和 openai.nativeCompaction 改回 true 并重启可恢复",
					unreplayable: "从该检查点之前的会话分支重新开始",
				}[loss.kind];
				return `FireCode：${cause}，已停止请求或压缩，避免丢失历史。${remedy}。`;
			},
		},
	},
	en: {
		tokenReissued: "Claude token was just reissued; retried automatically",
		imageUploadFailed: (reason: string) =>
			`Image upload to Claude Files failed; images not uploaded are sent inline this turn and retried next turn: ${reason}`,
		imageFileGone: "An image file in Claude Files is gone; re-uploading it and retrying this turn",
		fastUnsupported: "The current model does not support fast mode",
		fastToggled: (enabled: boolean) => `Fast mode: ${enabled ? "on" : "off"}`,
		fastSaveFailed: (reason: string) => `Could not save fast mode: ${reason}`,
		verbosityFlag: "Override OpenAI response verbosity: low, medium, high",
		fastCommand: "Toggle fast mode for the current OpenAI-family provider",
		fastShortcut: "Toggle fast mode",
		compaction: {
			guidance: (text: string) => `Additional user guidance for this manual /compact request:\n${text}`,
			failed: (reason: NativeCompactionFailureReason, status?: number, detail?: string) => {
				const what: Record<NativeCompactionFailureReason, string> = {
					"network-error": "the request could not be sent, or the network failed",
					"non-2xx": "the API rejected the request",
					"empty-body": "the API returned an empty body",
					"malformed-response": "the API returned something unrecognizable",
					"missing-compaction": "the API returned no compaction result",
					"input-too-large": "the conversation exceeds the model's context window",
					"response-failed": "the API reported the compaction failed",
				};
				return `native compaction failed: ${what[reason]}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`;
			},
			cancelled: (cause: string) => `FireCode: ${cause}. Compaction was cancelled; history is preserved. Try again later.`,
			fallback: (cause: string) => `FireCode: ${cause}. This automatic compaction uses the complete original text for an ordinary summary.`,
			replayDeclined: (loss: WindowLoss) => {
				const cause = {
					switched: `the current model is not ${loss.from}, which made the native compaction`,
					disabled: "features.openaiNative or openai.nativeCompaction is off",
					unreplayable: "the native checkpoint version is unsupported, or this request does not line up with the session record",
				}[loss.kind];
				const remedy = {
					switched: `switch back to ${loss.from} to restore it`,
					disabled: "set features.openaiNative and openai.nativeCompaction back to true and restart to restore it",
					unreplayable: "start again from the session branch before this checkpoint",
				}[loss.kind];
				return `FireCode: ${cause}. The request or compaction was stopped to preserve history; ${remedy}.`;
			},
		},
	},
});
