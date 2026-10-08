#!/usr/bin/env bash
# 重建宣传录制用的临时现场：/tmp/firecode-promo/repo（演示仓库）与 /tmp/firecode-promo/agent（临时 Agent 目录）。
# 用法：setup-demo.sh en|zh [advisorAfterFailures]   各 tape 在隐藏段调用（经 record.sh 填入语言），每次录制都从同一现场开始。
# Agent 目录装着与 ~/.pi/agent 同一份 firecode（claudeSub 开着）；auth.json 用链接，令牌换发写回原处。
# zh 用本机配置（中文角色名）与本机 SYSTEM.md；en 用随包英文模板（英文角色名）与一份英文 SYSTEM.md，演示仓库也换英文。
# 两种语言都必须有 SYSTEM.md：pi 默认系统提示会被 Anthropic 判为第三方应用，订阅请求直接 400。
set -euo pipefail
lang=$1
src=~/.pi/agent
root=/tmp/firecode-promo
tmux -L promo kill-server 2>/dev/null || true
rm -rf "$root" && mkdir -p "$root/agent/extensions/firecode" "$root/repo/draft"

agent=$root/agent
links=(auth.json models.json keybindings.json)
[[ $lang == zh ]] && links+=(SYSTEM.md)
for f in "${links[@]}"; do ln -s "$src/$f" "$agent/$f"; done
[[ $lang == en ]] && echo "You are a coding agent. Write minimal, high-performance, zero-redundancy software: code, docs and tests are liabilities, and every line needs a reason. Verify claims against the code before acting. Keep replies short and plain, in English." >"$agent/SYSTEM.md"
cp "$src/settings.json" "$agent/settings.json"
cp "$src/extensions/firecode/index.ts" "$agent/extensions/firecode/"
ln -s "$(readlink -f "$src/extensions/firecode/source")" "$agent/extensions/firecode/source"
case $lang in
zh) base=$src/extensions/firecode/config.jsonc ;;
en) base=$(dirname "$0")/../../config.example.jsonc ;;
*) echo "language must be en or zh" >&2 && exit 1 ;;
esac
sed -E -e "s/(\"advisorAfterFailures\": )[0-9]+/\1${2:-2}/" -e "s#^([[:space:]]*)(// )?\"language\": \"[a-z]+\"#\1\"language\": \"$lang\"#" "$base" \
	> "$agent/extensions/firecode/config.jsonc"
grep -qE "^[[:space:]]*\"language\": \"$lang\"" "$agent/extensions/firecode/config.jsonc"

cat > "$root/tmux.conf" <<'EOF'
set -g status off
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -g extended-keys on
set -g extended-keys-format csi-u
EOF
cp "$(dirname "$0")/mouse.sh" "$root/mouse.sh"

if [[ $lang == zh ]]; then
	about="时长工具库。测试：\`npm test\`（node --test）。保持简单：只做被要求的事，不加没被要求的抽象、配置或兼容层。"
	formatDoc='秒数 → "1h30m" 形式；0 写作 "0s"。'
	parseDoc='"1h30m"、"500ms" 这类时长 → 秒数。'
else
	about="Duration utilities. Tests: \`npm test\` (node --test). Keep it simple: do only what is asked; no unrequested abstractions, config or compatibility layers."
	formatDoc='Seconds → "1h30m" form; 0 is written "0s".'
	parseDoc='Durations like "1h30m" or "500ms" → seconds.'
fi

cd "$root/repo"
cat > package.json <<'EOF'
{ "name": "duration", "type": "module", "scripts": { "test": "node --test" } }
EOF
printf '# duration\n\n%s\n' "$about" > AGENTS.md
{ echo "/** $formatDoc */" && cat <<'EOF'; } > duration.js
export function formatSeconds(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join("") || "0s";
}
EOF
cat > duration.test.js <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { formatSeconds } from "./duration.js";

test("formatSeconds", () => {
	assert.equal(formatSeconds(5400), "1h30m");
	assert.equal(formatSeconds(0), "0s");
});
EOF
# 演示缺陷：交替分支 m 排在 ms 前面，"500ms" 被读成 500 分钟（30000 秒）而不是 0.5 秒。
{ echo "/** $parseDoc */" && cat <<'EOF'; } > draft/parse.js
const UNIT = { h: 3600, m: 60, s: 1, ms: 0.001 };

export function parseDuration(text) {
	let total = 0;
	for (const [, n, unit] of text.matchAll(/(\d+)(h|m|s|ms)/g)) total += Number(n) * UNIT[unit];
	return total;
}
EOF
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
