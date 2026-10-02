# master：进程内多 Agent 主控

新会话按 `master.autoActivate` 注入七命令工具 `subagents` 与池快照查询 `subagents_list`；默认开启。裸 `/fire-master` 翻转当前会话，`/fire-master status` 查看状态；下一次会话仍按配置决定，命令不写回。配置或角色表有误时拒绝激活，不用默认模型代替。

## 运行时

所有子会话只经 `spawn.ts` 创建：它封装 Pi SDK 会话、模型、工具（含只属于该子会话的自定义工具）、扩展、
系统提示、上下文文件与持久化，并以显式角色控制 FireCode 的子会话注册。Worker 使用 file 会话，文件位于主会话目录下的 `subagents/`，不会出现在 `/resume`；会话路径是档案身份的唯一事实源。同一路径只允许一个热会话持有者。

Worker 档案是 v8：`working / idle / reviewing` 三态，以 `role` 记录派发角色、`model` 与 `thinking` 记录实际原子；另有 `interruptedAt` 与 `reviewNeeded` 两个独立标记，`disposition` 只记录落定事件是否待发落。reload 把在飞状态收敛为 `idle + interruptedAt`，保留会话与审查义务。首次续派会前置现场核对提示。

热冷只属于运行时缓存：池不订阅会话事件自判空闲，只有 Master 在回合落定、中断落定、审查落定时 `markIdle` 才起释放计时，因此 reviewing 中的 Worker（审查期间它自己是闲的，修复回合结束也会落定）不会被释放；到期释放先经该会话的 extensionRunner 发 `session_shutdown`（reason quit）让会话内扩展收口，再 dispose——与宿主替换会话的顺序一致，否则会话里跑着的 fire-review 会成为握着死 ctx 的孤儿。档案与 JSONL 保留；后续 `send` 打开原会话继续。档案存在但文件缺失时明确失败，不创建新会话冒充恢复。`kill` 在同步段内删档案与内存引用，再等待 session_shutdown 收口后释放热会话，永不删除 JSONL。异步回写只属于满足 `runtime === active` 的当前 runtime；会话关闭先清空当前 runtime，再释放池、订阅与定时器，迟到任务不写状态、投递、UI 或持久化。

## 工具契约

`subagents` 只有七个命令动作，结构上都要求 Worker：

- `start`：显式指定角色表内的 role 和短名；可用 thinking 覆盖角色原子档，可带 cwd、review。
- `send`：working Worker 的普通 send 经宿主 `session.steer` 在句缝送达，不打断（仅回合确在流式时；steer 是子会话自己的消息队列，与根 AGENTS.md 两条主会话 `sendMessage` 红线无关，且只在流式中使用，不会唤起歇透会话）。切换 role、thinking 或 cwd 要求 Worker 空闲，working 时提示先 `interrupt`，reviewing 时等落定。省略 role 时沿用，显式传入时原地切换角色；thinking 可单独覆盖。带 cwd 时释放热会话并以新目录重开同一份 JSONL（不新建会话），档案记新 cwd；Worker 的 cwd 已不存在且未带 cwd 时明确报错并提示带 cwd。steer 入队后回合若以中断等方式结束，滞留队列的补充说明在落定时清出并作为事件回报指挥官重发，不留到下次 prompt。
- `interrupt`：中止 working 回合，保留会话、义务并产生续跑提醒。`start` 与 `send` 等回合真正在飞才返回：宿主 prompt 的前置阶段仍报空闲，落在那里的 abort 会被静默丢弃。
- `review`：只对 idle Worker 显式发起 fire-review。
- `tail`：读取最近外部输入后的预算式轨迹快照，不改变状态。
- `ack`：消除待发落标记；审查义务未履行时拒绝。
- `kill`：移除池引用；实现票完成收口或放弃整票时使用。

`subagents_list` 是零参数查询：模型结果只返回池快照；折叠工具行显示池计数与每个 Worker 的「角色·状态」，展开后每个 Worker 一行以角色为主投影当前工具与耗时、审查轮次进度或落定相对时间，模型与思考档降为行尾次要信息。
## 活动列表

`activity-list.ts` 在输入框上方（widget aboveEditor）逐行列出子代理，布局与火苗复用根级 `activity.ts` / `flame.ts`；输入框边框只显示 Master 发布的纯文字“指挥官”。上榜：working（火苗 + 当前工具，无工具时“思考中”）、reviewing（审查第 N 轮 · k/n 通过）、待发落（有本进程落定事实或持久化 disposition 的空闲 Worker：✓ 已返回 / ✗ 失败或中断，文字转暗）；`ack`、续派或 `kill` 后不再列出。落定事实（时刻与成败）只在运行时记录，reload 后待发落行按已冷却的完成态显示且不带耗时。右侧耗时：运行中取本次运行起点，落定行冻结在落定时刻。

超过 `ACTIVITY_ROWS` 行时保留顺序为待发落、审查、运行，保留行仍按启动顺序，末行“… +N 个”。动画时钟只在有行在动（运行、审查、落定过渡未播完）时订阅 `flame.ts` 的 `onFrame`，全部静止即取消，Master 自身不持有计时器。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经根级 `deliver.ts` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息：主回合进行中投卡片、经宿主 steer 队列在句缝（当前 assistant 与工具结果之后）送达；主回合歇透时改走 `sendUserMessage` 前门唤起（用户消息形态，带完整 `before_agent_start` 仪式，见根 AGENTS.md 硬约束）。事件入队处统一在正文末尾追加一行耗时（reload 重放的 pending 事件已带落定时的耗时，不再追加）：Worker 本次运行（自最近一次 start/send/review 投递起，到落定或中断时刻止；续跑提醒取到中断时刻，不含此后的闲置；reload 后起点丢失则省略）与指挥官当前任务（自最近一条非 extension 来源的用户输入起，Master 事件不重置）；两个起点各只有运行时一处记录，格式复用 `formatDuration`，只追加在事件正文内，不触碰投递路径。进入模型上下文的事件与复活自检统一包在 `<firecode_master_event>` 中，一条消息里每个事件各占一层信封（格式由根级 `deliver.ts` 拥有）。展示卡没有独立数据：折叠卡与折叠展开态的“↳ 名字 已返回”行都从信封正文解析标题、时长与首句（分节标记 `event-format.ts` 与 `tools/machine.ts` 同步）。

`review:true` 是持久化到票上的审查义务，不自动开审；它在 `send`、reload、中断和失败后保留并阻止 `ack`，由审查通过或质量裁决停止消除。`kill` 随整票删除义务。

Master 调度行为与 Worker 行为的唯一事实源分别是 `prompts/master.zh.md` 与 `prompts/worker.zh.md`；修改委派纪律或 Worker 约束时改对应提示词，不在本文复述。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫检查真实路径必须位于当前 checkout；bash 仍是可信能力，最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`，并订阅 Worker 会话里的 review checkpoint 事件投影审查进度；bark 只读取 v8 持久化状态，工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。
