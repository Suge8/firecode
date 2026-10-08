/** 运行配置文件的位置与读取：只管文件，不管含义；语言（i18n.ts）与配置解析（config.ts）都从这里取原始内容。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, parseJsonc } from "./jsonc.js";

export const CONFIG_PATH = join(getAgentDir(), "extensions", "firecode", "config.jsonc");

/** 随包分发的推荐模板；构建把它复制到 dist 里与本模块相同的相对位置。 */
const TEMPLATE_PATH = fileURLToPath(new URL("./config.example.jsonc", import.meta.url));

/**
 * 首次启动播种：配置不存在时把推荐模板原样写到配置路径，返回 true；已存在（含内容有问题）绝不覆盖，返回 false。
 * 写入失败直接抛出。独占创建（wx）让「存在性检查」与写入是同一步，并发启动也不会互相覆盖。
 * 必须在首次 loadConfig 之前调用（结果被缓存）。
 */
export function seedConfig(): boolean {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	try {
		writeFileSync(CONFIG_PATH, readFileSync(TEMPLATE_PATH), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** 读取结果：fault 只说明发生了什么，措辞归 config.ts——本模块被 i18n.ts 依赖，不能反向依赖文案。 */
export type ConfigFile = {
	raw: Record<string, unknown>;
	fault?: { kind: "missing" } | { kind: "notObject" } | { kind: "parse"; message: string };
};

export function readConfigFile(): ConfigFile {
	let parsed: unknown;
	try {
		parsed = parseJsonc(readFileSync(CONFIG_PATH, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, fault: { kind: "missing" } };
		return { raw: {}, fault: { kind: "parse", message: error instanceof Error ? error.message : String(error) } };
	}
	return isRecord(parsed) ? { raw: parsed } : { raw: {}, fault: { kind: "notObject" } };
}
