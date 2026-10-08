# 顾问出面：临时 Agent 目录把 review.advisorAfterFailures 调成 1，第 1 轮审查未通过就请顾问裁决，点开顾问卡截图。
# 重录：在本目录执行 ./record.sh en|zh shot-advisor（约 3–5 分钟，真实调用模型）。现场与隐藏附加提示同 review-loop.tape。
# 比其余截图高 80px：英文顾问卡比中文长，760 高放不下卡片标题。
Output "/tmp/firecode-promo-advisor.gif"
Set Shell zsh
Set Width 1200
Set Height 840
Set FontSize 14
Set FontFamily "Maple Mono NF CN"
Set Padding 14
Set Margin 14
Set MarginFill "#2a1208"
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 10ms
Hide
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh {{lang}} 1 && m=/tmp/firecode-promo/mouse.sh && tmux -L promo -f /tmp/firecode-promo/tmux.conf new -d -s promo -c /tmp/firecode-promo/repo && tmux -L promo bind 1 run-shell "$m click '{{advisor_guidance}}'" && tmux -L promo attach -t promo`
Enter
Sleep 1s
Type "clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium --append-system-prompt '{{demo_rule}}'"
Enter
Sleep 5s
Type "{{review_task}}"
Enter
Wait+Screen@300s /─ ✓ [0-9]/
Ctrl+O
Sleep 500ms
Type "/fire-review"
Enter
Wait+Screen@900s /{{advisor_guidance}}/
Sleep 500ms
Ctrl+B
Type "1"
Sleep 1500ms
Show
Sleep 300ms
Screenshot shot-advisor{{suffix}}.png
Hide
Wait+Screen@900s /{{review_end_re}}/
Sleep 2s
Type "/quit"
Enter
