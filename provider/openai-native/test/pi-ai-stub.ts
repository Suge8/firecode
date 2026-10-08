import { mock } from "bun:test";

/**
 * 这些单元测试不加载宿主源码（pi-ai 在此无法解析），responses-input 对 pi-ai 的运行时依赖用占位替身。
 * 与宿主的逐项一致性由 tests/native-responses-parity.test.ts 用真实宿主转换器和真实模型目录守护。
 */
export function registerPiAiStub(): void {
	mock.module("@earendil-works/pi-ai", () => ({
		renderSystemMessageUpdate: () => "",
		resolveTranscriptTools: () => ({ anchorsAdditions: false }),
	}));
	mock.module("@earendil-works/pi-ai/api/openai-responses-shared", () => ({ convertResponsesTools: () => [] }));
	mock.module("@earendil-works/pi-ai/utils/hash", () => ({ shortHash: () => "" }));
}
