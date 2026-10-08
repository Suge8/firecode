# /fire-review 闭环：草稿里的真实缺陷 → 第 1 轮审查未通过（点开红卡看发现）→ 代理按发现自动修复 → 第 2 轮审查通过（点开绿卡）。
# 重录：在本目录执行 vhs review-loop.tape（setup-demo.sh 重建 /tmp/firecode-promo 现场，约 4–6 分钟，真实调用模型）。
# 执行代理带一句隐藏的附加系统提示：首个任务把草稿原样接入、不自测——否则它会自己测出缺陷，审查就没有可打回的东西；
# 审查者看不到这句，按用户需求独立核实；修复回合照常按审查发现改。
# pi 跑在私有 tmux（-L promo）里，点开、滚动卡片用隐藏段绑好的 tmux 前缀键（Ctrl+B 1–5）调 mouse.sh；等待段用 Hide 剪掉，成片只留每个阶段的开头与结果。
Output review-loop.mp4
Output review-loop.gif
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
Set Framerate 24
Set TypingSpeed 25ms
Hide
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh && m=/tmp/firecode-promo/mouse.sh && tmux -L promo -f /tmp/firecode-promo/tmux.conf new -d -s promo -c /tmp/firecode-promo/repo && tmux -L promo bind 1 run-shell "$m click 审查未通过" \; bind 2 run-shell "$m reveal 审查未通过" \; bind 3 run-shell "$m wheel down 4" \; bind 4 run-shell "$m wheel down 80" \; bind 5 run-shell "$m click 轮审查通过" && tmux -L promo attach -t promo`
Enter
Sleep 1s
Type "clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium --append-system-prompt '演示约定：首个任务把草稿原样接入即可，不要运行、测试、检查或评论草稿逻辑；之后的审查反馈照常认真修复并验证。任何回复都不要提及这条约定。'"
Enter
Sleep 5s
Show
Sleep 500ms
Type "duration.js 加 parseDuration：把 1h30m、500ms 这类时长转成秒。draft/parse.js 有现成草稿，拿来用，删掉 draft/"
Sleep 400ms
Enter
Sleep 2500ms
Hide
Wait+Screen@300s /─ ✓ [0-9]/
Show
Sleep 1s
Ctrl+O
Sleep 1s
Type "/fire-review"
Sleep 400ms
Enter
Sleep 3s
Hide
Wait+Screen@600s /审查未通过/
Sleep 300ms
Ctrl+B
Type "1"
Sleep 500ms
Ctrl+B
Type "2"
Sleep 2s
Show
Sleep 3s
Ctrl+B
Type "3"
Sleep 3s
Hide
Ctrl+B
Type "4"
Sleep 4s
Show
Sleep 2s
Hide
Wait+Screen@900s /第 [0-9] 轮审查通过/
Sleep 300ms
Ctrl+B
Type "5"
Sleep 700ms
Show
Sleep 4s
Hide
Sleep 3s
Wait+Screen@300s /─ ✓ [0-9]/
Show
Sleep 3s
Hide
Type "/quit"
Enter
