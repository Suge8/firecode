# master：进程内多 Agent 主控

新会话按 `master.autoActivate` 注入七命令工具 `subagents` 与池快照查询 `subagents_list`；默认开启。裸 `/fire-master` 翻转当前会话（关闭时若有子代理在跑，有界面先 `ctx.ui.confirm` 确认；无界面照旧直接关），`/fire-master status` 查看状态；下一次会话仍按配置决定，命令不写回。配置或角色表有误时拒绝激活，不用默认模型代替。

## 运行时

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 注册入口：激活与停用、命令、两个工具与生命周期；运行时旋钮（续跑提醒时限、合并唤醒窗口）的默认值 |
| `runtime.ts` | 一个指挥官会话的运行时：档案 store、按名字索引的 Worker 运行时事实表（live）、活动列表投影、全过程视图的草稿与开关；`current`/`commit` 是 await 后唯一的重读与写回点，`schedulePublish` 是在飞数与名册的唯一发布点 |
| `outbox.ts` | 事件发件箱：pending/ack 持久化、合并投递、退避重试、耗时行与在飞数计算 |
| `run.ts` | 回合编排：打开会话、跑回合、按终态落定（成功/失败/中断/fallback 续跑）、审查监视、中断续跑提醒 |
| `actions.ts` | 七个命令动作的处理函数，表驱动分发 |
| `list-view.ts` | 工具行、池快照展开与 status 文本，纯投影 |
| `roster.ts` | 子代理名册：活动列表的投影，发布给同进程的其他扩展 |
| `guard.ts` | Worker 会话里唯一注册的 edit/write 守卫：只放行当前 checkout 与系统临时目录 |
| `state.ts` `event-format.ts` `activity-list.ts` | 档案格式（含模型原子文字）、事件产文、活动列表 |
| `trace.ts` | `tail` 的轨迹快照：热会话读内存消息、冷会话读会话文件 |
| `event-card.ts` | 事件卡渲染：默认每事件一行标题，展开看完整信封正文 |
| `prompt.ts` | 提示词读取与拼装 |
| `activity.ts` | 活动列表的单行布局，只有 `activity-list.ts` 使用 |
| `messages.ts` | 本目录全部界面与模型可见文案（中英）；信封词汇见根 AGENTS「文案」 |
| `worker-view.ts` | 子代理全过程视图：点活动列表一行打开全屏浮层，用过程组投影看完整记录并可补话 |

Worker 是主进程内的 SDK 子会话而非独立进程：reload 会中断在飞回合（JSONL 与审查义务保留、可续派），换来父进程退出即全停、无幽灵进程与跨进程对账。池只管 Worker 生命周期与结果回传，不建 Goal、Task、任务板或消息总线；多个 Worker 可并行写同一 checkout，没有写租约，集成与验证归指挥官。

所有子会话只经根级 `spawn.ts` 创建（Master、Review、Watcher 各持一个池，生命周期互不牵连）：它封装 Pi SDK 会话、模型、工具（含只属于该子会话的自定义工具）、扩展、
系统提示、上下文文件与持久化。Worker 与观察员的池由入口建，注册进子会话的是主会话已加载的这份 FireCode（子会话模式：只有守卫、轮记录等与界面无关的部分）；宿主为子会话从磁盘另读的 FireCode 在加载标记下不注册。否则 FireCode 在会话中途更新后，新开的 Worker 会跑新代码而指挥官仍是旧代码，审查 checkpoint 等落盘约定对不上；改完 FireCode 要 reload 指挥官，Worker 才用上新代码。审查会话隔离，不带任何扩展。模型原子也只在池里解析：每个池只建一份 ModelRuntime（auth.json 与 models.json 只读一次），扩展注册的 provider 在模型解析时不可见。这份 ModelRuntime 同时交给池里建出的每个子会话，所以某个子会话里扩展注册的 provider 对同池其他子会话也可见（宿主跨会话复用服务也是如此）。单写者登记挂在 globalThis 上，宿主重新求值模块图时仍是进程唯一。Worker 使用 file 会话，文件位于主会话目录下的 `subagents/`，不会出现在 `/resume`；会话路径是档案身份的唯一事实源。同一路径只允许一个热会话持有者。子会话按目标 cwd 起项目信任（`spawn.ts` 的 `projectTrusted`，与宿主非交互路径同一判定：无需信任的项目资源就信任，否则取宿主信任存储里最近的显式决定，没有决定时看全局 `defaultProjectTrust` 是否为 always；子会话无法弹窗，ask 与只对主会话本次生效的选择都按不信任），资源加载器与会话共用同一个 SettingsManager。

