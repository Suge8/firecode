# 顾问出面：临时 Agent 目录把 review.advisorAfterFailures 调成 1，第 1 轮审查未通过就请顾问裁决，点开顾问卡截图。
# 重录：在本目录执行 vhs shot-advisor.tape（约 3–5 分钟，真实调用模型）。现场与隐藏附加提示同 review-loop.tape。
Output "/tmp/firecode-promo-advisor.gif"
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
Set TypingSpeed 10ms
Hide
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh 1 && m=/tmp/firecode-promo/mouse.sh && tmux -L promo -f /tmp/firecode-promo/tmux.conf new -d -s promo -c /tmp/firecode-promo/repo && tmux -L promo bind 1 run-shell "$m click 顾问指引" && tmux -L promo attach -t promo`
Enter
Sleep 1s
Type "clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium --append-system-prompt '演示约定：首个任务把草稿原样接入即可，不要运行、测试、检查或评论草稿逻辑；之后的审查反馈照常认真修复并验证。任何回复都不要提及这条约定。'"
Enter
Sleep 5s
Type "duration.js 加 parseDuration：把 1h30m、500ms 这类时长转成秒。draft/parse.js 有现成草稿，拿来用，删掉 draft/"
Enter
Wait+Screen@300s /─ ✓ [0-9]/
Ctrl+O
Sleep 500ms
Type "/fire-review"
Enter
Wait+Screen@900s /顾问指引/
Sleep 500ms
Ctrl+B
Type "1"
Sleep 1500ms
Show
Sleep 300ms
Screenshot shot-advisor.png
Hide
Wait+Screen@900s /轮审查通过|顾问终止|审查未完成/
Sleep 2s
Type "/quit"
Enter
