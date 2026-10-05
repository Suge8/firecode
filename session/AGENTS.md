# session：会话层功能

预设、改名、统计、Bark 通知、herdr 身份投影。`features.stats` 控制 `/tokens` 与 `/quota`，其余功能各自独立。

| 文件 | 职责 |
| --- | --- |
| `presets.ts` | 预设切换：模型原子、工具集、附加指令 |
| `rename.ts` | `/rename` 与 `keys.rename` 改会话名 |
| `herdr-display.ts` | 会话身份投影到 herdr 的 agent 副标题 |
| `stats.ts` | 统计入口；`/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `quota.ts` | `/quota` 按需查询 Codex、Claude 与 Fable 订阅剩余额度 |
| `bark.ts` | 只在 `busy.ts` 的“会话歇下”边沿推 iPhone Bark 通知（恰好一次，含唤醒回合先于事件投递完成而结束的时序；agent_settled 时 isIdle 为 false 不算结束） |

预设的 `model` 是模型原子（`provider/model/thinking`），模型与思考档一起切换；模型套用失败（找不到或没有凭据）时整套不套：思考档、工具集与预设名都不动，只提示原因。
调 Pi 接口前才把 provider 与模型名拆开。

模型、思考档与工具集的事实源是宿主（记在会话里，session_start 之前与切分支时由宿主恢复）；预设只持有宿主不知道的名字与附加指令，
且只在当前模型仍是预设的模型时成立。预设状态在每次变化时写进当前分支（清除记 null），重开会话或切分支按该分支最后一条记录判定：
宿主恢复的模型仍是预设的才生效，否则预设失效、清掉名字与指令并记入会话；会话中手动切走模型（`model_select`）同样失效，
切到另一个预设不算。失效不动宿主的模型、思考档与工具集；`/preset （无）` 与选择器里的“（无）”同为清除。
同进程新开会话复用模块实例，开会话时先清空上一个会话的预设。

bark：同会话固定 id 新顶旧，有子代理待拍板升 timeSensitive（只读 `master/state.ts` 持久化），Worker 静默。

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