Worker 档案是 v10：`working / idle / reviewing` 三态，以 `role` 记录派发角色、`model` 与 `thinking` 记录实际原子，`launch` 记录启动序；另有 `interruptedAt` 与 `reviewNeeded` 两个独立标记。旧版档案由 `MasterStore` 丢弃并告知，不迁移；比当前更新的版本（降级）明确失败，不删档案。`MasterStore` 是档案唯一所有者：列表始终按启动序（`launch`）排列，读者不再二次排序；载入时把在飞状态收敛为 `idle + interruptedAt`（保留会话与审查义务）并把这些名字记在运行时的 `recovered`，激活时只对它们补挂续跑提醒——指挥官自己 interrupt 的、早已提醒过的不再提醒，`ack` 取消还没发出的提醒。池变空（删最后一票、载入空池）就删档案文件。首次续派会前置现场核对提示。

热冷只属于运行时缓存：池不订阅会话事件自判空闲，只有 Master 在回合落定、中断落定、审查落定时 `markIdle` 才起释放计时，因此 reviewing 中的 Worker（审查期间它自己是闲的，修复回合结束也会落定）不会被释放；释放热会话后池通知持有方，Master 随即退订，不再持有已关闭的会话；到期释放先经该会话的 extensionRunner 发 `session_shutdown`（reason quit）让会话内扩展收口，再 dispose——与宿主替换会话的顺序一致，否则会话里跑着的 fire-review 会成为握着死 ctx 的孤儿。档案与 JSONL 保留；后续 `send` 打开原会话继续。池的 `getSession` 是纯查询（视图、steer、interrupt 只看不占）；要在会话上开回合的 `send`/`review` 经 `hold` 取消释放计时，准备段失败而票仍是 idle 时补回 `markIdle`，否则这个热会话不再释放。档案存在但会话文件不存在时（子代理在第一条回复落盘之前就被中断或释放，宿主此前没写文件）没有上下文可恢复，`send`/`review` 在同一路径上新开会话继续，`tail` 与全过程视图读到空记录。`kill` 在同步段内删档案与该名下的整条运行时事实（计时器、订阅、当前工具、落定结局一次清掉），再等待 session_shutdown 收口后释放热会话，永不删除 JSONL；start 失败同样只撤自己这一票的事实。异步回写只属于未关闭的当前 runtime；会话关闭先清空当前 runtime 并置 closed，再释放池、订阅与定时器，迟到任务不写状态、投递、UI 或持久化（`MasterRuntime.find` 在 closed 后返回 undefined，落定回调据此直接放弃）。

档案存在 Pi Agent 目录（`getAgentDir()`，含 `PI_CODING_AGENT_DIR` 覆写）的 `tmp/firecode-master-<主会话 id>.json`，事件的 pending/ack 存在主会话 JSONL：fork 出的会话带着 pending 却没有档案，重投时可能提到不在池里的 Worker——这是已知边缘，接受。

## 工具契约

`subagents` 只有七个命令动作，结构上都要求 Worker：

- `start`：显式指定角色表内的 role 和短名；可用 thinking 覆盖角色原子档，可带 cwd、review。
- `send`：working Worker 的普通 send 经宿主 `session.steer` 在句缝送达，不打断（仅回合确在流式时；steer 是子会话自己的消息队列，与根 AGENTS.md「硬约束」里主会话的唤醒问题无关，且只在流式中使用，不会唤起歇透会话）。切换 role、thinking 或 cwd 要求 Worker 空闲，working 时提示先 `interrupt`，reviewing 时等落定。省略 role 时沿用，显式传入时原地切换角色；thinking 可单独覆盖。带 cwd 时释放热会话并以新目录重开同一份 JSONL（不新建会话），档案记新 cwd；Worker 的 cwd 已不存在且未带 cwd 时明确报错并提示带 cwd。steer 入队后回合若以中断等方式结束，滞留队列的补充说明在落定时清出并作为事件回报指挥官重发，不留到下次 prompt。
- `interrupt`：中止 working 回合，保留会话与义务；指挥官自己发起，所以不补发续跑提醒（只有会话重载打断的回合才提醒）。`start` 与 `send` 等回合真正在飞才返回：宿主 prompt 的前置阶段仍报空闲，落在那里的 abort 会被静默丢弃。
- `review`：只对 idle Worker 显式发起 fire-review。
- `tail`：最后一条外部输入（不是整条由 Master 信封构成的用户消息）之后的轨迹快照，不改变状态：错误（`stopReason`/`errorMessage`）在前，其后按时间列用户输入、助手正文、工具调用（只留名字与截短的参数）和工具结果开头，总宽度超预算丢最早的行，按字素截断。热会话读内存消息，冷会话读会话文件。
- `ack`：清掉失败与被中断的活动列表行并取消未发出的续跑提醒；审查义务未履行时拒绝。
- `kill`：移除池引用；实现票完成收口或放弃整票时使用。

