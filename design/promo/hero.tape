# 重录：git clone 本仓库到 /tmp/firecode-demo，在本目录执行 vhs hero.tape
# 需要已装 FireCode 的 ~/.pi/agent（claudeSub 开着）；在 herdr 内运行时先 unset HERDR_* 与 PI_* 环境变量
Output hero.gif
Output hero.mp4
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
Type "cd /tmp/firecode-demo && clear && pi --model anthropic/claude-sonnet-5-5:medium"
Enter
Sleep 4s
Show
Sleep 500ms
Type "派 3 个调研员并行：分别统计 master/、review/、tools/ 的文件数、总行数和最大的文件，回来只给一张汇总表"
Sleep 400ms
Enter
# 子代理约在发出后 6–15 秒间运行
Sleep 8s
Wait+Screen@180s /─ ✓ [0-9]/
Sleep 3s
Sleep 2s
