# FireCode

pi 的个人定制层：启动横幅、底部状态栏、工具行渲染、预设与重命名、Anthropic OAuth 归因、`/fire-review` 对抗性审查与按需 `/fire-master` 多 Agent 主控。
单一入口 `index.ts` 只做一件事：按 `config.features` 逐个调 `registerX(pi)`。
每个 register 封闭自己的运行状态，关掉任何一个不影响其余；唯一跨模块接缝是 Master 只读调用 `review/outcome.ts`。

## 模块

| 路径 | 职责 |
| --- | --- |
| `header.ts` | 会话启动横幅，窄终端退化为一行 |
| `statusbar/` | 底部两行：位置/会话名 + 模型/额度/上下文/缓存/速度 |
| `tools/` | 接管 read/bash/edit/write 的渲染，含连续行轨道 |
| `session/presets.ts` | 预设切换：模型、思考等级、工具集、附加指令 |
| `session/rename.ts` | `/rename` 与 `keys.rename` 改会话名 |
| `session/herdr-display.ts` | 会话身份投影到 herdr 的 agent 副标题 |
| `session/stats.ts` | `/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `provider/claude-sub.ts` | Anthropic OAuth 请求补 Claude Code 归因头 |
| `provider/openai-native/` | 请求层：OpenAI verbosity、OpenAI/xAI Fast（service_tier=priority）、可选原生压缩 |
| `review/` | `/fire-review` 对抗性审查：多模型并行审、顾问仲裁、checkpoint、结果卡、活动条与详情窗 |
| `master/` | `/fire-master`：按需注入 `herdr_agents`，启动、追问、审查与停止 Herdr Worker |
| `format.ts` `theme.ts` | 共享的宽度/文本格式化与品牌配色、阈值分级 |
| `config.ts` | 只读本目录 config.jsonc |

`statusbar/render.ts` 与 `statusbar/layout` 相关函数是纯函数，测试覆盖在 `tests/layout.test.ts`。
`session/herdr-display.ts` 把 pi 单向投影到 herdr 的 agent 副标题：`pane.report_metadata` 的
`display_agent` 写 `pi·模型/思考等级`，`title` 写会话名。workspace、pane label 与 tab label 都归 herdr、
用户或 Master 管；FireCode 不写这些持久名称——tab 是多 pane 共享状态，而 herdr 没有条件 rename/CAS 与清除
自定义名的接口，先检查再 rename 无法消除 split/move 竞态。改名不从 `session/rename.ts` 接线，只听宙主的
`session_info_changed`（命令、快捷键、自动命名已在宙主收口），另听 model/thinking 选择。同一身份不重发，
只有确认送达才记为已发布，请求串行避免乱序覆盖，失败静默并由下一事件重试。非 TUI 模式（print/json/rpc）
不投影：无头调用不能接管可见会话的显示。只有 `quit` 清空副标题，reload/new/resume/fork 由新会话覆盖。
`tools/grouping.ts` 依赖 pi 内部组件树与原型 patch，是与宿主耦合最紧的一处，升级 pi 时优先检查。
`review/state.ts` 是 `/fire-review` 的唯一状态事实源（纯 reducer，零 IO），循环状态只经 reduce() 迁移，
副作用全在 `review/index.ts` 执行器；结果卡渲染器始终注册（即使 feature 关闭），使用 pi 原生背景卡与完整 Markdown：
通过为绿底，未通过、终止与异常为红底，其余为紫底；排队相不发卡，开始卡只发第 1 轮，后续轮边界由结果卡轮号承担。reload 与 live 外观一致，渲染器永不抛异常
（details 校验失败降级 content 纯文本）。
`review/` 零外部依赖：schema 校验手写纯函数（不引 typebox），reload/new/resume/fork 保留可恢复状态，
quit 才落终态。checkpoint 的键白名单由领域类型 `satisfies` 派生：字段增删不同步会编译失败，
这是校验漂移（曾导致终态写不进去、重启后恢复出幽灵审查）的唯一防线。
每轮 findings 只完整显示一次；达到顾问阈值时先显示失败卡，若顾问裁定 stop，终止卡只显示顾问裁决，
不再复制同一份 findings。
`review/ui.ts` 沿用 pi-flow `/review` 的活动框与交互：≥ 48 列动态火焰（窄区间收紧边距）、更窄居中退化，
审查者落定即在活动条与详情窗显示一行结果摘要，顾问裁决摘要在迁入的修复相活动条显示（落定与相迁移同微任务链，needs_fix 相无渲染机会）；审查开始自动打开 80%×70% 子代理监控，详情窗仅
`alt+s` 开关（esc 不关窗，与取消语义分离）；等待模型时编辑器完全隐藏并禁止输入，esc/Ctrl+C 取消，
顾问阶段 esc 只跳过咨询，`awaiting_fix` 相把输入交还用户。按键必须经 keybindings/终端转义序列匹配，不能只比裸 `\x1b`。
`review/progress.ts` 从子进程事件派生 M1/M2、token、当前工具耗时及历史工具行，是纯 UI 态，不入 checkpoint。
子进程 stdout 按行增量消费（不得尾部截断，否则长输出会被误判为空）。审查活跃期经进程内
`herdr:blocked` 频道配对持有“对抗审查进行中”，终态、取消、退出时释放，reload 恢复时重新持有；
该显示信号失败不影响审查。`review/outcome.ts` 是外部读取终态判定的唯一入口，checkpoint 格式仍归 review 所有。

## 配置

只有 `firecode/config.jsonc`。不要新建 keys.json，也不要读项目级配置。
用法写在 jsonc 注释里。快捷键启动时绑定，改完需重启；`ctrl+f` 只改 `openai` 节，其它注释保留。
预设名写入会话记录，重开会话只恢复名字与附加指令，不重放模型和工具切换。
`herdr-display` 没有 feature 开关：herdr 之外（无 `HERDR_ENV`）与 Master Worker 内自我禁用。
`review` 节（审查者/顾问模型、maxRounds、advisorAfterFailures、timeoutMinutes、tools、background、language）
与 `master` 节（models 选型表：模型 id + 默认 thinking + 适用场景，注入 herdr_agents 提示词）
未知字段、嵌套未知字段与类型错误都报配置问题；不读 pi-flow 的 config.json。
master 节有配置问题时 `/fire-master` 激活与恢复拒绝启动——选型表错误会拿错模型真实发起 Worker。
config.jsonc 解析失败或 review 节有任何配置问题时，`/fire-review` 与 checkpoint 恢复都拒绝启动；
活动 checkpoint 保持原样，修好配置并重启后继续恢复——静默回退默认模型会拿用户没配的模型真实发起调用。
`session_start` 只恢复 checkpoint，宿主在所有异步 session_start handler 完成后发出的 `resources_discover`
才允许推进；`agent_settled` 由 review 判断能否开审。
`agent_start` 另作竞态兜底：若审查仍在跑，先 abort 并等待全部子进程退出，执行模型才进入 turn_start。
`awaiting_fix` 把修复生命周期 `pending → awaiting_start → running → completed` 写进 checkpoint；reload
会重投未确认完成的反馈，只有 completed 才进入下一审查轮。宿主 `sendMessage` 返回 void，因此反馈用
`agent_start` 确认启动、最终 `agent_end` 确认未以 error/aborted 结束，不靠同步 try/catch 猜异步结果。
审查者的只读是契约而非能力边界：排除 write/edit 只挡住这两个工具，保留的 `bash` 仍能在项目目录
执行任意命令。保留 bash 是有意的——审查者要跑测试取证；真需要物理隔离得上容器或只读挂载。
FAIL 输出契约以 `review/prompts/review.{zh,en}.md` 为唯一事实源：每条发现必须六要素齐全
（标题、严重程度、问题、证据、违反的契约、验证命令），同票混入非法发现整票作废为基础设施错误。

## Master

Master 默认休眠：普通 Pi 不带 `herdr_agents`，`/fire-master` 后只追加这一个工具。没有 Goal、Task 或任务板。
`herdr_agents` 是唯一接口：start / send / review / list / stop。提示词决定何时委派、模型选型（依据 config 选型表，首次派发前把分波计划和每票模型一次性列给用户确认）和委派文本；
工具只负责 Worker 生命周期、审查发起和异步结果回传。结果用 custom follow-up message 投递，不轮询、不拼进用户输入；
Master 回合进行中到达的结果暂存，agent_settled 后合并成一条再投（宿主 followUpMode 默认一回合一条，拆投会裂成多回合）。
Live Worker 可 stop 为保留上下文的 Dormant Worker；Herdr 报 `blocked` 时保持阻塞态并把 `state_labels` 中的问题通知
Master，Master 用 send 回答后继续。`idle` 与未查看后台结果 `done` 都保留为可追问的 Live Worker，最终 assistant
只有以 `stop` 结束才回传完成；`length`、`toolUse`、`error`、`aborted`、缺失回复均按失败回传。普通工作监听用
无截止事件等待，连接失败后保持 `working` 并退避重挂。start 传 Dormant 名或 session path 即可恢复，forget 才删除引用。
新 Worker 优先在当前 Worker tab 内 split（2×2 象限切，避免嵌套同向切把后来者挤成 1/8 宽），每 tab 最多 4 个，
满或 split 失败才建 tab；单工人 tab 标签是其显示名，第二个工人加入后改组名 `workers`；不 rebalance，
Dormant 恢复建新 tab。中止或清理共享 tab 里的工人只收其 pane，不连坐关 tab；reload 时旧运行时
静默退场（等在飞启动退出、不关 shell 不写状态），现场由新运行时 reconcile。
命名四层统一：pane/tab/Pi 显示名为 `任务名-模型名`（Pi 前缀 `↳`，不截断），Herdr agent 名是其净化版
（字符集硬约束 [a-z0-9_-]、32 封顶，点号降为 `-`）；start 必须提供短任务词，没有 worker-N 退化；
pane 命名失败不影响启动只通知。
只有 `idle` Worker 可 review，且 review 关闭或配置有误时 action 在投递前拒绝（否则命令会退化成普通模型输入）。
Master 只对产出代码变更的重要交付发起 review，发起前须确认没有其它 Worker 正在写共享 checkout；只读调查型 Worker 照常并行，不阻塞审查，也不被审查。
代码固定投递字面 `/fire-review`（`prompt --wait` 等投递后状态变化，stalled 时以 runId
是否推进判定是否真的启动），状态转为 `reviewing`，在 `/fire-master status` 和状态栏显示并拒绝 send。审查监听只等
`idle` / `done`，跳过 `blocked` 占用态；若结算时 outcome 仍是 in_progress（占用信号失效）则退避重挂直到终态，
reload 按同样规则恢复；终态经 `review/outcome.ts` 读取并连同最终回复回传（passed / stopped=质量裁决终止，
含 maxRounds 用尽 / failed=error·cancelled·timed_out 等审查未完成，不弱化成停止）。
Worker Pool 状态 schema 为 v4、兼容 v3，用 mode 0600 的单个文件原子覆盖，不向 Pi session 追加快照；reload 恢复观察，
quit/new/resume/fork 和 `/fire-master off` 清理。本插件不依赖 planning skill；多个 Worker 可并行写共享 checkout，Master 负责最终集成与验证。
仅当已有本次流程的 `.scratch/` Tracker 时，Master 才按 Ticket 阻塞边分波、并行首批调查、逐波集成验证并完成删票；
审查自动修复期间不 start/send，整体收口派专门 Worker，Master 只派活、分析和决策。没有 Tracker 的日常委派仍按需直接进行。
实现类委派（有 spec/工单）以 `/skill:implement ` 开头，注明跳过技能内 code-review 与提交步骤；
斜杠技能只在文本开头且后跟空格才展开，写错静默失效。
Worker 带 `FIRECODE_MASTER_WORKER` 启动，用 pi 默认工具集（read/bash/edit/write，ADR-0004），能自跑测试；
隔离是纪律不是能力边界：系统提示禁令（herdr、git commit/push、装依赖、越界写）+ 自测义务 +
fire-review + Master diff 检查 + git 回滚。`tool_call` 仍把 edit/write 限在当前 checkout（含真实路径
解析），定位是防误伤——bash 可绕过，不伪装成隔离；真需物理隔离得上容器或只读挂载。
新 tab 用 zsh precmd 标记等真实 shell prompt。
fire-review 不与 Master 交换运行身份或关联身份；Master 只从外部发起命令并只读判定。

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
