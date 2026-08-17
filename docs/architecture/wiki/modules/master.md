---
sources:
  - agent/extensions/firecode/master/herdr.ts 1e145c952309 HerdrWorkers monitorSettlement handleSettlement handleReviewSettlement watchInterrupted autoReview splitPlan createShellReadyMarker validateDelegationText displayName agentName
  - agent/extensions/firecode/master/index.ts a292b31177f3 registerMaster MASTER_TOOL PENDING_EVENT_TYPE EVENT_ACK_TYPE flushMasterEvents sweepDispositions unackedEvents workerInstructions reviewGateError listMeta STATUS_WORD
  - agent/extensions/firecode/master/state.ts e51063b2f460 MasterStore MasterState WorkerRef WorkerStatus WorkerDisposition reduceMaster restoreMasterState masterStatePath loadMasterState liveWorkers
  - agent/extensions/firecode/master/event-format.ts 8654a2c83e72 MASTER_EVENT_TYPE BODY_SECTIONS sectionLine masterEventDetails isValidMasterEventDetails
  - agent/extensions/firecode/master/event-card.ts 6310bba8b667 registerMasterEventRenderer CompactTitle compactCard
  - agent/extensions/firecode/review/outcome.ts 390ab5ea36a2 REVIEW_OCCUPANCY_LABEL readReviewOutcome ReviewOutcome
---

# Master 多 Agent 主控

## 职责

Master 让一个 Pi 会话成为指挥官，把工作委派给运行在 Herdr pane 里的独立 Pi 进程（Worker），
并把它们的落定结果异步回传。默认休眠：`registerMaster`（`master/index.ts`）注册命令与工具定义，
但只有 `/fire-master` 激活后才把 `subagents` 追加进活动工具集；未激活的普通 Pi 完全不带这个工具。
没有 Goal、Task 或任务板。激活前置条件写死在 `activateMaster`：必须运行在 Herdr 管理的 pane
（`HERDR_ENV=1` 且有 `HERDR_WORKSPACE_ID`），且 `master` 节配置无问题（`loadMasterModels` 把配置
问题变成拒绝启动的硬错误——选型表错会拿错模型真实发起 Worker）。

子代理进程自身也加载本插件，靠环境变量 `FIRECODE_MASTER_WORKER` 识别成 Worker 角色：拿不到
`subagents`，改为在系统提示里追加 `workerInstructions` 的禁令段，并由 `tool_call` 钩子把 edit/write
限制在当前 checkout 内。隔离是纪律不是能力边界
（[ADR-0004](../../../adr/0004-worker-default-tools-and-trust-model.md)）：Worker 用默认四工具含 bash，
路径限制防误伤，真要物理隔离得上容器或只读挂载。

## 对外接口

`subagents` 是唯一接口，action 集合 start / send / interrupt / review / ack / list / sleep / kill
（`master/index.ts` 的工具 schema，动作命名来历见
[ADR-0007](../../../adr/0007-rename-disposition-actions-for-model-priors.md)）。语义边界：send 只对
`idle` / `blocked` 放行，`working` 的出路是先 interrupt；review 只接受 `idle`；sleep 留下可唤醒的
Dormant 引用，kill 除名不可回；ack 只消发落标记。工具行渲染复用 [tools](tools.md) 的 `ToolLine` 与
`makeResultRenderer` 纯组件；list 的结果渲染另回写 `context.state.meta` 行内后缀（与 edit ±diff 同一
通道）：空池显「空」，否则列出各子代理名与中文状态词——`STATUS_WORD` 表以 `satisfies Record<WorkerStatus, string>`
绑定，状态枚举增删不同步会编译失败。

跨模块只读接缝有两条。其一：[session](session.md) 的 bark 通知用 `state.ts` 的 `loadMasterState` /
`masterStatePath` 只读 Worker Pool 持久化状态，判断有没有 `blocked` 待拍板子代理（`WorkerStatus`
注释明言这一耦合）。其二：对 [review](review.md) 只依赖 `review/outcome.ts` 的 `readReviewOutcome`
与 `REVIEW_OCCUPANCY_LABEL`，不交换运行身份。

事件类型常量：`MASTER_EVENT_TYPE`（`event-format.ts`，结果消息的 customType）、`PENDING_EVENT_TYPE`
与 `EVENT_ACK_TYPE`（`master/index.ts`，收件箱持久化条目）。事件正文分节标记集中在 `BODY_SECTIONS`：
`sectionLine` 是产文侧唯一入口，`masterEventDetails` 反向按同一标记提取每事件一行的紧凑预览，
产文与提取两侧编译期同步。`event-card.ts` 据此渲染事件卡：默认紧凑、ctrl+o 展开全文，details 校验
失败或旧消息降级为完整文本，渲染器永不抛异常；紧凑行截断用自带的 `CompactTitle`（基于 `format.ts`
的 clip）而非 pi-tui `TruncatedText`——后者省略号带 `\x1b[0m` 全量重置，会在截断点掐断外层 Box 的
背景色（上游拒修）。

## 数据怎么流

