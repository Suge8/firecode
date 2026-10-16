import { defineMessages } from "../i18n.js";
import type { NativeCompactionFailureReason } from "./openai-native/src/compact-client.js";

/** 原生压缩没能继续使用上次压缩窗口的原因，决定提示里怎么说、用户怎么办。 */
export type WindowLoss = { kind: "switched" | "disabled" | "unreplayable"; from: string };

export const msg = defineMessages({
	zh: {
		tokenReissued: "Claude 令牌刚换发，已自动重试",
		imageUploadFailed: (reason: string) => `图片上传 Claude Files 失败，没传上的本轮原样内嵌，下一轮重试：${reason}`,
		fastUnsupported: "当前模型不支持加速档",
		fastToggled: (enabled: boolean) => `加速档：${enabled ? "开" : "关"}`,
		fastSaveFailed: (reason: string) => `加速档保存失败：${reason}`,
		verbosityFlag: "覆盖 OpenAI 回答详略：low、medium、high",
		fastCommand: "开关当前 OpenAI 系供应商的加速档",
		fastShortcut: "开关加速档",
		compaction: {
			failed: (reason: NativeCompactionFailureReason, status?: number, detail?: string) => {
				const what: Record<NativeCompactionFailureReason, string> = {
					"network-error": "请求没能发出，或网络失败",
					"non-2xx": "接口拒绝了请求",
					"empty-body": "接口返回了空内容",
					"invalid-json": "接口返回的不是合法 JSON",
					"malformed-response": "接口返回了无法识别的内容",
					"missing-compaction": "接口没有返回压缩结果",
					"input-too-large": "对话超出了模型的上下文窗口",
					"response-failed": "接口报告压缩失败",
				};
				return `原生压缩失败：${what[reason]}${status ? `（HTTP ${status}）` : ""}${detail ? `：${detail}` : ""}`;
			},
			windowUnusable: (from: string) => `上一次压缩是 ${from} 的原生压缩，当前模型用不了它的压缩窗口`,
			retryLater: "可以稍后重试",
			switchBack: (from: string) =>
				`切回 ${from} 再压缩，或把 openai.nativeCompaction 设为 false 并重启，改用普通摘要压缩（压缩窗口里的旧历史会丢失）`,
			cancelled: (cause: string, hint: string) => `FireCode：${cause}。/compact 已取消，会话没有改动；${hint}。`,
			fallback: (cause: string, windowLost: boolean) =>
				`FireCode：${cause}。这次自动压缩改用普通摘要${windowLost ? "，上次原生压缩窗口里的旧历史不会进入摘要" : ""}。`,
			replayDeclined: (loss: WindowLoss) => {
				const cause = {
					switched: `当前模型不是做那次原生压缩的 ${loss.from}`,
					disabled: "openai.nativeCompaction 已关闭",
					unreplayable: "这次请求的内容与会话记录对不上",
				}[loss.kind];
				const remedy = {
					switched: `切回 ${loss.from} 可恢复这段历史`,
					disabled: "把 openai.nativeCompaction 改回 true 并重启可恢复",
					unreplayable: "这个提示反复出现时，把 openai.nativeCompaction 设为 false 并重启，改用普通摘要压缩",
				}[loss.kind];
				return `FireCode：${cause}，这次请求没有带上上次原生压缩之前的历史。${remedy}。`;
			},
		},
	},
	en: {
		tokenReissued: "Claude token was just reissued; retried automatically",
		imageUploadFailed: (reason: string) =>
			`Image upload to Claude Files failed; images not uploaded are sent inline this turn and retried next turn: ${reason}`,
		fastUnsupported: "The current model does not support fast mode",
		fastToggled: (enabled: boolean) => `Fast mode: ${enabled ? "on" : "off"}`,
		fastSaveFailed: (reason: string) => `Could not save fast mode: ${reason}`,
		verbosityFlag: "Override OpenAI response verbosity: low, medium, high",
		fastCommand: "Toggle fast mode for the current OpenAI-family provider",
		fastShortcut: "Toggle fast mode",
		compaction: {
			failed: (reason: NativeCompactionFailureReason, status?: number, detail?: string) => {
				const what: Record<NativeCompactionFailureReason, string> = {
					"network-error": "the request could not be sent, or the network failed",
					"non-2xx": "the API rejected the request",
					"empty-body": "the API returned an empty body",
					"invalid-json": "the API returned invalid JSON",
					"malformed-response": "the API returned something unrecognizable",
					"missing-compaction": "the API returned no compaction result",
					"input-too-large": "the conversation exceeds the model's context window",
					"response-failed": "the API reported the compaction failed",
				};
				return `native compaction failed: ${what[reason]}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`;
			},
			windowUnusable: (from: string) => `the last compaction was a native compaction by ${from}, and the current model cannot use its window`,
			retryLater: "try again later",
			switchBack: (from: string) =>
				`switch back to ${from} and compact again, or set openai.nativeCompaction to false and restart to use ordinary summary compaction (history inside the window is lost)`,
			cancelled: (cause: string, hint: string) => `FireCode: ${cause}. /compact was cancelled and the session is unchanged; ${hint}.`,
			fallback: (cause: string, windowLost: boolean) =>
				`FireCode: ${cause}. This automatic compaction falls back to an ordinary summary${windowLost ? "; history inside the last native compaction window will not be in it" : ""}.`,
			replayDeclined: (loss: WindowLoss) => {
				const cause = {
					switched: `the current model is not ${loss.from}, which made the native compaction`,
					disabled: "openai.nativeCompaction is off",
					unreplayable: "this request does not line up with the session record",
				}[loss.kind];
				const remedy = {
					switched: `switch back to ${loss.from} to restore it`,
					disabled: "set openai.nativeCompaction back to true and restart to restore it",
					unreplayable: "if this keeps appearing, set openai.nativeCompaction to false and restart to use ordinary summary compaction",
				}[loss.kind];
				return `FireCode: ${cause}, so this request left out the history before the last native compaction; ${remedy}.`;
			},
		},
	},
});
