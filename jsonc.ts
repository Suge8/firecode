export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 与宿主的 settings/models.json 同一宽容度：行注释、块注释、尾逗号、BOM。字符串字面量先整体匹配，里面的斜杠与逗号不动。
const COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
const TRAILING_COMMA = /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g;

export function parseJsonc(text: string): unknown {
	const bare = text.replace(/^\uFEFF/, "")
		.replace(COMMENT, (match) => (match.startsWith('"') ? match : " "))
		.replace(TRAILING_COMMA, (match, tail?: string) => tail ?? match);
	return JSON.parse(bare);
}
