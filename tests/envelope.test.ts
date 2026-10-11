import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

// 折叠界面据此判断一条用户消息是不是机器消息：整条恰好由信封构成才算，用户自己的话里夹带信封不算。
test("一条消息可含多个事件信封并逐个还原；夹带别的文字或未知标签的文本不是机器消息", async () => {
	const { wrapEnvelope, parseEnvelopes } = await loadFirecodeModule("deliver.ts") as {
		wrapEnvelope(tag: string, body: string): string;
		parseEnvelopes(text: string): { tag: string; body: string }[] | undefined;
	};
	const first = "a 已返回\n回复：\n完成\n\n含空行";
	const second = "b 被中断\n会话与审查义务均已保留";
	expect(parseEnvelopes([wrapEnvelope("firecode_master_event", first), wrapEnvelope("firecode_master_event", second)].join("\n\n"))).toEqual([
		{ tag: "firecode_master_event", body: first },
		{ tag: "firecode_master_event", body: second },
	]);

	const wrapped = wrapEnvelope("firecode_master_event", "事件");
	for (const text of ["你好", `请看这个：\n${wrapped}`, `${wrapped}\n顺便说一句`, "<firecode_other>\nx\n</firecode_other>"])
		expect(parseEnvelopes(text)).toBeUndefined();
});