**start 到 Worker 拉起**（`master/herdr.ts` 的 `HerdrWorkers`）分两段：串行临界区 `allocateWorker`
解析名字/模型/thinking/cwd、算布局容量、建 shell 并写 `starting` 占位（shell 创建必须留在串行区，
后一个的象限切分依赖前一个 pane 落位）；队外的 `launchWorker` 并行做 shell 握手与 `agent start`，
首批工单因此真并行。`cwd` 必须是已存在的绝对路径（`resolveWorkerCwd`），校验失败即拒绝。布局由
`splitPlan` 实现 2×2 象限切，每 tab 最多 4 个，满或 split 失败才建新 tab；清理时共享 tab 只收自己的
pane 不连坐。命名：`displayName` 给 pane/tab/Pi 显示名（`任务名-模型名`），`agentName` 是其满足
Herdr 字符集硬约束 `[a-z][a-z0-9_-]{0,31}` 的净化版。shell 握手用临时 `ZDOTDIR` 挂 zsh precmd 打印
随机标记（`createShellReadyMarker`，仅支持 zsh）；`agent start` 对 `agent_pane_busy` 退避重试 15 秒，
窗口用尽附 pane 前台快照作证据。

**落定分流回传**：`monitorSettlement` 是唯一监听循环，work/review 两模式共用，失败指数退避重挂。
`handleSettlement` 分流：`blocked` 且状态标签含 `REVIEW_OCCUPANCY_LABEL` ＝外部审查占用，转
`reviewing` 继续等终态，否则才是 Worker 提问；最终 assistant 是中断（`stopReason === "aborted"` 或
error 带 abort 字样）＝不算失败也不消耗审查意图，记 `interruptedAt` 并由 `watchInterrupted` 续监，
用户接手则结果照常回流，五分钟无动静发自动续跑提醒把流程交还指挥官
（[ADR-0006](../../../adr/0006-liveness-owned-by-code.md)）；只有 `stopReason === "stop"` 且无
errorMessage 才按成功回传，length / toolUse / error / 缺失回复一律按失败回传。

**审查意图流转**：`reviewNeeded` 在 start/send 声明（跟任务走不跟渠道走）、随档案持久化，成功落定后 `autoReview` 自动发起，
只在 `review()` 确认启动（`--wait --until working --until blocked` 观察到状态变化，或停滞时
fire-review runId 推进）时消耗；投递失败保留意图，reload 与休眠恢复凭档案续上补审。
`handleReviewSettlement` 用 `readReviewOutcome` 读 Worker session 的 checkpoint 得终态：runId 未推进
判「审查未启动」，仍 `in_progress` 则退避重挂（占用信号失效时轮间会观测到 idle），终态连同最终回复回传。

**收件箱 pending/ack**（`master/index.ts`）：结果以 custom follow-up message 投递（`flushMasterEvents`），
至少一次语义——入队即以 `PENDING_EVENT_TYPE` 落 Master 会话，投成写 `EVENT_ACK_TYPE`，恢复时
`unackedEvents` 取 pending−ack 差集重投，重复无害；投递失败整批退回队列 5 秒重排。落定类事件送达即置
`disposition: "pending"`，回合结束 `sweepDispositions` 提醒一次（置 `reminded`），仍不发落升级为用户
通知收口；标记持久化跨 reload 续期。事件只装增量，不携带模型/session 等静态身份。

**状态文件读写**（`master/state.ts`）：纯 reducer `reduceMaster` + `MasterStore` 薄封装，每次 dispatch
立即落盘。schema 只认 `version: 5`，`restoreMasterState` 逐字段校验并要求名字与 sessionPath 唯一、
dormant 必有 sessionPath、live 必有 pane/tab，不兼容旧版。落盘走 `writeState`：临时文件按 pid+uuid
命名、mode `0600` 写入后 `renameSync` 原子覆盖，目录 mode `0700`；路径由 `masterStatePath` 按会话 id
派生到 `~/.pi/agent/tmp/`，不向 Pi session 追加快照；`CLEAR` 直接删文件。

## 改动指南

先看的文件按改动类型分：动工具参数/门禁/事件投递看 `master/index.ts`；动 Worker 生命周期、布局、
监听与结算看 `master/herdr.ts`；动持久化 schema 看 `master/state.ts`（改 `WorkerStatus` 要同步 bark 的
`hasBlockedWorker` 与 index.ts 的 `STATUS_WORD`，后者有 satisfies 编译期把守）；动事件文案分节先改
`event-format.ts` 的 `BODY_SECTIONS`（产文与紧凑提取共用，单侧改词会静默丢预览）。测试在
`tests/master-state.test.ts`、`tests/master-herdr-recovery.test.ts`、`tests/master-integration.test.ts`。

常见坑：

- **回合边界不能拿 isIdle**：宿主在 emit `agent_settled` 前就置 idle，那个窗口里 flush 会把同一批结果
  拆投成多回合；投递门槛必须是显式的 `turnActive` 位（`agent_start` 置位、`agent_settled` 清位）。
- **ack 对无标记子代理报错是护栏**：对没有待发落标记的非 idle 子代理 ack，唯一合理解释是把它误当
  暂停，返回假成功会让指挥官以为子代理已停（真实事故，ADR-0007）；报错文案按状态给出路，不要弱化。
- **reconcile 零副作用退场**：reload 时旧运行时 `shutdown()` 只中止在飞任务并等它们退出，不关 shell、
  不写状态——现场必须完整交给新运行时的 `resume()` → `reconcile()` 按档案重新认领并重挂监听
  （reviewing/working/中断态/待审票各有恢复路径）；`abandonStart` 在池关闭时同样零副作用。
- **技能前缀白名单在代码不在提示词**：`validateDelegationText` 只放行 `/skill:tdd `，其余 `/skill:`
  `/skills:`（含拼写错误）一律拒绝——提示词禁令实战失效 26 次后改为机制，别退回提示词约束。
  同类的投递前门禁还有 `reviewGateError`：review 关闭或配置有误时拒绝 review action 与审查票 start/send，
  避免 `/fire-review` 命令退化成普通模型输入。

整体位置见[总览](../system.md)。
