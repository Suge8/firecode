# FireCode

pi 的个人定制层：启动横幅、底部状态栏、工具行渲染、预设与重命名、Anthropic OAuth 归因与 `/fire-review` 对抗性审查。
单一入口 `index.ts` 只做一件事：按 `config.features` 逐个调 `registerX(pi)`。
每个 register 自己封闭状态，模块之间不互相引用，关掉任何一个不影响其余。

## 模块

| 路径 | 职责 |
| --- | --- |
| `header.ts` | 会话启动横幅，窄终端退化为一行 |
| `statusbar/` | 底部两行：位置/会话名 + 模型/额度/上下文/缓存/速度 |
| `tools/` | 接管 read/bash/edit/write 的渲染，含连续行轨道 |
| `session/presets.ts` | 预设切换：模型、思考等级、工具集、附加指令 |
| `session/rename.ts` | `/rename` 与 `keys.rename` 改会话名 |
| `session/stats.ts` | `/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `provider/claude-sub.ts` | Anthropic OAuth 请求补 Claude Code 归因头 |
| `provider/openai-native/` | 请求层：OpenAI verbosity、OpenAI/xAI Fast（service_tier=priority）、可选原生压缩 |
| `review/` | `/fire-review` 对抗性审查：多模型并行审、顾问仲裁、checkpoint、结果卡、活动条与详情窗 |
| `format.ts` `theme.ts` | 共享的宽度/文本格式化与品牌配色、阈值分级 |
| `config.ts` | 只读本目录 config.jsonc |

`statusbar/render.ts` 与 `statusbar/layout` 相关函数是纯函数，测试覆盖在 `tests/layout.test.ts`。
`tools/grouping.ts` 依赖 pi 内部组件树与原型 patch，是与宿主耦合最紧的一处，升级 pi 时优先检查。
`review/state.ts` 是 `/fire-review` 的唯一状态事实源（纯 reducer，零 IO），循环状态只经 reduce() 迁移，
副作用全在 `review/index.ts` 执行器；结果卡渲染器始终注册（即使 feature 关闭），
reload 与 live 外观一致，渲染器永不抛异常（details 校验失败降级 content 纯文本）。
`review/` 零外部依赖：schema 校验手写纯函数（不引 typebox），reload/new/resume/fork 保留可恢复状态，
quit 才落终态。checkpoint 的键白名单由领域类型 `satisfies` 派生：字段增删不同步会编译失败，
这是校验漂移（曾导致终态写不进去、重启后恢复出幽灵审查）的唯一防线。
`review/ui.ts` 是编辑器上方活动条、`alt+s` 详情窗与编辑器接管：审查等模型结论时替换编辑器，
禁止输入并用 keybindings 匹配 esc 取消（终端增强键盘协议下 esc 不是裸 `\x1b`，不能字面量比较），
`awaiting_fix` 相把输入交还用户；`review/progress.ts` 从子进程事件派生逐模型进度，是纯 UI 态，不入 checkpoint。
子进程 stdout 按行增量消费（不得尾部截断，否则长输出会被误判为空）。

## 配置

只有 `firecode/config.jsonc`。不要新建 keys.json，也不要读项目级配置。
用法写在 jsonc 注释里。快捷键启动时绑定，改完需重启；`ctrl+f` 只改 `openai` 节，其它注释保留。
预设名写入会话记录，重开会话只恢复名字与附加指令，不重放模型和工具切换。
`review` 节（审查者/顾问模型、maxRounds、advisorAfterFailures、timeoutMinutes、tools、background、language）
未知字段、嵌套未知字段与类型错误都报配置问题；不读 pi-flow 的 config.json。
config.jsonc 解析失败或 review 节有任何配置问题时，`/fire-review` 与 checkpoint 恢复都拒绝启动——
静默回退默认模型会拿用户没配的模型真实发起调用。
循环只在 `agent_settled` 后推进，并延迟到下一事件循环重新检查 idle/pending：同一事件的后续 handler
仍可能触发 follow-up，不能在 handler 内立即开审。reload 不产生 settled 事件，因此 session_start 恢复到
`queued`/`awaiting_fix` 且会话空闲时主动推进，否则会永久停在活动态。反馈投递以 `agent_start` 确认启动、最终 `agent_end` 确认未以 error/aborted 结束；
宿主 `sendMessage` 返回 void，不能用同步 try/catch 伪装成异步失败处理。
审查者的只读是契约而非能力边界：排除 write/edit 只挡住这两个工具，保留的 `bash` 仍能在项目目录
执行任意命令。保留 bash 是有意的——审查者要跑测试取证；真需要物理隔离得上容器或只读挂载。
FAIL 输出契约以 `review/prompts/review.{zh,en}.md` 为唯一事实源：每条发现必须六要素齐全
（标题、严重程度、问题、证据、违反的契约、验证命令），同票混入非法发现整票作废为基础设施错误。

## 额度

状态栏 🔋 显示订阅额度余量，支持 openai-codex、anthropic、xai（后两者需 OAuth 登录，
xai 读 `~/.grok/auth.json` 里官方 CLI 的登录态）。抓取由会话启动、切换模型、每轮结束触发，
没有定时轮询。结果与失败退避写在 `~/.pi/agent/tmp/firecode-quota-<provider>.json`，
同时开多个 pi 会话时共享同一次请求；连续失败按 1 → 2 → 5 分钟退避。

## 测试

```bash
bun test agent/extensions/firecode/tests
```

`tests/loader.ts` 把插件目录复制到临时目录并把 `@earendil-works/*` 改写到本地 pi 源码，
供需要运行时值导入的用例（tools、presets、review）使用。