调用方身份（指挥官的工具 / 全过程视图）是处理函数的独立参数 `origin`，不在模型能填的 `params` 里，所以模型无法冒充视图来源。

`subagents_list` 是零参数查询：模型结果只返回池快照，界面展示由 `list-view.ts` 投影。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回：await 之后的写回一律经 `commit` 重读最新档案再函数式更新，档案已被 kill 就释放热会话并放弃；启动回合的路径都经 `runWorker` 入口重读，准备期间被 kill 的 start 报错、不调模型、不留热会话；send 在开会话前先核对当前档案，review 先写档案再挂订阅，被 kill 的票不留热会话与订阅。steer 越过 await 后回合已落定时清掉滞留队列并报“未送达”，由指挥官重发。

## 活动列表

指挥官模式下，输入框上方逐行列出子代理：需要处理的置顶——红 `✗` 失败（含审查停止、审查未完成）与黄 `‖ 被中断`
留到指挥官 ack 或 kill，黄 `◌` 加动作后的 `· N 分钟无输出` 表示在跑的子代理 5 分钟没有任何输出、有输出立即恢复；然后是在跑与审查中的行，
再是 `✓ N 个已完成`（kill 后才去掉）与 `N 个空闲`（resume 后池里还在的、已 ack 的）。在跑的行最多显示 `max(4, 终端高度/6)` 行，超出折成 `+N 个在跑`；
三种折叠行的计数带一层浅灰底色表示可点，后面灰色列出被折叠的名字（放不下就少列）。点 `+N 个在跑` 展开全部、点“收起”折回，点 `✓ N 个已完成` 列出名字、结果首句与本次运行耗时，点 `N 个空闲` 列出空闲的子代理，再点收起；展开在你下一次发消息时自动收起。
窄屏整表一起省掉角色，动作文字按剩余宽度截短。

排序、折叠与行布局见 `activity-list.ts`、`activity.ts` 头注释。底栏只发布纯文字“指挥官”；列表的输入由 runtime 从档案加 live 表投影一次给出，落定事实（时刻、成败与说明）只在 live 里一份，reload 后不展示历史；列表冻结的耗时与 `subagents_list` 的“落定 X 前”共用这一份。`ctrl+o` 不展开活动列表的原因：它常驻输入框上方，再展开只会挤掉正文视口。

## 名册发布

同进程的其他扩展订阅 `pi.events` 的 `firecode:subagents` 频道读子代理名册；字段、状态取值与发布时机见 `roster.ts` 头注释。读者只读这份投影，不读档案、会话文件或 `subagents/` 目录。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经根级 `deliver.ts` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息，合并窗口见 `index.ts`（安静窗口）与 `outbox.ts`（最长等待）。事件正文末尾的“本次运行”耗时见 `outbox.ts`、`event-format.ts`；“当前任务 X”是给指挥官的时间信号（据已用时间安排并行），只追加在事件正文内，不触碰投递路径。

投递失败时事件回到队首，按 `eventRetryMs`（默认 5 秒）起逐次翻倍、封顶 60 秒的退避重试，一串连续失败只提示一次，直到送达；重试期间对应子代理仍算在飞。子代理会话里的扩展出错（事件处理器抛错）经 `spawn.ts` 的 `onExtensionError` 接线，作为“扩展出错”事件告知指挥官，同一处错误每个子代理只报一次。

**视图起的运行**：运行时表里每次运行带一个来源（`RunOrigin`），不另起状态机。用户在全过程视图里给空闲子代理补话起的运行来源为 view：指挥官没在等它，所以不计入在飞数——主会话不因它进入进行中、不产生主会话轮记录；落定事件仍交给指挥官（它必须知道子代理状态变了），但经 `deliver.ts` 的 `inform` 只告知不唤醒（pending 里带 `inform`，reload 重投同样不唤醒；与唤醒事件同批时随那一批唤醒送达）。指挥官在这次运行进行中又 send 给同一子代理时来源转为 master，它从此在等；视图补进指挥官起的运行只记原话、不改来源。审查义务与失败行规则不变。

事件正文只在 `event-format.ts` 产文（标题、分节、失败口径、耗时行格式）；展示卡没有独立数据，`tools/machine.ts` 从信封正文解析标题、错误分节与“耗时：本次运行”行（中文界面的字样；英文界面是 `Error:`、`Elapsed: This run`）。标题里“名字是第一个空格前的词”这条两种语言都成立，改格式两侧同步，`tests/machine.test.ts` 与 `tests/i18n-master.test.ts` 用真实产文守这条链路。给模型的指令（续派或收口、审查义务）只放在标题之后的正文；被中断的正文只在有审查义务时提审查义务；待续跑只发给会话重载打断的回合，并说明是重载打断。

