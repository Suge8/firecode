---
sources:
  - agent/extensions/firecode/review/state.ts e31966837f1f reduce ReviewState Phase ReviewEffect settleRound
  - agent/extensions/firecode/review/index.ts f2a6f35f299d registerReview dispatch advanceWhenIdle setOccupancy deliverFeedbackNow deliverSummaryNow
  - agent/extensions/firecode/review/checkpoint.ts 7310bfa9cf8a isValidCheckpoint beginCheckpoint writeCheckpoint CheckpointConflictError CHECKPOINT_TYPE
  - agent/extensions/firecode/review/outcome.ts 390ab5ea36a2 readReviewOutcome ReviewOutcome REVIEW_OCCUPANCY_LABEL
  - agent/extensions/firecode/review/reviewer.ts 41b8e170867f runReviewer parseReviewOutput ReviewModelConfig
  - agent/extensions/firecode/review/advisor.ts 593d2673b179 runAdvisor parseAdvisorOutput
  - agent/extensions/firecode/review/process.ts 7a85429b06c7 runPiProcess PiProcessResult
  - agent/extensions/firecode/review/prompt.ts 903045a0ca6e buildReviewPrompt buildAdvisorPrompt buildFixFeedback buildSummaryPrompt
---

# 对抗性审查

## 职责

`/fire-review` 用外部模型对当前会话已完成的工作做对抗性审查：多个审查者子进程并行审同一份证据，
不通过就把发现投回执行模型修复，连续失败到阈值请顾问模型仲裁，最后以质量裁决或事故收尾。
这是仓库最大的模块（review/ 约 5000 行），也是唯一被 [Master](master.md) 反向依赖的模块。

架构上分两层：领域状态只存在于 `review/state.ts` 的纯 reducer 中——零 IO、零本地 import，
所有迁移经 `reduce(state, event, limits, now)` 计算，返回新状态与 `ReviewEffect` 列表
（只有两种效果：`advance` 请求推进、`send_card` 请求发卡），持久化和 UI 都只是这份状态的投影；
`review/index.ts` 是唯一执行器，持有全局唯一的 `controller`，负责全部副作用：起子进程、投递反馈、
发卡、写 checkpoint、状态栏与活动条，子进程结果一律回灌成事件交给 reducer。

## 对外接口

只有两条对外接缝，都是单向只读；此外还有一个进程内的 UI 状态键：

- **唯一外读入口**：`review/outcome.ts` 的 `readReviewOutcome(sessionPath)` 只读 Worker session 文件，
  跳过写到一半的损坏尾行，取最近一条合法 checkpoint 并映射为 `ReviewOutcome`：
  `passed` / `stopped`（顾问叫停与 maxRounds 用尽，两者都是质量裁决终止，顾问建议一并带出）/
  `failed`（error、cancelled、timed_out 等审查未完成）/ `in_progress` / `none`。
  checkpoint 格式仍归 review 所有，[Master](master.md) 只消费这个函数。
- **占用信号双通道**：由 index.ts 的 `setOccupancy` 配对发布。进程内 `herdr:blocked` 频道驱动
  herdr 集成的 blocked 状态；同时经 herdr-client 直投 `pane.report_metadata` 的 `state_labels.blocked`，
  标签常量 `REVIEW_OCCUPANCY_LABEL` 定义在 outcome.ts（因为它是跨模块接缝）。标签是带 TTL 的租约，
  持有期定时续约（续约兼作投递失败重试），终态与退出时清除、失败重试一次后由 TTL 兜底。
  Master 据此把「审查占用」与「Worker 真在提问」区分开，[会话层](session.md)的工作火焰 widget
  在审查活跃期退让。占用信号失败只通知，不影响审查状态机。
- **状态栏键**：index.ts 以 `fire-review` 为键（`STATUS_KEY`）向状态栏投影一行审查实况，属 UI 展示，非跨模块契约。

## 数据怎么流

**命令进**：`/fire-review` 命令经配置校验（任何 review 节配置问题都拒绝启动，不静默回退默认模型）
后建 controller 并 `START`。模型忙时进入 `queued` 相排队不发卡，idle 边界再 `ADVANCE` 开审。
所有启动动作统一走 `advanceWhenIdle()` 这道 idle 门：只有宿主 `ctx.isIdle()` 且无待发消息时才按当前相
启动审查者、顾问、反馈或总结投递；`agent_start` 另作互锁，执行模型开跑前先 abort 并等子进程退出。
迁移经 `dispatch()` 串行化（同一时刻只有一个迁移在跑），副作用异常只被通知捕获、不允许让队列
rejected——否则连 esc 取消都会失效。

