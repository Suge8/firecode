// 按需生成被审计的仓库。真值（T9 植入缺陷、t7 缺陷清单）绑定在固定提交上，所以 fixture 不跟随当前 HEAD。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitArchive, initGit, WORK } from "./lib.ts";
import type { FixtureKind } from "./tasks.ts";

const FIXTURE_REF = "b0fb416";
const FIXTURES = join(WORK, "fixtures");
export const T9_TRUTH_FILE = join(FIXTURES, "t9-truth.json");
const LINE_SLACK = 5;
/** 报告里的“文件:行号”引用，行号可以是 `12, 14` 或 `12-14` 这类写法。 */
const CITATION = /([\w./-]+\.ts)[`'"）)]*[:：#\sL第]*(\d+(?:\s*[,，、\-–~]\s*\d+)*)/g;

/** 报告里指到“同文件且行号相差 ≤5”的植入缺陷；命中只是候选，漏指行号的须人读。 */
export function citedTruth<T extends { file: string; line: number }>(truth: T[], report: string): T[] {
	const cites = [...report.matchAll(CITATION)].map((m) => ({ file: m[1]!, lines: m[2]!.split(/\D+/).filter(Boolean).map(Number) }));
	return truth.filter((t) => cites.some((c) => (t.file.endsWith(c.file) || c.file.endsWith(t.file)) && c.lines.some((l) => Math.abs(l - t.line) <= LINE_SLACK)));
}

const E2E = `#!/bin/bash
# 端到端套件：12 个场景串行，每个约 75 秒，全套约 15 分钟。
cases=(boot preset-switch rename review-pass review-fail master-start master-steer master-kill watcher-quiet quota-query herdr-label compaction)
failed=()
for c in \${cases[@]}; do
	echo "[e2e] $c ..."
	sleep 75
	case "$c" in
		review-fail|compaction) echo "[e2e] $c FAIL"; failed+=("$c");;
		*) echo "[e2e] $c PASS";;
	esac
done
echo "[e2e] 失败：\${failed[*]:-无}"
[ \${#failed[@]} -eq 0 ]
`;

interface Seed {
	id: string;
	file: string;
	from: string;
	to: string;
	desc: string;
}

/** 在真实代码上做的最小逻辑改动；from 必须在文件里恰好出现一次。 */
const SEEDS: Seed[] = [
	{ id: "M1", file: "master/actions.ts", from: ">= MAX_IN_FLIGHT)", to: "> MAX_IN_FLIGHT)", desc: "并发上限判定改为 >，第 16 个 start 不再被拒（契约：第 16 个 start 直接拒绝）" },
	{ id: "M2", file: "master/outbox.ts", from: "this.schedule(Math.min(quiet, Math.max(0, this.firstQueuedAt", to: "this.schedule(Math.max(quiet, Math.max(0, this.firstQueuedAt", desc: "合并唤醒窗口 min 改 max：第一条结果要等满 6 秒才唤醒（契约：安静 1.5 秒即唤醒、最多等 6 秒）" },
	{ id: "M3", file: "master/activity-list.ts", from: "Math.floor(silent / MINUTE_MS)", to: "Math.ceil(silent / MINUTE_MS)", desc: "“N 分钟无输出”向上取整，5分01秒显示 6 分钟" },
	{ id: "M4", file: "master/actions.ts", from: 'live.outcome.kind !== "done"', to: 'live.outcome.kind === "done"', desc: "ack 清掉的是已完成而不是失败/被中断的落定结局（注释：ack 发落失败与被中断的行；完成的留到 kill）" },
	{ id: "T1", file: "format.ts", from: "if (tokens >= 1_000_000)", to: "if (tokens > 1_000_000)", desc: "恰好 1_000_000 显示成 1000k 而不是 1M" },
	{ id: "T2", file: "format.ts", from: "if (totalSeconds < 60)", to: "if (totalSeconds <= 60)", desc: "恰好 60 秒显示 60s 而不是 1m" },
	{ id: "T3", file: "format.ts", from: "if (column >= textWidth - target)", to: "if (column > textWidth - target)", desc: "from=start 截断少保留一列尾部" },
	{ id: "T4", file: "format.ts", from: '(id.split("/").pop() ?? id)', to: '(id.split("/")[1] ?? id)', desc: "formatModelName 取第二段而不是最后一段，多段 id 取错" },
	{ id: "T5", file: "tools/parts.ts", from: "if (used + partWidth <= width)", to: "if (used + partWidth < width)", desc: "clipParts 恰好放得下的片段被当成放不下" },
	{ id: "S1", file: "session/quota.ts", from: "Math.round(100 - used)", to: "Math.round(used)", desc: "剩余额度显示成已用百分比" },
	{ id: "S2", file: "session/quota.ts", from: "seconds % DAY_SECONDS === 0", to: "seconds % HOUR_SECONDS === 0", desc: "窗口标签：5 小时窗口被标成 0.2083…天" },
	{ id: "S3", file: "session/stats.ts", from: "attributed.timestamp < from) continue", to: "attributed.timestamp > from) continue", desc: "/tokens N 天过滤反了：只统计窗口之外的旧记录" },
	{ id: "SB1", file: "statusbar/render.ts", from: "n >= Math.min(titleWidth, TITLE_MIN); n--) yield at(clip(parts.title, n)", to: "n > Math.min(titleWidth, TITLE_MIN); n--) yield at(clip(parts.title, n)", desc: "标题从不裁到 TITLE_MIN 宽（文档：标题裁到 TITLE_MIN）" },
	{ id: "W1", file: "watcher/index.ts", from: "(observer.contextPercent() ?? 0) >= CONTEXT_RESET_PERCENT", to: "(observer.contextPercent() ?? 100) >= CONTEXT_RESET_PERCENT", desc: "上下文占比未知时每次都重建观察会话" },
];

function removeTests(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "tests") rmSync(path, { recursive: true });
			else removeTests(path);
		} else if (name.endsWith(".test.ts")) rmSync(path);
	}
}

function buildBase(dest: string): void {
	gitArchive(FIXTURE_REF, dest);
	mkdirSync(join(dest, "scripts"), { recursive: true });
	writeFileSync(join(dest, "scripts/e2e.sh"), E2E, { mode: 0o755 });
}

/** 去掉测试、无历史可查、植入缺陷；真值（含行号）写到 T9_TRUTH_FILE。 */
function buildT9(dest: string): void {
	gitArchive(FIXTURE_REF, dest);
	removeTests(dest);
	const truth = SEEDS.map((seed) => {
		const path = join(dest, seed.file);
		const source = readFileSync(path, "utf8");
		if (source.split(seed.from).length !== 2) throw new Error(`植入锚点 ${seed.id} 在 ${seed.file} 里不是恰好一处`);
		writeFileSync(path, source.replace(seed.from, seed.to));
		return { id: seed.id, file: seed.file, line: source.slice(0, source.indexOf(seed.from)).split("\n").length, desc: seed.desc };
	});
	writeFileSync(T9_TRUTH_FILE, JSON.stringify(truth, null, 1));
}

export function fixtureDir(kind: FixtureKind): string {
	const dest = join(FIXTURES, kind);
	if (existsSync(dest)) return dest;
	try {
		(kind === "base" ? buildBase : buildT9)(dest);
		initGit(dest);
	} catch (error) {
		rmSync(dest, { recursive: true, force: true });
		throw error;
	}
	return dest;
}
