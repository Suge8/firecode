/**
 * Worker 会话里 Master 只注册这一件事：edit/write 只能落在当前 checkout 或系统临时目录内（按真实路径判断）。
 * 临时目录放行是因为调研报告、评测产物这类交付物本来就写在那里；拦掉只会逼 Worker 改用 bash 绕过守卫。
 */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { msg } from "./messages.js";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerWorkerGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
		if (reason) return { block: true, reason };
	});
}

/** os.tmpdir() 在 macOS 是每用户的 /var/folders/…，/tmp 是另一处，两处都是临时目录。 */
const TEMP_ROOTS = [tmpdir(), "/tmp"];

async function outsideCheckoutReason(path: string, cwd: string): Promise<string | undefined> {
	const target = await canonicalWritePath(resolve(cwd, path));
	const roots = await Promise.all([cwd, ...TEMP_ROOTS].map(canonicalWritePath));
	return roots.some((root) => within(root, target)) ? undefined : msg.guard(path);
}

function within(root: string, target: string): boolean {
	const local = relative(root, target);
	return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

/** 目标可能还不存在：沿祖先找到第一个真实存在的目录取真实路径，再拼回缺失的部分。 */
async function canonicalWritePath(path: string): Promise<string> {
	let ancestor = path;
	const missing: string[] = [];
	while (true) {
		try {
			return resolve(await realpath(ancestor), ...missing.reverse());
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) return path;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}
