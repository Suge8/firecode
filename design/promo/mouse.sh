#!/usr/bin/env bash
# VHS 没有鼠标：tape 经 tmux 命令提示符调本脚本，向 promo tmux 会话里的 pi 注入 SGR 鼠标事件。
#   mouse.sh click <文本>       单击最后一处含该文本的屏幕行（按下+松开），打开审查卡、子代理全过程视图这类只能点开的界面
#   mouse.sh wheel up|down <次数>  在屏幕中部滚动滚轮
#   mouse.sh reveal <文本>      向上滚到该文本出现在屏幕上，再多滚一格
set -euo pipefail
send() { tmux -L promo send-keys -t promo -H $(printf "$@" | xxd -p -c1); }
wheel() { for ((i = 0; i < $2; i++)); do send '\e[<%d;40;10M' "$([[ $1 == up ]] && echo 64 || echo 65)"; done; }
case $1 in
click)
	read -r row col < <(tmux -L promo capture-pane -p -t promo | python3 -c '
import sys, unicodedata
pat = sys.argv[1]
hits = [(i, l) for i, l in enumerate(sys.stdin.read().split("\n")) if pat in l]
i, l = hits[-1]
width = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in l[: l.index(pat)])
print(i + 1, width + 2)' "$2")
	send '\e[<0;%d;%dM\e[<0;%d;%dm' "$col" "$row" "$col" "$row"
	;;
wheel) wheel "$2" "$3" ;;
reveal)
	for ((n = 0; n < 40; n++)); do
		tmux -L promo capture-pane -p -t promo | grep -qF "$2" && break
		wheel up 3 && sleep 0.1
	done
	wheel up 2
	;;
esac
