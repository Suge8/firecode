---
sources:
  - agent/extensions/firecode/master/herdr.ts 1e145c952309 HerdrWorkers start allocateWorker launchWorker abandonStart send interrupt review stop resume shutdown reconcile monitorSettlement handleSettlement handleReviewSettlement watchInterrupted armAutoResume autoReview splitPlan createShellReadyMarker workerShellEnv validateDelegationText DELEGATION_SKILL_WHITELIST resolveWorkerCwd displayName agentName startAgentProcess withPaneEvidence
  - agent/extensions/firecode/master/index.ts a292b31177f3 registerMaster MASTER_TOOL PENDING_EVENT_TYPE EVENT_ACK_TYPE flushMasterEvents sweepDispositions enqueueMasterEvent unackedEvents activateMaster deactivate workerInstructions loadMasterModels reviewGateError masterGuidelines listMeta STATUS_WORD subagentsCallParts
  - agent/extensions/firecode/master/state.ts e51063b2f460 MasterState WorkerRef WorkerStatus WorkerDisposition MasterStore reduceMaster restoreMasterState loadMasterState masterStatePath liveWorkers requireWorker isStatus
  - agent/extensions/firecode/master/event-format.ts 8654a2c83e72 MASTER_EVENT_TYPE BODY_SECTIONS sectionLine masterEventDetails isValidMasterEventDetails
  - agent/extensions/firecode/master/event-card.ts 6310bba8b667 registerMasterEventRenderer CompactTitle compactCard
  - agent/extensions/firecode/review/outcome.ts 390ab5ea36a2 REVIEW_OCCUPANCY_LABEL readReviewOutcome ReviewOutcome
---

# Master 多 Agent 主控

## 职责

Master 把一个 Pi 会话变成指挥官：它自己不写代码，而是把工作委派给运行在 Herdr 窗格里的独立 Pi
进程（子代理），再把子代理的落定结果异步送回指挥官的对话。没有 Goal、没有任务板，也没有常驻调度器——
何时委派、派给谁、派几个，全由模型依据提示词决定，本模块只负责把决定变成真实进程，并保证结果一定回来。

默认休眠：普通 Pi 会话完全不带子代理能力，用户执行 `/fire-master` 后才追加这一件工具；激活要求会话本身
跑在 Herdr 管理的窗格里，且选型表配置无误——配置有问题直接拒绝启动，因为拿错模型会真实烧掉一个子代理。

子代理进程加载的是同一个插件，靠启动时注入的环境变量识别出「我是子代理」这一身份：拿不到指挥官工具，
改为在系统提示里追加禁令段（不碰 Herdr、不 push、不装依赖、提交只带自己的路径），并把文件写入限制在
当前 checkout 内。这层限制的定位是防误伤而非沙箱——子代理保留 bash，能自跑测试，也能绕开路径限制；
真要物理隔离得上容器或只读挂载（ADR-0004）。

## 对外接口

`subagents` 是唯一接口（`master/index.ts` 的 `MASTER_TOOL`），action 集合 start / send / interrupt /
review / ack / list / sleep / kill，命名来历见
[ADR-0007](../../../adr/0007-rename-disposition-actions-for-model-priors.md)。语义边界写在
`master/herdr.ts`：`send` 只对 `idle` / `blocked` 放行，`working` 的出路是先 `interrupt`；`review` 只接受
`idle`；`stop` 一条路径两种结局，`sleep` 留可唤醒的 dormant 引用、`kill` 除名不可回；`ack` 只消发落标记。
`start` 参数含 `worker`（简短任务词，必填）、`model` / `thinking`（省略则继承当前会话）、`cwd`
（绝对路径且必须已存在，由 `resolveWorkerCwd` 校验）、`session`（休眠名或会话文件路径）与 `review`
审查意图。

