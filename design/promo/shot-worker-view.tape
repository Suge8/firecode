# 子代理全过程视图：指挥官派一个工程师，点开它的活动行进入全屏浮层，在底部输入框补一句话后截图。
# 打开视图、补话后与全部展开的中间态另存在 /tmp/firecode-promo-worker-*.png 备挑。
# 重录：在本目录执行 vhs shot-worker-view.tape（约 2–3 分钟，真实调用模型）；点击经 tmux 前缀键 Ctrl+B 1 调 mouse.sh。
Output "/tmp/firecode-promo-worker.gif"
Set Shell zsh
Set Width 1200
Set Height 760
Set FontSize 14
Set FontFamily "Maple Mono NF CN"
Set Padding 14
Set Margin 14
Set MarginFill "#2a1208"
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 25ms
Hide
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh && git -C /tmp/firecode-promo/repo rm -rq draft && git -C /tmp/firecode-promo/repo -c user.name=demo -c user.email=demo@example.com commit -qm 去掉草稿 && m=/tmp/firecode-promo/mouse.sh && tmux -L promo -f /tmp/firecode-promo/tmux.conf new -d -s promo -c /tmp/firecode-promo/repo && tmux -L promo bind 1 run-shell "$m click '工程师 · '" && tmux -L promo attach -t promo`
Enter
Sleep 1s
Type "clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium"
Enter
Sleep 5s
Type "派一个工程师给 duration.js 补 parseDuration：把 1h30m、500ms 这类时长转成秒，带测试"
Enter
Wait+Screen@120s /工程师 · /
Sleep 10s
Ctrl+B
Type "1"
Sleep 2s
Show
Screenshot "/tmp/firecode-promo-worker-a.png"
Type "顺便确认 0s 和空串的行为"
Sleep 300ms
Screenshot "/tmp/firecode-promo-worker-b.png"
Enter
Sleep 4s
Screenshot "/tmp/firecode-promo-worker-c.png"
# 子代理一完成就截：指挥官收到结果后会很快 kill 它，视图随即变成“已移除”。
Wait+Screen@240s /✓ 完成/
Sleep 1500ms
Screenshot shot-worker-view.png
Ctrl+O
Sleep 500ms
Screenshot "/tmp/firecode-promo-worker-d.png"
Escape
Sleep 1s
Hide
Type "/quit"
Enter
