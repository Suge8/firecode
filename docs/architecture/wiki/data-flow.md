---
sources:
  - agent/extensions/firecode/index.ts 371b956bc12d loadConfig session_start
  - agent/extensions/firecode/provider/openai-native/src/request-pipeline.ts ed2089566058 rewriteOpenAIProviderRequest replayOpenAINative applyOpenAIOptions
  - agent/extensions/firecode/provider/claude-sub.ts 03508d39cc7e before_provider_request buildBillingHeader
  - agent/extensions/firecode/review/index.ts f2a6f35f299d dispatch advanceWhenIdle setOccupancy
  - agent/extensions/firecode/master/herdr.ts 1e145c952309 monitorSettlement handleSettlement autoReview
  - agent/extensions/firecode/master/index.ts a292b31177f3 flushMasterEvents PENDING_EVENT_TYPE
  - agent/extensions/firecode/statusbar/quota.ts 1d978210b0e5 refresh subscriptionProvider
  - agent/extensions/firecode/session/bark.ts e76b3adf5dd4 buildBarkPayload hasBlockedWorker
  - agent/extensions/firecode/session/presets.ts 1a9628dd591d applyPreset
  - agent/extensions/firecode/session/stats.ts 253b5c7b8885 collect
---

# 数据流

FireCode 是 pi 扩展，没有自己的进程；一切数据流都从四类入口进入：**斜杠命令**、**快捷键**、
**宿主事件钩子**、**外部投递**。下面每个真实入口至少一条端到端路径。

## 入口清单

| 入口 | 类型 | 落点 |
| --- | --- | --- |
| `/fire-review` | 命令 | review 执行器（`review/index.ts`），Master 也从外部把这个字面量投进 Worker pane |
| `/fire-master [off\|status]` | 命令 | Master 激活/关闭/状态（`master/index.ts`） |
| `/preset [名]`、`/rename`、`/tokens`、`/fast`、`/tool-status` | 命令 | presets / rename / stats / openai-native / tools 各自模块 |
| `keys.rename`、`keys.cyclePreset`、预设自带 key、`keys.fast` | 快捷键 | 与同名命令同一路径（启动时绑定，改配置需重启） |
| `before_provider_request` | 宿主钩子 | provider 两条请求改写路径 |
| `session_before_compact` | 宿主钩子 | 原生压缩（关闭时返回 undefined 走宿主默认压缩） |
| `session_start` / `resources_discover` | 宿主事件 | 装配告警、review checkpoint 恢复、Master reconcile、额度抓取 |
| `agent_start` / `agent_end` / `agent_settled` / `message_end` | 宿主事件 | working-flame 挂撤、review 互锁与开审、bark 推送、状态栏重绘 |

## 场景一：Master 委派与回传（/fire-master → subagents）

`/fire-master` 激活后 Master 会话获得 `subagents` 工具 → `start` 经 `master/herdr.ts` 在
herdr 里 split pane（2×2 象限）、临时 ZDOTDIR 挂 precmd 标记等真实 shell 就绪、`agent start`
拉起 Worker（独立 pi 进程，带 `FIRECODE_MASTER_WORKER`，busy 退避重试 15s）→ 每次状态变化经
`master/state.ts` 原子落盘（v5、0600）→ `monitorSettlement` 无截止等待落定 →
`handleSettlement` 分流：带 `REVIEW_OCCUPANCY_LABEL` 的 blocked 转 reviewing、其余 blocked
回传提问、`stop` 成功回传、中断走续监与五分钟自动续跑提醒 → 声明 `review:true` 的成功落定由
`autoReview` 投递字面 `/fire-review` 到 Worker pane（进入场景二）→ 终态经 `readReviewOutcome`
读回 → 回传统一走收件箱：入队即以 `PENDING_EVENT_TYPE` 落 Master 会话，`flushMasterEvents`
在回合边界合并成一条 follow-up 投递，投成写 ack，reload 后 pending−ack 差集重投。

