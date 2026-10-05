/** 内置工具的动作词与目标：工具行渲染与 Master 活动列表共用的唯一来源。 */
import { homedir } from "node:os";
import type { ClipSide } from "../format.js";
import { commandParts, genericArgsParts, pathValue, type Part } from "./parts.js";

export const LABEL = { read: "读取", bash: "操作", edit: "修改", write: "写入" } as const;

export type ToolArgs = {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
};

export const argPath = (args: ToolArgs): string => args?.file_path ?? args?.path ?? "";

/** read 的 offset/limit → `:12-40`、`:12+`。 */
export function rangeSuffix(args: ToolArgs): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const start = args.offset ?? 1;
	if (args.limit === undefined) return `:${start}+`;
	return `:${start}-${start + args.limit - 1}`;
}

const CD_PREFIX = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*&&\s*/u;
const trimSlash = (path: string) => path.replace(/(?<=.)\/+$/u, "");

/** agent 的命令常以“cd 到当前工作目录 &&”开头，这段前缀没有信息量（同路径显示 ./ 的思路）；cd 到别处保留。 */
function withoutCwdPrefix(command: string, cwd: string): string {
	const match = CD_PREFIX.exec(command);
	if (!match || !cwd) return command;
	const target = (match[1] ?? match[2] ?? match[3]).replace(/^~(?=\/|$)/u, homedir());
	return trimSlash(target) === trimSlash(cwd) ? command.slice(match[0].length) : command;
}

/** 工具调用的目标片段与过长时的保留侧（路径留尾、命令留头）。 */
export function toolTarget(tool: string, args: unknown, cwd: string): { value: Part[]; clip: ClipSide } {
	const input = (args ?? {}) as ToolArgs & { command?: string };
	switch (tool) {
		case "read": return { value: pathValue(argPath(input), cwd, rangeSuffix(input)), clip: "start" };
		case "edit":
		case "write": return { value: pathValue(argPath(input), cwd), clip: "start" };
		case "bash": return { value: commandParts(withoutCwdPrefix(input.command ?? "", cwd)), clip: "end" };
		default: return { value: genericArgsParts(args), clip: "end" };
	}
}

/** 一句纯文本动作：动作词 + 目标，如“修改 ./tools/line.ts”；未内置的工具用工具名作动作词。 */
export function toolActionText(tool: string, args: unknown, cwd: string): string {
	const word = LABEL[tool as keyof typeof LABEL] ?? tool;
	const target = toolTarget(tool, args, cwd).value.map((part) => part.text).join("");
	return target ? `${word} ${target}` : word;
}
