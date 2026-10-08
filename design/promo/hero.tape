# 指挥官并行派 3 个调研员统计本仓库三个目录，回来汇总成一张表。
# 重录：在本目录执行 ./record.sh en|zh hero（约 1 分钟，真实调用模型）；setup-demo.sh 重建现场，再把本仓库克隆进去当演示仓库。
# 末帧另存 /tmp/firecode-promo-hero{{suffix}}.png，是 og.html 右侧截图的来源。
Output hero{{suffix}}.gif
Output hero{{suffix}}.mp4
Set Shell zsh
Set Width 1200
Set Height 700
Set FontSize 14
Set FontFamily "Maple Mono NF CN"
Set Padding 14
Set Margin 14
Set MarginFill "#2a1208"
Set WindowBar Colorful
Set BorderRadius 10
Set Framerate 24
Set PlaybackSpeed 1.25
Set TypingSpeed 25ms
Hide
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh {{lang}} && git clone -q ../.. /tmp/firecode-promo/firecode && cd /tmp/firecode-promo/firecode && clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium`
Enter
Sleep 5s
Show
Sleep 500ms
Type "{{hero_task}}"
Sleep 400ms
Enter
# 子代理约在发出后 6–15 秒间运行
Sleep 8s
Wait+Screen@180s /─ ✓ [0-9]/
Sleep 3s
Screenshot "/tmp/firecode-promo-hero{{suffix}}.png"
Sleep 2s
