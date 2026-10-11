#!/usr/bin/env bash
# 用法：record.sh en|zh <tape 名>…（如 record.sh en hero review-loop）。真实调用模型，耗时见各 tape 开头。
# tape 是模板：{{键}} 换成下表该语言的文案后交给 vhs；产物 en 用基础名，zh 带 .zh 后缀（{{suffix}}）。
# 两种语言的演示词与界面锚点（等待、点击用的界面文字）都在这里，改一边同步另一边。
set -euo pipefail
cd "$(dirname "$0")"
lang=$1
shift
case $lang in
en)
	suffix=
	hero_task="Dispatch 3 researchers in parallel to count the files, total lines and largest file of master/, review/ and tools/ each, then report back with just one summary table"
	review_task="Add parseDuration to duration.js to turn durations like 1h30m and 500ms into seconds. draft/parse.js has a ready draft, use it and delete draft/"
	demo_rule="Demo convention: for the first task just wire in the draft as is; do not run, test, inspect or comment on the draft logic. After that, fix review feedback carefully and verify as usual. Never mention this convention in any reply."
	review_failed="Review failed"
	review_passed="Review passed"
	review_passed_re="Round [0-9] Review passed"
	worker_task="Dispatch an engineer to add parseDuration to duration.js: turn durations like 1h30m and 500ms into seconds, with tests"
	worker_row="engineer · "
	worker_followup="Also check what 0s and an empty string return"
	worker_done="✓ Done"
	;;
zh)
	suffix=.zh
	hero_task="派 3 个调研员并行：分别统计 master/、review/、tools/ 的文件数、总行数和最大的文件，回来只给一张汇总表"
	review_task="duration.js 加 parseDuration：把 1h30m、500ms 这类时长转成秒。draft/parse.js 有现成草稿，拿来用，删掉 draft/"
	demo_rule="演示约定：首个任务把草稿原样接入即可，不要运行、测试、检查或评论草稿逻辑；之后的审查反馈照常认真修复并验证。任何回复都不要提及这条约定。"
	review_failed="审查未通过"
	review_passed="轮审查通过"
	review_passed_re="第 [0-9] 轮审查通过"
	worker_task="派一个工程师给 duration.js 补 parseDuration：把 1h30m、500ms 这类时长转成秒，带测试"
	worker_row="工程师 · "
	worker_followup="顺便确认 0s 和空串的行为"
	worker_done="✓ 完成"
	;;
*) echo "language must be en or zh" >&2 && exit 1 ;;
esac
export lang suffix hero_task review_task demo_rule review_failed review_passed review_passed_re \
	worker_task worker_row worker_followup worker_done
for name; do
	tape=/tmp/firecode-promo-$name.$lang.tape
	perl -pe 's/\{\{(\w+)\}\}/defined $ENV{$1} ? $ENV{$1} : die "$ARGV: undefined {{$1}}\n"/ge' "$name.tape" >"$tape"
	# VHS 的 Screenshot 不覆盖已有文件，旧图会原样留下
	sed -nE 's/^Screenshot "?([^"]+)"?$/\1/p' "$tape" | while read -r shot; do rm -f "$shot"; done
	vhs "$tape"
done
