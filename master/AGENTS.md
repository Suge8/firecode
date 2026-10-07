# master：进程内多 Agent 主控

新会话按 `master.autoActivate` 注入七命令工具 `subagents` 与池快照查询 `subagents_list`；默认开启。裸 `/fire-master` 翻转当前会话，`/fire-master status` 查看状态；下一次会话仍按配置决定，命令不写回。配置或角色表有误时拒绝激活，不用默认模型代替。

## 运行时

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 注册入口：激活与停用、命令、两个工具与生命周期 |
| `runtime.ts` | 一个指挥官会话的运行时：档案 store、按名字索引的 Worker 运行时事实表（live）、活动列表投影；`current`/`commit` 是 await 后唯一的重读与写回点 |
| `outbox.ts` | 事件发件箱：pending/ack 持久化、合并投递、重试、耗时行与在飞数计算 |
| `run.ts` | 回合编排：打开会话、跑回合、按终态落定（成功/失败/中断/fallback 续跑）、审查监视、中断续跑提醒 |
| `actions.ts` | 七个命令动作的处理函数，表驱动分发 |
| `list-view.ts` | 工具行、池快照展开与 status 文本，纯投影 |
| `guard.ts` | Worker 会话里唯一注册的 edit/write 守卫：只放行当前 checkout 与系统临时目录 |
| `spawn.ts` | 全插件唯一的子会话入口：模型解析、单写者登记与热会话生命周期 |
| `state.ts` `event-format.ts` `activity-list.ts` | 档案格式、事件产文、活动列表 |
| `worker-view.ts` | 子代理全过程视图：点活动列表一行打开全屏浮层，用过程组投影看完整记录并可补话 |

Worker 是主进程内的 SDK 子会话而非独立进程：reload 会中断在飞回合（JSONL 与审查义务保留、可续派），换来父进程退出即全停、无幽灵进程与跨进程对账。池只管 Worker 生命周期与结果回传，不建 Goal、Task、任务板或消息总线；多个 Worker 可并行写同一 checkout，没有写租约，集成与验证归指挥官。

所有子会话只经 `spawn.ts` 创建：它封装 Pi SDK 会话、模型、工具（含只属于该子会话的自定义工具）、扩展、
系统提示、上下文文件与持久化，并以显式角色控制 FireCode 的子会话注册。模型原子也只在池里解析：每个池只建一份 ModelRuntime（auth.json 与 models.json 只读一次），扩展注册的 provider 在模型解析时不可见。这份 ModelRuntime 同时交给池里建出的每个子会话，所以某个子会话里扩展注册的 provider 对同池其他子会话也可见（宿主跨会话复用服务也是如此）。单写者登记挂在 globalThis 上，宿主重新求值模块图时仍是进程唯一。Worker 使用 file 会话，文件位于主会话目录下的 `subagents/`，不会出现在 `/resume`；会话路径是档案身份的唯一事实源。同一路径只允许一个热会话持有者。

Worker 档案是 v9：`working / idle / reviewing` 三态，以 `role` 记录派发角色、`model` 与 `thinking` 记录实际原子，`launch` 记录启动序（v8 档案加载时就地升级：按 v8 的创建时间补启动序，整池保留；更早版本仍丢弃并告知）；另有 `interruptedAt` 与 `reviewNeeded` 两个独立标记，`disposition` 只记录落定事件是否待发落。reload 把在飞状态收敛为 `idle + interruptedAt`，保留会话与审查义务。首次续派会前置现场核对提示。

热冷只属于运行时缓存：池不订阅会话事件自判空闲，只有 Master 在回合落定、中断落定、审查落定时 `markIdle` 才起释放计时，因此 reviewing 中的 Worker（审查期间它自己是闲的，修复回合结束也会落定）不会被释放；释放热会话后池通知持有方，Master 随即退订，不再持有已关闭的会话；到期释放先经该会话的 extensionRunner 发 `session_shutdown`（reason quit）让会话内扩展收口，再 dispose——与宿主替换会话的顺序一致，否则会话里跑着的 fire-review 会成为握着死 ctx 的孤儿。档案与 JSONL 保留；后续 `send` 打开原会话继续。档案存在但文件缺失时明确失败，不创建新会话冒充恢复。`kill` 在同步段内删档案与该名下的整条运行时事实（计时器、订阅、当前工具、落定结局一次清掉），再等待 session_shutdown 收口后释放热会话，永不删除 JSONL；start 失败同样只撤自己这一票的事实。异步回写只属于未关闭的当前 runtime；会话关闭先清空当前 runtime 并置 closed，再释放池、订阅与定时器，迟到任务不写状态、投递、UI 或持久化。

