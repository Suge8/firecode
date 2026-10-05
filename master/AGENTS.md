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

`activity-list.ts` 在输入框上方（widget aboveEditor）逐行列出子代理，布局与火苗复用根级 `activity.ts` / `flame.ts`；底栏只发布纯文字“指挥官”。只列 working（火苗 + 与工具行同源的动作词和目标，见 `tools/actions.ts`；无工具时“思考中”）与 reviewing（审查第 N 轮 · k/n 通过）。落定后该行火苗冷却成 ✓ 停留 10 秒、✗ 停留 30 秒再移除（到期由一次性定时器唤醒，不靠帧时钟）；落定事实（时刻与成败）只在运行时记录，不看持久化 disposition，所以指挥官不 ack 也不会让待发落行常驻，reload 后也不展示历史落定行。右侧耗时：运行中取本次运行起点，落定行冻结在落定时刻。

行一律按启动序：运行时在 `start` 同步段取单调序号（名字 → 序号，`kill` 或启动失败时删除），这是唯一排序依据——池数组顺序受并发 `start` 越过 await 的先后影响，不能当启动序；reload 恢复的没有序号，排最前并保持池内顺序。可见行数 `max(4, floor(终端高度/6))`，拿不到高度时 4，超出时末行“… +N 个”；全局展开（ctrl+o）显示全部。窄屏先截短动作文字（保留开头，带 …），放不下再丢角色。动画时钟只在有行在动（运行、审查、落定过渡未播完）时订阅 `flame.ts` 的 `onFrame`，全部静止即取消，Master 自身不持有帧计时器。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回：await 之后的写回一律经 `commit` 重读最新档案再函数式更新，档案已被 kill 就释放热会话并放弃；启动回合的路径都经 `runWorker` 入口重读，准备期间被 kill 的 start 报错、不调模型、不留热会话。steer 越过 await 后回合已落定时清掉滞留队列并报“未送达”，由指挥官重发。

## 在飞数发布

Master 是在飞子代理数的唯一发布者。在飞 = working/reviewing + 已落定但结果事件还在队列或投递中的子代理（`flushEvents` 的 deliver 结束后才扣除，投递失败重试期间仍计入；已落定且事件已交出的未收割子代理不算），所以归零只发生在事件已交给指挥官之后：忙时 steer 由指挥官回合覆盖，闲时前门唤醒由 agent 回合覆盖，上边框、摘要与 Bark 不会在唤醒前出现“歇下”缝隙。同一同步段内的落定与入队合并成一次计算。store 与事件队列每次变化及激活/停用时在进程内事件总线发布 `{ inFlight }`，只在数量变化时发；停用时先发带 `teardown` 的归零——遗弃在飞子代理不是歇下，busy.ts 只结束本段、不发歇下边沿。同时按 0↔正数跃迁发布通用 `herdr:working`（`{ active, label }`，与 `herdr:blocked` 同构，消费者按 active 计数配对）。频道名与 payload 只在根级 `busy.ts` 定义；statusbar、tools、bark 订阅同一个数。herdr 的 pi 集成文件由 herdr 仓库维护，FireCode 只负责发布。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经根级 `deliver.ts` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息：主回合进行中投卡片、经宿主 steer 队列在句缝（当前 assistant 与工具结果之后）送达；主回合歇透时改走 `sendUserMessage` 前门唤起（用户消息形态，带完整 `before_agent_start` 仪式，见根 AGENTS.md 硬约束）。事件入队处统一在正文末尾追加一行耗时（reload 重放的 pending 事件已带落定时的耗时，不再追加）：Worker 本次运行（自最近一次 start/send/review 投递起，到落定或中断时刻止；续跑提醒取到中断时刻，不含此后的闲置；reload 后起点丢失则省略）与指挥官当前任务（自最近一条非 extension 来源的用户输入起，Master 事件不重置）；两个起点各只有运行时一处记录，格式复用 `formatDuration`，只追加在事件正文内，不触碰投递路径。进入模型上下文的事件与复活自检统一包在 `<firecode_master_event>` 中，一条消息里每个事件各占一层信封（格式由根级 `deliver.ts` 拥有）。事件正文第一行是给人看的标题 `<名字> <结果词>`（名字是第一个空格前的词）：落定类为 `已返回`、`失败`、`被中断`、`审查通过（N 轮）`、`审查停止（N 轮）`、`审查未完成`，其余为 `待续跑`、`已切换模型`、`补充说明未送达`；给模型的指令（续派或收口、审查义务）只放在后续正文。失败只由独占一行的 `错误：` 分节表示，审查的原因与顾问意见用 `原因：`、`顾问意见：` 分节。展示卡没有独立数据：折叠卡与折叠展开态的“↳ 名字 已返回”行都从信封正文解析标题、时长与首句（分节标记 `event-format.ts` 与 `tools/machine.ts` 同步）。

`review:true` 是持久化到票上的审查义务，不自动开审；它在 `send`、reload、中断和失败后保留并阻止 `ack`，由审查通过或质量裁决停止消除。`kill` 随整票删除义务。

Master 调度行为与 Worker 行为的唯一事实源分别是 `prompts/master.zh.md` 与 `prompts/worker.zh.md`；修改委派纪律或 Worker 约束时改对应提示词，不在本文复述。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫检查真实路径必须位于当前 checkout；bash 仍是可信能力，最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`，并订阅 Worker 会话里的 review checkpoint 事件投影审查进度；bark 只读取 v8 持久化状态，工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。
