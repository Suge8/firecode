# session：会话层功能

预设、统计、herdr 投影。`features.stats` 控制 `/tokens` 与 `/quota`，其余功能各自独立。

| 文件 | 职责 |
| --- | --- |
| `presets.ts` | 预设切换：模型原子、工具集、附加指令；生效中的预设名以 `preset` 状态键发布（accent 色名字，不带图标），输入框下边框显示；只有改了工具集或附加指令（边框看不见的改动）的预设才发布，只改模型与思考档的不发布 |
| `herdr-projection.ts` | 会话在 herdr 里的投影：agent 副标题与 `$session` token、working/idle 状态、恢复命令、退出 release |
| `herdr-client.ts` | herdr socket 短连接客户端，只有 herdr 投影使用 |
| `stats.ts` | 统计入口；`/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT）。按 1MB 块读文件、按字节切行，只解码带 `"usage"` 的行：内存只占一块加当前一行，每块让出事件循环，数百 MB 的会话文件也不超过 Node 的字符串上限、不冻界面；读不了的文件与目录计数并写进报告，不静默漏掉。扫描语义不随优化改变（跟随目录软链接，无时间戳的记录计入任意窗口），不按文件修改时间跳过文件。参数只认纯数字天数，其余提示用法 |
| `messages.ts` | 本目录全部用户可见文案（预设、额度、统计、herdr 侧边栏标签），机制见根 AGENTS.md「文案」 |
| `quota.ts` | `/quota` 按需查询 Codex、Claude 与 Fable 订阅剩余额度 |

预设状态在每次变化时写进当前分支（清除记 null；记录带格式版本，旧版本记录一律当作没有预设），记录里除预设名还有应用前的快照（模型、思考档、工具集），重开会话或切分支按该分支最后一条记录判定：
宿主恢复的模型仍是预设的才生效，否则预设失效、清掉名字与指令、工具集还原为快照的（模型不动）并记入会话；切到另一个预设不算失效。没写 `tools` 的预设用快照里的工具集，所以从带工具集的预设切过去不继承限制。`/preset (无)` 把模型、思考档与工具集都还原为快照，重开会话后同样有效。`--preset` 只在启动（`session_start` 的 reason 为 startup）时应用，重载、恢复、新会话按各自的会话记录走。
`/preset` 带清除项文案（`messages.ts` 的 `presets.clearItem`，中文“（无）”、英文“(none)”）与选择器里的清除项同为清除。调 Pi 接口前才把模型原子的 provider 与模型名拆开。

## quota

`/quota` 查询已在 Pi 中 OAuth 登录的 Codex、Claude 订阅剩余额度，并展示接口提供的 Fable 周额度。
结果带查询时间，不打断当前工作、不发送给模型；未登录或查询失败会明确显示。查询没有后台刷新或磁盘缓存，
结果是供应商返回的快照，不保证供应商零延迟。

只复用 Pi 的 OAuth 登录，由模型注册表解析凭据；不读取其他 CLI 的登录文件。每次命令并行请求两家供应商，
同一会话只允许一个在途查询；一家失败不隐藏另一家的结果，会话退出取消请求并丢弃迟到通知。

Claude 只解析当前接口的 `limits[]`，`session`、`weekly_all` 与 Fable 的 `weekly_scoped` 分别展示。
`is_active` 为 false 的窗口仍可能有有效额度，不能据此过滤。Fable 与总体周额度共享约束，不是额外额度；接口未提供时
明确说明。接口结构异常报错，不猜数字或回退旧字段。供应商接口是非公开契约，变更需以真实响应重新核实。

## herdr-projection

投影内容、状态来源、上报机制与为什么必须卸载 herdr 官方 Pi 集成，都在 `herdr-projection.ts` 头注释。头注释之外：

- 卸载命令是 `herdr integration uninstall pi`；不要在 herdr 设置面板里点 install，会装回来。
- 头注释里的丢弃规则与状态标签（`state_labels.working`）都是 herdr 的行为，升级 herdr 后需重新核实。FireCode 的 source 是 `firecode`（自定义 source 不能以 `herdr:` 开头）。
- `tokens.session` 把会话名供给侧边栏行布局：herdr 侧边栏只消费自定义 token，用户在 herdr 配置里的 pi 行布局引用 `$session`。
- workspace、pane label 与 tab label 都归 herdr、用户或 Master 管；FireCode 不写这些持久名称——tab 是多 pane 共享状态，而 herdr 没有条件 rename/CAS 与清除自定义名的接口，先检查再 rename 无法消除 split/move 竞态。
- 只听宿主的 `session_info_changed`（命令、改名键、自动命名已在宿主收口），另听 model/thinking 选择。同一内容不重发，只有确认送达才记为已发布，请求串行避免乱序覆盖。只有 `quit` 清空身份并 release，reload/new/resume/fork 由新会话的 `session_start` 覆盖（重载时回合已在跑的情形由 `busy.ts` 在 `session_start` 读 `ctx.isIdle()` 补上，herdr 不另算）。