工具行渲染复用 [tools](tools.md) 的 `ToolLine` 与 `makeResultRenderer` 纯组件：`subagentsCallParts`
产出「动词 + 目标 + 关键参数」一行；`list` 的结果另把池快照回写 `context.state.meta`（与 edit ±diff 同一
行内后缀通道），空池显「空」，否则列名字与中文状态词，词表 `STATUS_WORD` 以
`satisfies Record<WorkerStatus, string>` 绑定枚举。

跨模块只读接缝两条：[session](session.md) 的 bark 用 `state.ts` 的 `loadMasterState` / `masterStatePath`
读池状态判断有无 `blocked` 待拍板子代理；对 [review](review.md) 只用 `review/outcome.ts` 的
`readReviewOutcome` 与 `REVIEW_OCCUPANCY_LABEL`，不交换运行身份。

事件通道常量：`MASTER_EVENT_TYPE`（`event-format.ts`，回传消息的 customType）、`PENDING_EVENT_TYPE`
与 `EVENT_ACK_TYPE`（`master/index.ts`，收件箱条目）。正文分节标记集中在 `BODY_SECTIONS`，`sectionLine`
是产文侧唯一入口，`masterEventDetails` 按同一标记反向抽取每事件一行预览。`event-card.ts` 的
`registerMasterEventRenderer` 无条件注册，`compactCard` 画紧凑行、ctrl+o 展开全文，details 校验失败或
旧消息降级纯文本，渲染器永不抛异常。

## 数据怎么流

**启动**分两段。串行段负责解析身份（名字、模型、思考等级、工作目录）、按现有布局算出该切哪个窗格、
建好 shell 并先写一条「启动中」占位；并行段做 shell 握手和真正拉起子代理进程。shell 创建必须留在串行段——
后一个子代理的象限切分依赖前一个窗格已经落位，并发会互相拿错容量；握手和拉起放在串行段之外，首批工单
才能真并行。布局是 2×2 象限切，每个 tab 最多住四个，住满或切分失败才新建 tab；单住时 tab 标签是子代理
显示名，来了第二个改成组名。命名四层统一为「任务名-模型名」，Herdr 侧的 agent 名是它的字符集净化版。
窗格命名纯属显示，失败只通知不影响启动。拉起子代理时若 Herdr 报窗格忙，会在十五秒窗口内退避重试，
窗口用尽才失败，并附上窗格前台进程快照当证据。

**落定回传**只有一条监听循环，工作与审查两种模式共用，监听失败按指数退避重挂，进程消失则转休眠或除名。
工作模式下的分流：子代理报阻塞时，若状态标签是审查占用（比如用户在那个会话手动发起了对抗审查），说明它
不是在提问，转成审查中继续等终态；否则才把问题回传给指挥官。回合结束时读子代理会话的最后一条回复判定
结局——只有正常停止且无错误才按成功回传，长度超限、工具中断、错误、回复缺失一律按失败回传。中断是
第三条路：既不算失败也不消耗审查意图，记下中断时刻后插件继续盯着，用户接手则结果照常回流，五分钟无人
动手就发一条自动续跑提醒把决策交还指挥官（ADR-0006）。指令中断和用户手动中断走同一条结算路径，只是
事件文案注明来源。

**审查意图**在派发或追加任务时声明，跟着任务走而不是跟渠道走，随子代理档案持久化。成功落定后自动发起
审查；意图只在确认审查真的启动时才算消耗——投递命令会要求观察到状态变化，观察不到就退而看审查运行号
是否推进，两者都没有即判「审查未启动」并保留意图，reload、重连和休眠唤醒都能凭档案续上这次补审。审查
期间拒绝发消息，避免追问撞进审查。审查终态从子代理会话的审查存档读出，连同最终回复一起回传；若读到的
仍是进行中，说明占用信号短暂失效，退避后重新等待而不是草率结算。

