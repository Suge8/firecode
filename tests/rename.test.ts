import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";
import { fakePi } from "./fake-pi.ts";

afterEach(cleanupFirecodeModules);

async function setup(initialName?: string) {
	const { registerSessionName, RENAME_REQUEST_CHANNEL } = await loadFirecodeModule("session/rename.ts") as any;
	let sessionName = initialName;
	const fake = fakePi({
		getSessionName: () => sessionName,
		setSessionName: (name: string) => { sessionName = name; },
	});
	registerSessionName(fake.pi);
	const notices: string[] = [];
	const prompts: unknown[][] = [];
	/** 外壳在宿主改名键按下时发布请求；返回时输入框已应答并落定。 */
	const request = async (answer: string | undefined) => {
		const ctx = {
			ui: {
				input: async (...args: unknown[]) => { prompts.push(args); return answer; },
				notify: (message: string) => notices.push(message),
			},
		};
		fake.pi.events.emit(RENAME_REQUEST_CHANNEL, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { fake, request, notices, prompts, name: () => sessionName };
}

test("改名请求弹出输入框（预填当前名字）并改会话名，名字去掉控制字符", async () => {
	const host = await setup("old");

	await host.request("  new\u200b name\n");

	expect(host.prompts[0]?.[1]).toBe("old");
	expect(host.name()).toBe("new name");
	expect(host.notices).toEqual(["会话已改名：new name"]);
});

test("取消或留空不改会话名", async () => {
	const host = await setup("old");

	await host.request(undefined);
	await host.request("   ");

	expect(host.name()).toBe("old");
	expect(host.notices).toEqual([]);
});

test("不注册 /rename 命令，也不自占快捷键：键位归宿主的 app.session.rename", async () => {
	const host = await setup();

	expect([...host.fake.commands.keys()]).toEqual([]);
	expect([...host.fake.shortcuts.keys()]).toEqual([]);
});
