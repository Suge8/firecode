import { expect, test } from "bun:test";
import { loadFirecodeModule } from "./loader.ts";

const CJK = /[\u3400-\u9fff]/u;
const EN = JSON.stringify({ language: "en" });

async function envelopeModules(configJsonc: string) {
	const { masterEvent, withElapsed } = await loadFirecodeModule("master/event-format.ts", { configJsonc }) as any;
	const { machineEntries } = await loadFirecodeModule("tools/machine.ts", { configJsonc }) as any;
	const { wrapEnvelope } = await loadFirecodeModule("deliver.ts", { configJsonc }) as any;
	const entry = (produced: unknown) =>
		machineEntries(wrapEnvelope("firecode_master_event", withElapsed(produced, { run: 61_000 })))[0];
	return { masterEvent, entry };
}

test("en：Master 事件信封被折叠行识别——失败色、耗时与子代理名", async () => {
	const { entry, masterEvent } = await envelopeModules(EN);
	expect(entry(masterEvent.failed("scout", "quota exhausted"))).toMatchObject({ worker: "scout", failed: true, alarm: true, duration: "1m1s", preview: "quota exhausted" });
	expect(entry(masterEvent.returned("scout", "All good. Details"))).toMatchObject({ worker: "scout", failed: false, alarm: false, duration: "1m1s", preview: "All good." });
});

test("en：Master 事件的标题与正文不含中文", async () => {
	const { masterEvent } = await envelopeModules(EN);
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
		masterEvent.extensionError("a", "~/ext/x.ts", "agent_start", "boom"),
		masterEvent.modelSwitched("a", "p/m/low", "p/n/low", "429"),
	]) expect(produced.body).not.toMatch(CJK);
});