档案存在 Pi Agent 目录（`getAgentDir()`，含 `PI_CODING_AGENT_DIR` 覆写）的 `tmp/firecode-master-<主会话 id>.json`，事件的 pending/ack 存在主会话 JSONL：fork 出的会话带着 pending 却没有档案，重投时可能提到不在池里的 Worker——这是已知边缘，接受。

## 工具契约

`subagents` 只有七个命令动作，结构上都要求 Worker：

- `start`：显式指定角色表内的 role 和短名；可用 thinking 覆盖角色原子档，可带 cwd、review。
- `send`：working Worker 的普通 send 经宿主 `session.steer` 在句缝送达，不打断（仅回合确在流式时；steer 是子会话自己的消息队列，与根 AGENTS.md 两条主会话 `sendMessage` 红线无关，且只在流式中使用，不会唤起歇透会话）。切换 role、thinking 或 cwd 要求 Worker 空闲，working 时提示先 `interrupt`，reviewing 时等落定。省略 role 时沿用，显式传入时原地切换角色；thinking 可单独覆盖。带 cwd 时释放热会话并以新目录重开同一份 JSONL（不新建会话），档案记新 cwd；Worker 的 cwd 已不存在且未带 cwd 时明确报错并提示带 cwd。steer 入队后回合若以中断等方式结束，滞留队列的补充说明在落定时清出并作为事件回报指挥官重发，不留到下次 prompt。
- `interrupt`：中止 working 回合，保留会话与义务；指挥官自己发起，所以不补发续跑提醒（只有会话重载打断的回合才提醒）。`start` 与 `send` 等回合真正在飞才返回：宿主 prompt 的前置阶段仍报空闲，落在那里的 abort 会被静默丢弃。
- `review`：只对 idle Worker 显式发起 fire-review。
- `tail`：读取最近外部输入后的预算式轨迹快照，不改变状态。
- `ack`：消除待发落标记；审查义务未履行时拒绝。
- `kill`：移除池引用；实现票完成收口或放弃整票时使用。

`subagents_list` 是零参数查询：模型结果只返回池快照，界面展示由 `list-view.ts` 投影。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回：await 之后的写回一律经 `commit` 重读最新档案再函数式更新，档案已被 kill 就释放热会话并放弃；启动回合的路径都经 `runWorker` 入口重读，准备期间被 kill 的 start 报错、不调模型、不留热会话。steer 越过 await 后回合已落定时清掉滞留队列并报“未送达”，由指挥官重发。

## 活动列表

输入框上方的活动列表（用户可见行为见 README，排序、折叠与行布局见 `activity-list.ts`、`activity.ts` 头注释）：底栏只发布纯文字“指挥官”；列表的输入由 runtime 从档案加 live 表投影一次给出，落定事实（时刻、成败与说明）只在 live 里一份，不看持久化 disposition，reload 后不展示历史；列表冻结的耗时与 `subagents_list` 的“落定 X 前”共用这一份。`ctrl+o` 不展开活动列表：它常驻输入框上方，再展开只会挤掉正文视口。

## 在飞数发布

Master 是在飞子代理数的唯一发布者，定义见 `outbox.ts` 头注释。store 与事件队列每次变化及激活/停用时在进程内事件总线发布 `{ inFlight }`，只在数量变化时发；同一同步段内的落定与入队合并成一次计算。停用时先发带 `teardown` 的归零——遗弃在飞子代理不是歇下，`busy.ts` 只结束本段、不发歇下边沿。同时按 0↔正数跃迁发布通用 `herdr:working`（频道定义见 `busy.ts`）；herdr 的 pi 集成文件由 herdr 仓库维护，FireCode 只负责发布。

归零只发生在事件交给指挥官之后：闲时前门唤醒的 deliver 以宿主记录这条信封消息本身为送达，没进回合就在下一个回合改走 steer 补投（机制见 `deliver.ts`）。两种情况扣减时指挥官回合都已在跑，上边框、摘要与 Bark 不会在唤醒前出现“歇下”缝隙，事件也不会被 ack 后静默丢失。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经根级 `deliver.ts` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息；指挥官空闲时，陆续到达的一批结果按安静窗口合并成一次唤醒：最后一条入队后 1.5 秒没有新结果才唤醒，从第一条起最多等 6 秒；指挥官在跑时照旧立即句缝送达。落定类事件入队时在正文末尾追加一行 Worker 本次运行耗时：子代理会话里这次运行（最近一次 start/send/review 投递之后）写下的轮记录时长之和（fallback 续跑、审查期间的修复回合各自成段，合起来才是这次运行），与子代理视图读的是同一份记录；子代理排除了 FireCode（没有轮记录器）或 reload 后起点丢失则省略，不拿指挥官这边的计时冒充；reload 重放的 pending 事件已带落定时的耗时，不再追加；待续跑、已切换模型、补充说明未送达不带。所有事件在会话进行中时再追加“当前任务 X”：自 `busy.ts` 本段起点（与上边框计时同一事实）到入队时刻，是给指挥官的时间信号——Opus 5.5 据已用时间安排并行（官方提示指南“Time signals for multiagent harnesses”）；视图直接派、主会话不在进行中的运行省略。运行时只记起点（活动列表的实时耗时与挑出这次运行的记录），只追加在事件正文内，不触碰投递路径。

