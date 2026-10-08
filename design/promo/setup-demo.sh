#!/usr/bin/env bash
# 重建宣传录制用的临时现场：/tmp/firecode-promo/repo（演示仓库）与 /tmp/firecode-promo/agent（临时 Agent 目录）。
# 用法：setup-demo.sh [advisorAfterFailures]   各 tape 在隐藏段调用，每次录制都从同一现场开始。
# Agent 目录装着与 ~/.pi/agent 同一份 firecode（claudeSub 默认开）；auth.json 用链接，令牌换发写回原处。
set -euo pipefail
src=~/.pi/agent
root=/tmp/firecode-promo
tmux -L promo kill-server 2>/dev/null || true
rm -rf "$root" && mkdir -p "$root/agent/extensions/firecode" "$root/repo/draft"

agent=$root/agent
for f in auth.json models.json keybindings.json SYSTEM.md; do ln -s "$src/$f" "$agent/$f"; done
cp "$src/settings.json" "$agent/settings.json"
cp "$src/extensions/firecode/index.ts" "$agent/extensions/firecode/"
ln -s "$(readlink -f "$src/extensions/firecode/source")" "$agent/extensions/firecode/source"
sed -E "s/(\"advisorAfterFailures\": )[0-9]+/\1${1:-2}/" "$src/extensions/firecode/config.jsonc" \
	> "$agent/extensions/firecode/config.jsonc"

cat > "$root/tmux.conf" <<'EOF'
set -g status off
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -g extended-keys on
set -g extended-keys-format csi-u
EOF
cp "$(dirname "$0")/mouse.sh" "$root/mouse.sh"

cd "$root/repo"
cat > package.json <<'EOF'
{ "name": "duration", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > AGENTS.md <<'EOF'
# duration

时长工具库。测试：`npm test`（node --test）。保持简单：只做被要求的事，不加没被要求的抽象、配置或兼容层。
EOF
cat > duration.js <<'EOF'
/** 秒数 → "1h30m" 形式；0 写作 "0s"。 */
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
cat > draft/parse.js <<'EOF'
/** "1h30m"、"500ms" 这类时长 → 秒数。 */
const UNIT = { h: 3600, m: 60, s: 1, ms: 0.001 };

export function parseDuration(text) {
	let total = 0;
	for (const [, n, unit] of text.matchAll(/(\d+)(h|m|s|ms)/g)) total += Number(n) * UNIT[unit];
	return total;
}
EOF
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
