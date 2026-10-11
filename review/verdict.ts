/**
 * 审查者的 PASS/FAIL 与顾问的 continue/stop/narrow 是同一类“独占一行的判定词”，模型常给它加装饰：
 * 标题井号、「裁决：」式标签、粗体/斜体/反引号包裹、句末标点。两边共用这一个剥离函数，容忍度一致。
 */

/** 去掉判定行的装饰，返回小写的判定词（可能不是合法判定词，由调用方比对）。 */
export function verdictWord(line: string): string {
	let text = line
		.trim()
		.replace(/^#{1,6}\s*/u, "")
		.replace(/^(?:verdict|裁决|判定|结论)\s*[:：]\s*/iu, "");
	for (;;) {
		const wrapped = /^(\*{1,2}|_{1,2}|`+)(.+?)\1$/u.exec(text);
		if (!wrapped) break;
		text = (wrapped[2] ?? "").trim();
	}
	return text.replace(/[.。!！]+$/u, "").trim().toLowerCase();
}
