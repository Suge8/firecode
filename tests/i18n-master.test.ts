import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

const CJK = /[\u3400-\u9fff]/u;
const LANGUAGES = [
	{ language: "zh", configJsonc: JSON.stringify({ language: "zh" }) },
	{ language: "en", configJsonc: JSON.stringify({ language: "en" }) },
];

async function envelopeModules(configJsonc: string) {
	const { masterEvent, withElapsed } = await loadFirecodeModule("master/event-format.ts", { configJsonc }) as any;
	const { machineEntries } = await loadFirecodeModule("tools/machine.ts", { configJsonc }) as any;
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts", { configJsonc }) as any;
	const entry = (produced: unknown, elapsed = { run: 61_000 }) =>
		machineEntries(wrapEnvelope("firecode_master_event", withElapsed(produced, elapsed)))[0];
	return { masterEvent, entry };
}

for (const { language, configJsonc } of LANGUAGES) {
	test(`${language}：Master 事件信封被折叠行识别——失败色、耗时与子代理名`, async () => {
		const { masterEvent, entry } = await envelopeModules(configJsonc);
		const failed = entry(masterEvent.failed("scout", "quota exhausted"));
		expect(failed).toMatchObject({ worker: "scout", failed: true, alarm: true, duration: "1m1s", preview: "quota exhausted" });

		const returned = entry(masterEvent.returned("scout", "All good. Details"));
		expect(returned).toMatchObject({ worker: "scout", failed: false, alarm: false, duration: "1m1s", preview: "All good." });
		expect(entry(masterEvent.reviewIncomplete("scout", "no state"))).toMatchObject({ failed: true, alarm: true });
		expect(entry(masterEvent.interrupted("scout", true))).toMatchObject({ failed: false, alarm: false });
		expect(entry(masterEvent.resumeReminder("scout"), {}).duration).toBeUndefined();
	});
}

test("en：Master 事件的标题与正文不含中文", async () => {
	const { masterEvent } = await envelopeModules(LANGUAGES[1].configJsonc);
	const review = { status: "stopped", rounds: 3, advisorAdvice: "stop here" };
	for (const produced of [
		masterEvent.returned("a", "done", true, ["fix it"]),
		masterEvent.failed("a", "boom", true),
		masterEvent.interrupted("a", true),
		masterEvent.review("a", { status: "passed", rounds: 2 }, ""),
		masterEvent.review("a", review, "reply"),
		masterEvent.review("a", { status: "none" }, ""),
		masterEvent.resumeReminder("a"),
		masterEvent.stranded("a", ["x", "y"]),
		masterEvent.modelSwitched("a", "p/m/low", "p/n/low", "429"),
	]) expect(produced.body).not.toMatch(CJK);
});

for (const { language, configJsonc } of LANGUAGES) {
	test(`${language}：指挥官与 Worker 提示词存在，且引用的视图来源标记与事件产文一致`, async () => {
		const { readMasterPrompt } = await loadFirecodeModule("master/prompt.ts", { configJsonc }) as any;
		const { masterEvent } = await loadFirecodeModule("master/event-format.ts", { configJsonc }) as any;
		const title = (event: any) => event.body.split("\n", 1)[0];
		const viewed = title(masterEvent.returned("a", "ok", false, ["hi"])).slice(title(masterEvent.returned("a", "ok")).length).trim();
		expect(viewed.length).toBeGreaterThan(0);
		expect(readMasterPrompt("master")).toContain(viewed);
		expect(CJK.test(readMasterPrompt("worker"))).toBe(language === "zh");
		expect(CJK.test(readMasterPrompt("master"))).toBe(language === "zh");
	});
}
