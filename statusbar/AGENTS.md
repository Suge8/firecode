# statusbar：输入框外壳

状态画进编辑器的上下边框横线，没有独立底栏：footer 组件渲染 0 行，只借它拿宿主的扩展状态订阅与主题。编辑器是
`CustomEditor` 子类，只覆写 `renderTopBorder` / `renderBottomBorder`；输入过长滚动出现“↑ n more”时让位给宿主的边框。
会话启动时关闭宿主内嵌的 Working 指示，Working 可见性只在本模块管理（`review/ui.ts` 不再碰它）。显示内容与退让顺序是用户可见行为，见 README。

`render.ts` 是唯一纯布局入口（`topBorder` / `bottomBorder`，两者与子代理视图输入区共用其中的边框布局 `fitBorder`），按实际 `visibleWidth` 逐级退让，不保存状态。

状态的来源与边界：
- 会话进行中、起点与歇下都来自 `busy.ts` 的 `watchBusy`，外壳不另存累计、不自己记起点；这是整个界面唯一的实时计时，过程组摘要行不再并排跳一个。
- 落定态是当前分支最近一条人类消息之后的全部轮记录，经 `tools/round.ts` 的 `latestTurnRecord` 读取，与摘要行同一条合成规则；没有轮记录（工具渲染关闭）就不显示落定态。
- 落定态只在三个时点算一次并存下合成结果、绘制只读：tools 写入轮记录后在 `ROUND_RECORDED_CHANNEL` 上的发布（不取歇下边沿——那一刻记录未必已写进分支，订阅顺序不定）、`session_start`（重开会话直接显示上一轮，不播落定过渡）、`session_tree`。读分支是整条回溯，不能放进每次按键重绘。
- 右侧的“观察员”“指挥官”与预设名是其它模块在 `setStatus` 发布的串，外壳原样组合，不解析彩色串也不维护启用状态；只改模型与思考档的预设不发布名字，发不发布由 `session/presets.ts` 决定。
- 审查进度来自 `review/occupancy.ts` 的占用频道：持有时的 payload 带活的 `progress` 访问器，外壳每次绘制调用它取阶段、轮次与票数；审查锁编辑器时的外壳可见性由 `review/ui.ts` 保证（见 review/AGENTS.md）。

展示标题只属于外壳：正式会话名优先，否则取当前分支首条非空用户文本的首句（`format.ts` 的 `firstSentence`，上限 60 列），尚无文本显示“新会话”。
会话启动、切树、改名和用户消息开始时更新投影，消息落盘前即可显示，逐帧绘制不扫描历史。不写回会话名，不改变官方会话列表
或终端侧边栏。

动效只经 `flame.ts` 的 `onFrame`：仅在回合进行、落定过渡或审查进行时订阅，其余时间时钟停止。