## 场景二：对抗性审查循环（/fire-review）

命令进入 `review/index.ts` 执行器 → 事件经 `dispatch()` 串行灌入 `review/state.ts` 的
`reduce()`，返回新状态 + effect → `advanceWhenIdle()` 过 idle 门后按配置清单 spawn 审查者
子进程（`review/process.ts`，`pi --mode json`，排除 write/edit，stdout 按行增量消费）→
每票 `REVIEWER_SETTLED` 回灌聚合（error 票判整轮 error、FAIL 进修复相、全 PASS 经总结相落
settled）→ FAIL 发现投回执行模型修复（`agent_start`/`agent_end` 回执确认），连续失败达阈值
咨询顾问 → 全程每次迁移写 checkpoint（`review/checkpoint.ts`，runId+seq CAS 防双运行时）、
发结果卡、`setOccupancy` 双通道发布占用（进程内 `herdr:blocked` 频道 + herdr-client 直投
`state_labels.blocked` TTL 租约）。终态由外部经 `review/outcome.ts` 只读解析。

## 场景三：模型请求改写（before_provider_request / session_before_compact）

每次模型请求经 `before_provider_request`：Anthropic OAuth 会话由 `provider/claude-sub.ts`
判定 `shouldApply` 后返回新 payload（system 首位插 `buildBillingHeader` 归因块，API Key 会话
原样通过）；OpenAI/xAI 由 `request-pipeline.ts` 两步顺序改写——先在开启原生压缩时
`replayOpenAINative` 用 `compactedWindow` 替换压缩点前的 input（重算期望 payload 深比较，
不一致即放弃改写），再 `applyOpenAIOptions` 写 `text.verbosity` 与 `service_tier: "priority"`。
压缩本体走 `session_before_compact`（`native-compaction.ts`）：触发取材 → 直调 Responses API
`compaction_trigger` → 压缩条目连同身份四元组落会话 jsonl，供 replay 读回。

## 场景四：会话外围联动（宿主事件驱动）

- **额度**：`session_start` / `model_select` / `agent_end` 触发 `statusbar/quota.ts` 的
  `refresh` → `subscriptionProvider` 判定订阅制供应商 → 抓各家用量接口 → 结果与 1/2/5 分钟
  退避写 `~/.pi/agent/tmp/firecode-quota-<provider>.json` 跨会话共享 → 状态栏重绘。
- **落定通知**：`agent_settled` 且 idle 时 `session/bark.ts` 的 `buildBarkPayload` 组通知 →
  `hasBlockedWorker` 只读 Master 状态文件，有待拍板升 timeSensitive → 推 Bark APNs。
- **身份投影**：`session_info_changed` / `model_select` 等 → `session/herdr-display.ts` 串行经
  herdr-client 写 pane 副标题，送达确认才记已发布。
- **工作火焰**：`agent_start`/`agent_end` 挂撤 widget，订阅 `herdr:blocked` 在审查活跃期退让。

## 命令小径（不成场景的短路径）

`/preset` → `applyPreset` 快照当前状态后切模型/工具/附加指令（附加指令在 `before_agent_start`
拼进 systemPrompt）；`/rename` → 清洗后 `setSessionName`，显示投影由 herdr-display 事件承接；
`/tokens` → `collect` 扫 `sessions/*.jsonl` 按 `usageAttribution` 归因输出 Markdown 表；
`/fast` → 文件锁内只替换 config.jsonc 的 openai 节文本，原子覆盖立即生效；
`/tool-status` → 列出已加载/已启用工具。

## 启动装配（所有入口的前置）

pi 加载扩展 → `index.ts` 默认导出执行 `loadConfig()`（读插件目录 config.jsonc，产出
`{ config, problems }`）→ 按 `features` 逐个 `registerX(pi)`；herdr 投影与 review 卡渲染/
checkpoint 收口无条件注册。配置问题不阻断装配，`session_start` 逐条 notify，由各功能自行
决定拒绝启动（review/master 命中问题即拒绝）。
