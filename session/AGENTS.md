# session：会话层功能

预设、改名、统计、Bark 通知、herdr 身份投影、工作火焰。`features.stats` 控制收尾行、`/tokens` 与 `/quota`，其余功能各自独立。

| 文件 | 职责 |
| --- | --- |
| `presets.ts` | 预设切换：模型原子、工具集、附加指令 |
| `rename.ts` | `/rename` 与 `keys.rename` 改会话名 |
| `herdr-display.ts` | 会话身份投影到 herdr 的 agent 副标题 |
| `stats.ts` | 统计入口；`/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `run-summary.ts` | 主会话处理段收尾：静态时长与均速或异常状态，仅展示、不进入模型上下文 |
| `quota.ts` | `/quota` 按需查询 Codex、Claude 与 Fable 订阅剩余额度 |
| `bark.ts` | 任务落定时推 iPhone Bark 通知 |
| `working-flame.ts` | 工作回合内 aboveEditor 居中多行火焰 widget |

预设的 `model` 是模型原子（`provider/model/thinking`），模型与思考档一起切换：模型切换失败时思考档也不动。
调 Pi 接口前才把 provider 与模型名拆开。

预设名写入会话记录，重开会话只恢复名字与附加指令，不重放模型和工具切换。

bark：同会话固定 id 新顶旧，有子代理待拍板升 timeSensitive（只读 `master/state.ts` 持久化），Worker 静默。

working-flame：高随终端自适应 3–10 行，宽不够逐级降高；回合内隐藏 Working 文本行，订阅占用频道在审查
活跃期退让。

## run-summary

仅 TUI 会话采集。耗时从宿主收到本段输入开始；自动发起的处理从启动开始。主会话的自动重试与队列续跑并入
同一处理段，`agent_end` 不结算，`agent_settled` 才写一条收尾。不等待后台子代理或独立审查；中途插话不重置起点。

均速取完整助手响应的供应商 `usage.output` 总和除以对应请求耗时，包含首字等待、网络与请求内部重试，排除
工具和压缩调用。请求起止无法配对、用量缺失或出现不完整响应时，整段不显示均速，不按字符估算。中断优先
读取当前处理的 AbortSignal 和助手终态，压缩中止/失败读取压缩事件的明确结果；不通过错误文案猜重试或网络错误次数。

采集只在同步事件回调更新一个不可变处理段记录，不持有会话正文、不定时刷新。结算先清空采集记录，再经
`appendEntry` 写 CustomEntry，由 `registerEntryRenderer` 原样恢复静态收尾；它不是 CustomMessage，不用
模型消息队列。切树或会话退出丢弃未完成测量，迟到结束事件不产生收尾；已保存的收尾不重新计算。

左侧固定处理时长；正常时右侧显示有效均速，中断/失败显示相应状态。窄屏先省均速，异常时压缩左侧标签。

## quota

只复用 Pi 的 OAuth 登录，由模型注册表解析凭据；不读取其他 CLI 的登录文件。每次命令并行请求两家供应商，
同一会话只允许一个在途查询。结果带查询时间，经 UI 通知显示，不写入模型上下文、不切模型、不暂停工作。
没有自动刷新、文件缓存或失败退避；一家失败不隐藏另一家的结果，会话退出取消请求并丢弃迟到通知。

Claude 只解析当前接口的 `limits[]`，`session`、`weekly_all` 与 Fable 的 `weekly_scoped` 分别展示。
`is_active` 为 false 的窗口仍可能有有效额度，不能据此过滤。Fable 是共享额度下的模型限制，不是额外额度；接口未提供时
明确说明。接口结构异常报错，不猜数字或回退旧字段。供应商接口是非公开契约，变更需以真实响应重新核实。

## herdr-display

把 pi 单向投影到 herdr 的 agent 副标题：`pane.report_metadata` 的 `display_agent` 写 `pi·模型/思考等级`，
`title` 写会话名，同一请求的 `tokens.session` 再把会话名供给侧边栏行布局（herdr 侧边栏只消费自定义 token，
用户 herdr 配置的 pi 行布局引用 `$session`）。

workspace、pane label 与 tab label 都归 herdr、用户或 Master 管；FireCode 不写这些持久名称——tab 是多 pane
共享状态，而 herdr 没有条件 rename/CAS 与清除自定义名的接口，先检查再 rename 无法消除 split/move 竞态。

改名不从 `rename.ts` 接线，只听宿主的 `session_info_changed`（命令、快捷键、自动命名已在宿主收口），另听
model/thinking 选择。同一身份不重发，只有确认送达才记为已发布，请求串行避免乱序覆盖，失败静默并由下一
事件重试。非 TUI 模式（print/json/rpc）不投影：无头调用不能接管可见会话的显示。只有 `quit` 清空副标题，
reload/new/resume/fork 由新会话覆盖。

没有 feature 开关：herdr 之外（无 `HERDR_ENV`）与 Master Worker 内自我禁用。
