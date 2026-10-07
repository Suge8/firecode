import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

afterEach(cleanupFirecodeModules);

async function loadRenameSession() {
	const { registerSessionName } = await loadFirecodeModule("session/rename.ts");
	return registerSessionName as (pi: unknown) => void;
}

test("renames through Pi and binds Ctrl+R", async () => {
	let sessionName = "old";
	const notifications: string[] = [];

	const fake = fakePi({
		setSessionName(name: string) {
			sessionName = name;
		},
		exec() {
			throw new Error("rename must not call any external CLI");
		},
	});
	(await loadRenameSession())(fake.pi);

	await fake.commands.get("rename").handler("new name", {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});

	expect([...fake.shortcuts.keys()]).toEqual(["ctrl+r"]);
	expect(sessionName).toBe("new name");
	expect(notifications).toEqual(["会话已改名：new name"]);
});

test("Ctrl+R prompts for and applies a session name", async () => {
	let sessionName = "old";

	const fake = fakePi({
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
	});
	(await loadRenameSession())(fake.pi);

	await fake.shortcuts.get("ctrl+r").handler({
		hasUI: true,
		ui: {
			input: async () => "new name",
			notify() {},
		},
	});

	expect(sessionName).toBe("new name");
});

test("rejects an empty rename without touching the session", async () => {
	let sessionName = "old";
	const notifications: Array<[string, string]> = [];

	const fake = fakePi({
		setSessionName(name: string) {
			sessionName = name;
		},
	});
	(await loadRenameSession())(fake.pi);

	await fake.commands.get("rename").handler("   ", {
		ui: {
			notify(message: string, level: string) {
				notifications.push([message, level]);
			},
		},
	});

	expect(sessionName).toBe("old");
	expect(notifications).toEqual([["用法：/rename <新名字>", "error"]]);
});