**视图起的运行**：运行时表里每次运行带一个来源（`RunOrigin`），不另起状态机。用户在全过程视图里给空闲子代理补话起的运行来源为 view：指挥官没在等它，所以不计入在飞数——主会话不因它进入进行中、不产生主会话轮记录、不推 Bark；落定事件仍交给指挥官（它必须知道子代理状态变了），但经 `deliver.ts` 的 `inform` 只告知不唤醒（pending 里带 `inform`，reload 重投同样不唤醒；与唤醒事件同批时随那一批唤醒送达）。指挥官在这次运行进行中又 send 给同一子代理时来源转为 master，它从此在等；视图补进指挥官起的运行只记原话、不改来源。发落、审查义务与失败行规则不变。

事件正文只在 `event-format.ts` 产文（标题、分节、失败口径、耗时行格式）；展示卡没有独立数据，`tools/machine.ts` 从信封正文解析标题、`错误：` 分节与“耗时：本次运行”行，改格式两侧同步，`tests/tool-groups.test.ts` 用真实产文守这条链路。给模型的指令（续派或收口、审查义务）只放在标题之后的正文；被中断的正文只在有审查义务时提审查义务；待续跑只发给会话重载打断的回合，并说明是重载打断。

`review:true` 是持久化到票上的审查义务，不自动开审；它在 `send`、reload、中断和失败后保留并阻止 `ack`，由审查通过或质量裁决停止消除。`kill` 随整票删除义务。不在落定时自动开审：模型停下可能是在提问或交半成品，落定不等于完成；义务不灭归代码，送审时机归指挥官。

Master 调度行为与 Worker 行为的唯一事实源分别是 `prompts/master.zh.md` 与 `prompts/worker.zh.md`；修改委派纪律或 Worker 约束时改对应提示词，不在本文复述。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具；指挥官会话启用了 codemode 时再加 codemode（宿主只给 CLI 主会话注入内置扩展，`spawn.ts` 为子会话自带 builtin codemode，on/only 由同一份 settings 决定；脚本里的嵌套调用照样经过 tool_call 钩子，守卫不失效）。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫放行当前 checkout 与系统临时目录（交付物写在临时目录是正当用途）；bash 仍是可信能力（开放它是为了让 Worker 自跑测试；守卫只防误伤，物理隔离要容器或只读挂载，不在本插件范围），最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`：审查进度与终态都由它从 Worker 会话里刚追加的记录增量解析，回合结束时才读一次文件兜底，Master 不解析 checkpoint 内部字段；bark 只读取持久化档案，工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。

## 全过程视图

行为见 README，结构见 `worker-view.ts` 头注释。视图只经 `WorkerViewSource` 读运行时：活动列表的同一份事实（`activityFacts`，启动序名单 `launchOrder` 是档案里持久化的启动序，n/N 不随状态分组跳）、档案、热会话、会话接上通知（`onWorkerSession`，冷子代理被唤醒时在第一条事件之前通知视图接上订阅）、移除通知（`onWorkerRemoved`：kill 或启动失败撤票时按名字通知；之后对它的 send 报“子代理不存在：<名字>”）、视图来源的 send，以及按子代理存草稿的内存表（不持久化）。

- 输入区与上下横线共用 `statusbar/render.ts` 的 `fitBorder`；上横线的状态与耗时调活动列表的 `rowState`，同一分组、同一字形、同一“本次运行”耗时，不在视图另算；轮界与每轮耗时、终态、均速逐条经 `roundFromEntry` 读 Worker 会话自己的轮记录。
- 补话就是 `ACTION_HANDLERS.send({ worker, prompt, origin: "view" })`；已发出未送达的补话读子会话的排队队列。
- 被移除时正在看的子代理留着已有记录、不再更新，输入框停用并丢掉草稿；Tab 序列与 n/N 立即去掉它。
- 浮层抢走焦点后宿主编辑器的全局键不生效，视图给出同义行为：esc 返回，ctrl+c 先清输入、再按关闭视图，空输入的 ctrl+d 关闭视图（不在浮层里退出 pi），ctrl+o 是当前子代理的全部展开。
- 视图只处理滚轮与点击；按下、拖动与松开交还宿主做文字选择（有浮层时宿主按屏幕坐标选、松开即复制），不拖动的松开由宿主转成点击发回。点击展开/收起的视口锚定与主会话同一个 `tools/click-anchor.ts`。
