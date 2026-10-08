# session：会话层功能

预设、改名、统计、herdr 身份投影。`features.stats` 控制 `/tokens` 与 `/quota`，其余功能各自独立。

| 文件 | 职责 |
| --- | --- |
| `presets.ts` | 预设切换：模型原子、工具集、附加指令；生效中的预设名以 `preset` 状态键发布（accent 色名字，不带图标），输入框下边框显示；只有改了工具集或附加指令（边框看不见的改动）的预设才发布，只改模型与思考档的不发布 |
| `rename.ts` | 输入框里按宿主改名键（`app.session.rename`，默认 Ctrl+R，随 keybindings.json 走）弹输入框改会话名；请求由 statusbar 发布，故依赖 `features.statusbar`；不提供 `/rename`（宿主自带 `/name`） |
| `herdr-display.ts` | 会话身份投影到 herdr 的 agent 副标题 |
| `stats.ts` | 统计入口；`/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `quota.ts` | `/quota` 按需查询 Codex、Claude 与 Fable 订阅剩余额度 |

预设状态在每次变化时写进当前分支（清除记 null），重开会话或切分支按该分支最后一条记录判定：
宿主恢复的模型仍是预设的才生效，否则预设失效、清掉名字与指令并记入会话；切到另一个预设不算失效。
`/preset （无）` 与选择器里的“（无）”同为清除。调 Pi 接口前才把模型原子的 provider 与模型名拆开。

## quota

`/quota` 查询已在 Pi 中 OAuth 登录的 Codex、Claude 订阅剩余额度，并展示接口提供的 Fable 周额度。
结果带查询时间，不打断当前工作、不发送给模型；未登录或查询失败会明确显示。查询没有后台刷新或磁盘缓存，
结果是供应商返回的快照，不保证供应商零延迟。Fable 与总体周额度共享约束，不是额外额度。
`features.stats` 控制 `/quota` 和本地用量统计 `/tokens`。

只复用 Pi 的 OAuth 登录，由模型注册表解析凭据；不读取其他 CLI 的登录文件。每次命令并行请求两家供应商，
同一会话只允许一个在途查询；一家失败不隐藏另一家的结果，会话退出取消请求并丢弃迟到通知。

Claude 只解析当前接口的 `limits[]`，`session`、`weekly_all` 与 Fable 的 `weekly_scoped` 分别展示。
`is_active` 为 false 的窗口仍可能有有效额度，不能据此过滤。Fable 是共享额度下的模型限制，不是额外额度；接口未提供时
明确说明。接口结构异常报错，不猜数字或回退旧字段。供应商接口是非公开契约，变更需以真实响应重新核实。

## herdr-display

投影内容见文件头注释；`tokens.session` 把会话名供给侧边栏行布局（herdr 侧边栏只消费自定义 token，用户 herdr 配置的 pi 行布局引用 `$session`）。

workspace、pane label 与 tab label 都归 herdr、用户或 Master 管；FireCode 不写这些持久名称——tab 是多 pane
共享状态，而 herdr 没有条件 rename/CAS 与清除自定义名的接口，先检查再 rename 无法消除 split/move 竞态。

改名不从 `rename.ts` 接线，只听宿主的 `session_info_changed`（命令、快捷键、自动命名已在宿主收口），另听
model/thinking 选择。同一身份不重发，只有确认送达才记为已发布，请求串行避免乱序覆盖，失败静默并由下一
事件重试。非 TUI 模式（print/json/rpc）不投影：无头调用不能接管可见会话的显示。只有 `quit` 清空副标题，
reload/new/resume/fork 由新会话覆盖。没有 feature 开关。
