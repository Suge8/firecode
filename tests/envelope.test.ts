import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

async function envelope() {
	return await loadFirecodeModule("deliver.ts") as {
		wrapEnvelope(tag: string, body: string): string;
		parseEnvelopes(text: string): { tag: string; body: string }[] | undefined;
	};
}

test("信封包裹后能被识别并还原每个事件正文，一条消息可含多个事件", async () => {
	const { wrapEnvelope, parseEnvelopes } = await envelope();
	const first = "a 已返回\n回复：\n完成\n\n含空行";
	const second = "b 被中断\n会话与审查义务均已保留";
	const text = [wrapEnvelope("firecode_master_event", first), wrapEnvelope("firecode_master_event", second)].join("\n\n");
	expect(parseEnvelopes(text)).toEqual([
		{ tag: "firecode_master_event", body: first },
		{ tag: "firecode_master_event", body: second },
	]);
	expect(parseEnvelopes(wrapEnvelope("firecode_watcher", "建议"))).toEqual([{ tag: "firecode_watcher", body: "建议" }]);
});

test("不是整条由信封构成的文本不被识别为机器消息", async () => {
	const { wrapEnvelope, parseEnvelopes } = await envelope();
	const wrapped = wrapEnvelope("firecode_master_event", "事件");
	expect(parseEnvelopes("你好")).toBeUndefined();
	expect(parseEnvelopes(`请看这个：\n${wrapped}`)).toBeUndefined();
	expect(parseEnvelopes(`${wrapped}\n顺便说一句`)).toBeUndefined();
	expect(parseEnvelopes("<firecode_other>\nx\n</firecode_other>")).toBeUndefined();
});

test("review 的修复反馈与总结提示同样是信封机器消息", async () => {
	const { wrapEnvelope, parseEnvelopes } = await envelope();
	expect(parseEnvelopes(wrapEnvelope("firecode_review", "第 1 轮未通过"))).toEqual([{ tag: "firecode_review", body: "第 1 轮未通过" }]);
});