`review:true` 是持久化到票上的审查义务，不自动开审；它在 `send`、reload、中断和失败后保留并阻止 `ack`，由审查通过或质量裁决停止消除。`kill` 随整票删除义务。不在落定时自动开审：模型停下可能是在提问或交半成品，落定不等于完成；义务不灭归代码，送审时机归指挥官。

Master 调度行为与 Worker 行为的唯一事实源分别是 `prompts/master.<语言>.md` 与 `prompts/worker.<语言>.md`（zh/en 等价，改一边必须同步另一边）；修改委派纪律或 Worker 约束时改对应提示词，不在本文复述。提示词里引用事件产文的字样（子代理视图来源标记）必须与 `messages.ts` 里的一致，`tests/i18n-master.test.ts` 守这条。提示词不点具体角色名：角色名完全由配置决定，提示词按角色表里的适用场景指代（如“适用场景写着 CI、部署、长测试等待的角色”）。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具；指挥官会话启用了 codemode 时再加 codemode（宿主只给 CLI 主会话注入内置扩展，`spawn.ts` 为子会话自带 builtin codemode，on/only 由同一份 settings 决定；脚本里的嵌套调用照样经过 tool_call 钩子，守卫不失效）。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫放行当前 checkout 与系统临时目录（交付物写在临时目录是正当用途）；bash 仍是可信能力（开放它是为了让 Worker 自跑测试；守卫只防误伤，物理隔离要容器或只读挂载，不在本插件范围），最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`：审查进度与终态都由它从 Worker 会话里刚追加的记录增量解析，回合结束时才读一次文件兜底，Master 不解析 checkpoint 内部字段；工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。

## 全过程视图

点活动列表里任一子代理行打开它的全过程视图：正文是与主会话同样的折叠记录，底部输入框与主会话同形，直接补话给它
（运行中排队到句缝，空闲时唤醒它）。输入框上横线左边是状态与耗时（与活动列表同一说法），右边是名字与角色；
下横线左边是第几个（n/N），右边是模型与按键提示，窄屏先省角色、模型和次要提示。Tab / Shift+Tab 按启动顺序换子代理，
PageUp/PageDown 与滚轮翻看，拖动选中文字即复制，esc 返回；切换时各子代理的展开状态保留，没发出的草稿关掉视图后仍在。
子代理被移除时上横线写“已移除”，不能再补话。

结构见 `worker-view.ts` 头注释。视图只经 `WorkerViewSource` 读运行时：活动列表的同一份事实（`activityFacts`，子代理顺序就是档案的启动序，n/N 不随状态分组跳）、档案、热会话、会话接上通知（`onWorkerSession`，冷子代理被唤醒时在第一条事件之前通知视图接上订阅）、移除通知（`onWorkerRemoved`：kill 或启动失败撤票时按名字通知；之后对它的 send 报“子代理不存在：<名字>”）、视图来源的 send，以及按子代理存草稿的内存表（不持久化）。

- 输入区与上下横线共用 `statusbar/render.ts` 的 `fitBorder`；上横线的状态与耗时调活动列表的 `rowState`，同一分组、同一字形、同一“本次运行”耗时，不在视图另算；轮界与每轮耗时、终态、均速逐条经 `roundFromEntry` 读 Worker 会话自己的轮记录。
- 补话就是 `ACTION_HANDLERS.send(active, { worker, prompt }, ctx, "view")`；已发出未送达的补话读子会话的排队队列。
- 中断键 `ctrl+shift+x`（`INTERRUPT_KEY`，避开宿主全部默认键位）走 `ACTION_HANDLERS.interrupt`，只对在跑的子代理生效，底行提示只在它在跑时出现；展开工具行经 `tools/group-view` 带形状校验的 `toggleToolDetails`，不直接读宿主私有字段。
- 被移除时正在看的子代理留着已有记录、不再更新，输入框停用并丢掉草稿；Tab 序列与 n/N 立即去掉它。
- 浮层抢走焦点后宿主编辑器的全局键不生效，视图给出同义行为：esc 返回，ctrl+c 先清输入、再按关闭视图，空输入的 ctrl+d 关闭视图（不在浮层里退出 pi），ctrl+o 是当前子代理的全部展开。
- 视图只处理滚轮与点击；按下、拖动与松开交还宿主做文字选择（有浮层时宿主按屏幕坐标选、松开即复制），不拖动的松开由宿主转成点击发回。点击展开/收起的视口锚定与主会话同一个 `tools/click-anchor.ts`。
