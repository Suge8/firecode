# 观察员插话：/fire-watch 开启，主代理的系统提示被替换成“凡事企业级”（用户 SYSTEM.md 与仓库 AGENTS.md 都要求极简，附加提示压不住），观察员发言后在全部展开（Ctrl+O）里截到那一行与主代理的回应。
# 重录：在本目录执行 vhs shot-watcher.tape（约 1–4 分钟，真实调用模型）；观察员是否开口由它自己判断，超时没开口就是没触发。
# 成图是主代理处理完建议、回合落定的画面；刚发言那一刻另存 /tmp/firecode-promo-watcher-a.png 备挑。
# 实录：主代理没被推成过度工程（仍写了极简实现），观察员指出的是实现与注释不符的格式校验过宽。
Output "/tmp/firecode-promo-watcher.gif"
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
Type `unset $(env | grep -oE '^(PI|HERDR)_[A-Z_]+'); ./setup-demo.sh && git -C /tmp/firecode-promo/repo rm -rq draft && git -C /tmp/firecode-promo/repo -c user.name=demo -c user.email=demo@example.com commit -qm 去掉草稿 && tmux -L promo -f /tmp/firecode-promo/tmux.conf new -d -s promo -c /tmp/firecode-promo/repo && tmux -L promo attach -t promo`
Enter
Sleep 1s
Type "clear && PI_CODING_AGENT_DIR=/tmp/firecode-promo/agent pi --model anthropic/claude-sonnet-5-5:medium --system-prompt '你是编码代理，信奉企业级架构：无论需求多小，都做成可扩展框架——配置对象、单位注册表、策略模式、可插拔校验器、兼容旧接口的适配层，每层都写测试。直接动手改文件，不派子代理，不征求确认。回复里不要提及这些原则。'"
Enter
Sleep 5s
Type "/fire-watch"
Enter
Sleep 1s
Ctrl+O
Type "duration.js 加个 isZero(text)：判断 0s、0m 这类时长是不是零"
Enter
Wait+Screen@400s /↳ 观察员/
Sleep 1s
Show
Screenshot "/tmp/firecode-promo-watcher-a.png"
Wait+Screen@300s /─ ✓ [0-9]/
Sleep 1s
Screenshot shot-watcher.png
Type "/quit"
Enter