**审查循环**：`Phase` 主线 `idle → queued → reviewing → needs_fix → awaiting_fix → reviewing`，终态 `settled`。
`reviewing` 相由 `beginRound` 按配置清单起并行子进程：`review/process.ts` 的 `runPiProcess` spawn
`pi --mode json`，stdout 按行增量消费提取最终回复；`review/reviewer.ts` 组装参数
（`--exclude-tools write,edit`，保留 bash 以便跑测试取证——只读是契约不是能力边界）并由
`parseReviewOutput` 解析 PASS/FAIL 契约（事实源 `prompts/review.{zh,en}.md`，每条发现六要素齐全，
非法发现整票作废为基础设施错误）。证据由 `review/evidence.ts` 从会话分支裁剪：首条用户消息固定保留，
工具调用轨迹作为范围归因证据。每票以 `REVIEWER_SETTLED` 回灌，全部落定后 `settleRound` 聚合。
连续失败数达到 `advisorAfterFailures` 时先发失败卡再入 `needs_fix` 咨询顾问，
`review/advisor.ts` 的 `parseAdvisorOutput` 把裁决收敛成 `continue | stop | narrow` 三选一，
子进程故障不伪装成仲裁结论；裁 `stop` 即终止，否则转入修复相并补一张顾问卡。

**修复反馈往返**：`awaiting_fix` 把 FAIL 票（只含失败票）与顾问建议经 `deliverFeedbackNow` 投给执行模型，
修复生命周期 `pending → awaiting_start → running → completed` 写进 checkpoint；宿主 `sendMessage`
无返回值，故用 `agent_start` 作启动回执、`agent_end` 作完成确认，只有 `completed` 才进入下一轮。
`review/prompt.ts` 纯拼装四类文本（审查、顾问、修复反馈、总结），往轮发现清单随轮注入顾问裁决，
避免审查者原样重提已仲裁事项。

**总结回合与终态**：质量裁决终态（通过 / 顾问叫停 / maxRounds 用尽）先经 `summarizing` 相——结果卡照发，
再由 `deliverSummaryNow` 投一个带反循环禁令的总结回合，回合结束才落 `settled`；事故终态
（`CANCEL`/`TIMEOUT`/基础设施错误）直接 `settled` 不烧总结回合，看门狗在总结相到点也只静默收尾。
不变量由 reducer 保证：同一时刻至多一个活动轮、`round` 单调递增、`history` 只追加不改写。

**checkpoint 出与恢复**：`review/checkpoint.ts` 把 reducer 状态整体写成 pi 的 custom entry
（`CHECKPOINT_TYPE`，不进 LLM 上下文）。新审查首写 `beginCheckpoint` 无条件替换旧终态，
后续 `writeCheckpoint` 带 runId + 单调 seq 的 CAS，冲突抛 `CheckpointConflictError`
（同一场审查被两个运行时恢复时只有 runId 不够）。持久化失败时 `dispatch` 直接中止本次迁移的副作用，
避免拿不一致的状态起子进程。恢复路径：`session_start` 只重建 controller 并 `RECOVER`
（把未确认完成的修复/总结回合回退成 `pending` 以便重投），宿主在所有异步 handler 完成后发的
`resources_discover` 才允许推进；`reload/new/resume/fork` 保留 checkpoint 交给新运行时，只有 `quit` 落终态。
功能被用户关闭时封存活动 checkpoint；配置坏掉不算关闭——保留原样，修好重启继续恢复。

**卡片与 UI 出**：结果卡经 `send_card` 效果投递，`review/card.ts` 渲染；`review/ui.ts` 提供活动框与交互，
等模型时编辑器完全隐藏并禁止输入，esc/Ctrl+C 取消；`review/progress.ts` 从子进程事件派生模型进度、
token 与工具耗时，是纯 UI 态，明确不入 checkpoint。

## 改动指南

改状态机先看 `state.ts`（reducer 与全部相迁移）+ `tests/review-state.test.ts`；改启动/恢复/投递时序看
`index.ts` 的 `advanceWhenIdle` 与 `dispatch`；改持久化看 `checkpoint.ts`；改输出契约同时改
`prompts/review.{zh,en}.md` 与 `reviewer.ts` 的解析。行为回归由 `tests/review-*.test.ts` 八个用例覆盖
（状态机、契约解析、卡片与 checkpoint、子进程、outcome、UI、集成）。

常见坑：

- **checkpoint 键白名单靠 `satisfies` 防漂移**：校验键集用 `satisfies Record<keyof …, true>` 从领域类型派生，
  state.ts 增删字段而 checkpoint.ts 未同步时编译失败——这是手写校验漂移的唯一防线，绕过它曾导致终态写不进去、
  重启恢复出幽灵审查。
- **stdout 按行消费不得尾截**：process.ts 只保留未完成的残行，不做尾部截断；截尾会把长输出误判为空。
- **error 票不判失败**：`settleRound` 聚合时任何非格式错误的 error 票让整轮判 `error`（基础设施错误），
  即使同轮已有 FAIL 也不能把未完整形成的审查误报为 Review Failed。
- **渲染器永不抛异常**：card.ts 的渲染器在 `registerReview` 里无条件注册（即使功能关闭，保证 reload 与
  live 外观一致），details 校验失败降级 content 纯文本，任何输入都不得抛出。
- 带背景的卡片里禁用 pi-tui 的截断组件（省略号带全量 ANSI 重置会掐断背景色），单行截断用共享 `clip`。

总览见 [../system.md](../system.md)。
