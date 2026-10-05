import { afterEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cleanupFirecodeModules, loadFirecodeModule, PI_TUI_URL } from "./loader.ts";

afterEach(cleanupFirecodeModules);

const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22m` };

async function modules() {
	const machine = await loadFirecodeModule("tools/machine.ts") as any;
	const { masterEvent, withElapsed } = await loadFirecodeModule("master/event-format.ts") as any;
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts") as any;
	const entry = (produced: unknown) =>
		machine.machineEntries(wrapEnvelope("firecode_master_event", withElapsed(produced, { run: 60_000 })))[0];
	return { machine, masterEvent, wrapEnvelope, entry };
}

test("↳ 预览只取给人看的分节；非落定通知与被中断只显示标题，给模型的指令不进预览", async () => {
	const { masterEvent, entry } = await modules();
	expect(entry(masterEvent.returned("a", "完成了。细节"))).toMatchObject({ title: "a 已返回", preview: "完成了。" });
	for (const produced of [
		masterEvent.interrupted("b", false),
		masterEvent.interrupted("b", true),
		masterEvent.resumeReminder("c"),
		masterEvent.modelSwitched("d", "x/a/high", "y/b/high", "429"),
		masterEvent.stranded("e", ["迟到的补充"]),
	]) expect(entry(produced).preview).toBe("");
});

test("审查通过卡的预览不带模型名：多审查者汇总的“• 模型：结论”只取结论", async () => {
	const { machine, wrapEnvelope } = await modules();
	const card = wrapEnvelope("firecode_review", "第 2 轮审查通过\n• claude-opus-5-5：上一轮的两个发现都已处理完，没有新的高严重度问题。\n• gpt-6.1-sol：全量测试通过。");
	expect(machine.machineEntries(card, { tone: "success" })[0].preview).toBe("上一轮的两个发现都已处理完，没有新的高严重度问题。");
});

test("↳ 行给滚动条留一列：超宽时以 … 收尾、整行不超过 width-1，颜色在行内闭合", async () => {
	const { machine, masterEvent, entry } = await modules();
	const long = entry(masterEvent.returned("broken2", "图像内容无法从读取结果中辨识；已执行 ls，目录包含 a.txt、b.ts、bad.png、out1.txt、pic.png 和 README.md。"));
	const line = machine.machineLine(long, theme, 60);
	const plain = stripVTControlCharacters(line);
	expect(plain.endsWith("…")).toBe(true);
	const { visibleWidth } = await import(PI_TUI_URL) as any;
	expect(visibleWidth(plain)).toBeLessThanOrEqual(59);
	expect(line.endsWith("\x1b[22m")).toBe(true);
});
