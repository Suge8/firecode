#!/usr/bin/env bash
# 用法：og.sh <hero 末帧 png> <裁切起点 y 像素> <输出 png>，如 og.sh /tmp/firecode-promo-hero.png 222 og-1280x640.png
# 起点选在用户输入那一行的上沿，窗口里才能放下输入、回复表格与底部状态栏。
set -euo pipefail
cd "$(dirname "$0")"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
	--window-size=1280,640 --screenshot="$PWD/$3" "file://$PWD/og.html?shot=file://$1&top=$2" 2>/dev/null
