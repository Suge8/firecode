# FireCode

pi 的个人定制层：启动横幅、底部状态栏、工具行渲染、预设与重命名、Anthropic OAuth 归因、`/fire-review` 对抗性审查与按需 `/master` 多 Agent 主控。
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
| `master/` | `/master`：Goal 保活、共享任务板、写域租约、动态模型路由与 Herdr Worker 控制 |
| `format.ts` `theme.ts` | 共享的宽度/文本格式化与品牌配色、阈值分级 |
| `config.ts` | 只读本目录 config.jsonc |

`statusbar/render.ts` 与 `statusbar/layout` 相关函数是纯函数，测试覆盖在 `tests/layout.test.ts`。
`tools/grouping.ts` 依赖 pi 内部组件树与原型 patch，是与宿主耦合最紧的一处，升级 pi 时优先检查。
`review/state.ts` 是 `/fire-review` 的唯一状态事实源（纯 reducer，零 IO），循环状态只经 reduce() 迁移，
副作用全在 `review/index.ts` 执行器；结果卡渲染器在 registerReview 顶层无条件注册（不懒加载），
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
reload 不产生 `agent_end`，因此 session_start 恢复到 `queued`/`awaiting_fix` 且会话空闲时必须主动推进，
否则审查会永远停在活动态并挡住下一次 `/fire-review`。
审查者的只读是契约而非能力边界：排除 write/edit 只挡住这两个工具，保留的 `bash` 仍能在项目目录
执行任意命令。保留 bash 是有意的——审查者要跑测试取证；真需要物理隔离得上容器或只读挂载。
FAIL 输出契约以 `review/prompts/review.{zh,en}.md` 为唯一事实源：每条发现必须六要素齐全
（标题、严重程度、问题、证据、违反的契约、验证命令），同票混入非法发现整票作废为基础设施错误。

## Master

Master 默认休眠：普通 Pi 不带 `herdr_agents` / `team_board`，`/master` 后只追加这两个工具；Worker 只带 `team_board`。
所有 Worker 共享当前 checkout，不创建 worktree。`master/state.ts` 是 Goal、任务、依赖、Worker、消息、模型故障与写域租约的唯一状态事实源；Master 进程通过 mode 0600 的 Unix socket 串行处理 Worker 请求，状态用 Pi custom entry 持久化。Worker 的 edit/write 必须命中其独占 writeScopes，Master 在租约释放前也不能改对应路径；Worker 的 Git 写操作、Herdr、子 Agent和依赖安装由 tool hook 阻断。

速度优先：实现默认 Sol medium、调研默认 Luna，并按任务调整；质量由项目验证、实现会话的精确 `/fire-review` 和 Master 最终验收保证。模型表是动态偏好，不是硬绑定；运行时以 `ctx.scopedModels` / 可用目录为准，对 quota/auth/model unavailable 与重复 transient 故障按 Provider/模型熔断并回退。任务数与并行数没有固定上限，但只有依赖已清、写域可得和模型健康的任务可运行。

`master/playbooks/upstream/` 是固定上游 commit 的完整中文译文；本地映射只写在 `router.zh.md` / `adaptation.zh.md`，不得直接改译文。`/fire-review` 终态通过本地 event bus 回传对应 Worker，再由 Team Board 关闭任务；Master 发送前必须同时核对 pane 和持久 session path，禁止按名字猜会话。

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