**结果投递**是至少一次语义的收件箱：事件先落进指挥官会话成为待投条目，投递成功再写一条确认；crash 或
reload 之后取「待投减确认」的差集重投，重复投递无害。投递本身受回合边界约束——宿主一回合只收一条
跟进消息，回合进行中到达的结果先攒着，回合结束合并成一条投出去；投递失败整批退回队列，定时自重试，只在
首次失败时通知用户。落定类事件送达即给对应子代理挂上「待发落」标记，指挥官这一回合不做处置就在下个回合
边界注入一次提醒，提醒后仍不处置则升级为用户通知收口，标记跨 reload 续期。事件只装增量，模型和会话路径
这类静态身份进场时给一次，之后按需重查。

**状态持久化**是一个纯 reducer 加薄封装，每次变更立刻整份原子覆盖写盘：先写权限受限的临时文件再重命名，
路径按指挥官会话 id 派生到临时目录，不往 Pi 会话里追加快照。schema 只认第 5 版并逐字段校验（名字与会话
路径都必须唯一、休眠者必须有会话路径、在线者必须有窗格与 tab），不认旧版也不做迁移。reload 时旧运行时
零副作用退场：只中止在飞任务并等它们结束，不关窗格也不写状态，现场完整交给新运行时按档案重新认领、
重挂监听（审查中、工作中、中断态、待补审各有恢复路径）。会话退出或显式关闭才做实体清理并清空状态文件。

## 改动指南

按改动类型选入口：工具参数、门禁与事件投递看 `master/index.ts`；子代理生命周期、布局、监听与结算看
`master/herdr.ts`；持久化 schema 看 `master/state.ts`；事件文案分节看 `master/event-format.ts`，卡片渲染看
`master/event-card.ts`。测试在 `tests/master-state.test.ts`、`tests/master-herdr-recovery.test.ts`、
`tests/master-integration.test.ts`。

常见坑：

- **工具名不能带 herdr**：叫 `subagents` 是有意的，名字里出现 herdr 会把模型引向 CLI 逃生路径，直接
  bash 起脱管子代理（实测夜跑事故根因，ADR-0005）。`masterGuidelines` 里另有硬禁令与收编流程，
  改工具名或提示词时别把这条改回去。
- **回合边界不能拿 isIdle 判**：宿主在 emit `agent_settled` 之前就置 idle，那个窗口里 `flushMasterEvents`
  会把同一批结果拆成多个回合投出去。门槛必须是显式的 `turnActive` 位（`agent_start` 置位、
  `agent_settled` 清位）。
- **发落语义别弱化**：`sweepDispositions` 的提醒只此一次，之后升级用户通知就收口，活性归代码、决策归
  模型。对没有待发落标记的非 idle 子代理调 `ack` 必须报错——把它误当暂停是真实事故（ADR-0007），
  返回假成功会让指挥官以为子代理已停。
- **中断不按失败回传**：`handleSettlement` 判到中断只写中断时刻并交给 `watchInterrupted`，不消耗审查
  意图、不发失败事件；中断时刻是「中断态」的唯一标记，`send` 门禁的豁免和 `armAutoResume` 的剩余计时
  都凭它，直到有人接手才清。改这里要同时想清楚 reload 重挂的行为。
- **技能前缀白名单在代码不在提示词**：`validateDelegationText` 只放行 `DELEGATION_SKILL_WHITELIST` 里的
  `/skill:tdd `，其余 `/skill:` `/skills:`（含拼写错误，静默失效比违规更糟）一律拒绝——提示词禁令实战
  失效 26 次后才改为机制，别退回提示词约束。同类的投递前门禁还有 `reviewGateError`：审查关闭或配置有误
  时拒绝 review action 与审查票派发，否则 `/fire-review` 会退化成子代理会话里的一句普通输入。
- **改 `WorkerStatus` 要三处同步**：`state.ts` 的 `isStatus` 校验、`index.ts` 的 `STATUS_WORD`
  （有 satisfies 编译期把守）、以及 bark 的待拍板判据（无编译期把守，状态注释里点名了这条耦合）。
- **紧凑行截断只能用 `clip`**：`CompactTitle` 刻意不用 pi-tui 的 `TruncatedText`——后者省略号带全量重置
  序列，会在截断点掐断事件卡背景色（上游拒修）。

整体位置见[总览](../system.md)。
