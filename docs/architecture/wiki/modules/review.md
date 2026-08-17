---
sources:
  - agent/extensions/firecode/review/state.ts e31966837f1f reduce initialState ReviewState Phase ReviewEffect
  - agent/extensions/firecode/review/index.ts f2a6f35f299d registerReview advanceWhenIdle persist setOccupancy
  - agent/extensions/firecode/review/checkpoint.ts 7310bfa9cf8a isValidCheckpoint beginCheckpoint writeCheckpoint CheckpointConflictError CHECKPOINT_KEYS
  - agent/extensions/firecode/review/card.ts 973e94148263 registerCardRenderer buildCard isValidCardDetails
  - agent/extensions/firecode/review/ui.ts 3f740cf035f1 showActivity hideActivity lockEditor unlockEditor
  - agent/extensions/firecode/review/progress.ts 7bea9b6188c8 applyProcessEvent settleProgress
  - agent/extensions/firecode/review/outcome.ts 390ab5ea36a2 readReviewOutcome REVIEW_OCCUPANCY_LABEL
  - agent/extensions/firecode/review/reviewer.ts 41b8e170867f parseReviewOutput passIssue failIssue reviewerArgs
  - agent/extensions/firecode/review/advisor.ts 593d2673b179 parseAdvisorOutput
  - agent/extensions/firecode/review/process.ts 7a85429b06c7 runPiProcess
  - agent/extensions/firecode/review/prompt.ts 903045a0ca6e priorRoundsSection buildFixFeedback buildSummaryPrompt
  - agent/extensions/firecode/review/evidence.ts 9e0ba27d2b70 buildEvidence
---

# review — 对抗性审查

## 职责

对当前会话已经做完的事做一场外部对抗性审查：同时请几个外部模型各自独立复核，只要有人判未通过，就把发现交回当前会话的执行模型去修，修完再审下一轮。连续未通过到阈值时请一个顾问模型仲裁，它可以让循环继续、收窄范围或直接叫停，防止无限拉锯。质量上有结论之后（通过、顾问叫停、轮数用尽）再让执行模型用人话收一次尾，把各轮修了什么、为什么过不了讲清楚。

审查过程全程可见：底部状态栏一行、编辑器上方一块带火焰的活动框显示每个模型此刻在读什么、跑什么、用了多久，每轮结论以带背景色的结果卡进入会话记录。等模型结论时输入区被接管，随时可按 esc 取消。

每一次状态变化都先写进会话记录里的一份快照再执行动作，所以重启、reload、恢复会话都能从中断处接着跑，而不会漏投一次修复反馈或凭空复活一场已经结束的审查。审查结果同时对外可读：指挥官在外部发起审查后，只凭这份快照判断这场审查最终是通过、被质量裁决终止还是根本没跑完。

审查者被排除了写入与编辑两个工具，但保留了执行命令的能力——它需要真的跑测试取证。这是契约不是沙箱：真要物理隔离得上容器或只读挂载。

## 对外接口

- `registerReview(pi, enabled, configBroken)`（`review/index.ts`）是唯一入口，注册 `/fire-review` 命令与全部宿主事件。功能关闭时它仍然注册结果卡渲染器（`registerCardRenderer`），历史卡片 reload 后外观不变；只有用户明确关闭才顺手封存仍处活动态的旧快照，配置坏掉不算关闭。
- `readReviewOutcome(sessionPath)`（`review/outcome.ts`）是外部读取终态的唯一入口，只读解析会话文件里最近一条快照，返回 passed / stopped / failed / in_progress / none / error。同文件的 `REVIEW_OCCUPANCY_LABEL` 是审查活跃期对外广播的占用标签文本，Master 靠它把「审查占用」和「子代理真在提问」区分开。checkpoint 的格式仍归本模块所有，外部只准经这个函数读。
- `reduce(state, event, limits, now)` 与 `initialState(runId)`（`review/state.ts`）是纯函数，零 IO，测试直接驱动整条循环。`ReviewEffect` 只有两种：发一张卡、请求推进。
- `buildCard` / `isValidCardDetails`（`review/card.ts`）、`showActivity` / `hideActivity` / `lockEditor` / `unlockEditor`（`review/ui.ts`）是渲染侧接口，都只吃执行器传入的快照，自己不持状态。

## 数据怎么流

用户敲下命令后并不立刻开审：执行模型还在跑就先进排队相，等到宿主真正空闲的边界才开始第一轮。所有会启动工作的动作都走这道空闲门，另有一道硬互锁——只要执行模型要开始新回合，先中止审查子进程并等它们真正退出。

开审那一刻取一次会话快照组装证据。首条用户消息是原始需求锚点，固定保留不参与预算竞争，其余消息按 token 预算从最新往回收；助手消息带上工具调用轨迹（做过什么、哪些调用失败了），审查者据此判断这次会话到底改了什么，共享目录里无法归因的改动不立案。本模块自己发的卡片与反馈消息被排除在证据外，避免自指。

每个审查者是一个独立子进程，输出是逐行 JSON 事件流：事件一边被增量消费成活动框上的实时进度（当前在读哪个文件、跑什么命令、已多少次调用、各自耗时），一边被留到最后取回复正文。正文按输出契约解析：第一行必须是通过或未通过；通过必须带一行摘要加一条同时含文件和命令的证据锚点；未通过的每条发现必须六要素齐全。不合契约的票整票作废，记为基础设施错误而不是质量结论。

一轮里所有审查者都落定后才汇总：只要有真实的基础设施错误就整轮判异常，不会把没形成的审查误报成未通过；有人判未通过则整轮未通过，反馈只带未通过的那几票，归档保留全部原文。

未通过之后分两条路。连续未通过还没到顾问阈值，直接进入修复相：把发现连同「先核实再修、修根因、修完直接结束」的指令投给执行模型，输入区交还用户；回合确认结束才允许进入下一轮。到阈值则先发一张可见的失败卡，再起顾问子进程，裁决继续就补一张顾问卡进修复相，裁决收窄则修复指令改成「只修顾问圈定范围」，裁决停止就直接终止——终止卡只写顾问裁决，不再复制一遍已经展示过的发现。第二轮起，往轮发现连同顾问裁决一起注入新一轮提示，被仲裁掉的事项不允许原样重提，这是循环收敛的闭环。

通过、顾问叫停、轮数用尽这三种质量裁决终态，都先经总结相：结果卡照发，再投一条带反循环禁令的总结提示触发一个可见回合，回合结束才算真正落定。取消、超时、基础设施错误这类事故终态直接落定，不浪费一个回合。

持久化贯穿始终：每次状态迁移先落盘、落盘成功才继续执行副作用，写失败就地停掉这场审查并尽力补一条终态，绝不带着不一致的状态继续起子进程或投反馈。恢复时重投尚未确认启动的修复或总结回合——宿主发消息没有返回值，只能靠回合真的开始作为回执。会话离开当前运行时（reload / 新建 / 恢复 / fork）保留快照由新运行时接手，只有退出才写终态。

审查活跃期对外发两路占用信号：一路进程内广播驱动终端复用器集成的阻塞状态，一路直接把标签写进 pane 元数据——实测只有后者能同时到达指挥官的判定逻辑和侧边栏文本。标签是带有效期的租约，持有期间定时续约，进程崩了也会自己过期，不会把子代理的真提问永久误判成审查占用。占用一直持有到总结完成，指挥官因此能把总结当作最终回复捕获。

## 改动指南

- 循环状态只经 `reduce()` 迁移，`review/index.ts` 是唯一执行器（起子进程、发卡、投反馈、落盘、状态栏）。别在别处存循环状态：模块级只有一个 controller，reload 会整体替换它。
- checkpoint 的键白名单（`review/checkpoint.ts` 里 `CHECKPOINT_KEYS` 等常量）由领域类型 `satisfies` 派生：往 `ReviewState` 增删字段而不同步这里会直接编译失败。这是手写校验漂移的唯一防线——历史事故是终态写不进去，重启后恢复出幽灵审查。schema 只认当前版本，不做字段级兼容。
- 首写走 `beginCheckpoint`（无条件替换旧终态），后续写走 `writeCheckpoint` 的 CAS；期望凭证由执行器自己记着，出现不是自己写的 runId 或 seq 就抛 `CheckpointConflictError` 并停审。
- 带背景的结果卡里禁用 pi-tui 的 `TruncatedText` / `truncateToWidth`：其省略号带全量重置序列，会在截断点掐断外层背景色。单行截断一律用 `format.ts` 的 `clip`。活动框（`review/ui.ts`）不带背景，可以继续用宿主截断。
- 结果卡渲染器永不抛异常：`isValidCardDetails` 不过就降级渲染纯文本。pi 对抛异常的渲染器会静默回落默认框，表现和没注册一样，必须从源头避免。
- 占用标签是租约，不是一次性广播。改 `setOccupancy` 相关逻辑时保留定时续约与清除重试：herdr 没有「进程退出即清元数据」的接口，没有 TTL 的残留标签会让 Master 长期误判。
- 按键必须经 keybindings 匹配，不能只比裸 `\x1b`：终端开启增强键盘协议后 esc 是带修饰的序列，字面量比较会漏。
- 输出契约的事实源是 `review/prompts/review.{zh,en}.md`；`parseReviewOutput`、`passIssue`、`failIssue`（`review/reviewer.ts`）与 `parseAdvisorOutput`（`review/advisor.ts`）是它的执行侧。改提示词必须同步这几个校验，反之亦然。校验容忍旧措辞与非粗体包裹，但不容忍要素缺失。
- 子进程 stdout 必须按行增量消费（`runPiProcess`）：旧实现套用 stderr 的尾部截断，会把最后一条事件的行首切掉，长输出被误判为空。
- 实时进度（`applyProcessEvent` / `settleProgress`）是纯 UI 态，不入 checkpoint：它每次工具调用都变，持久化只会放大写入，重启后由状态骨架重建即可。
- 提示词组装集中在 `review/prompt.ts`：`priorRoundsSection` 负责往轮发现与顾问裁决注入，`buildFixFeedback` 区分继续与收窄两种指令，`buildSummaryPrompt` 携带反循环禁令。这些是纯函数，行为改动要能被单测钉住。
- 证据组装（`buildEvidence`）改动时守住两点：首条用户消息不参与预算竞争；失败的工具调用要标注，无结果的调用不标——把真实编辑误标成未完成会反向制造假通过。
- 配置有任何问题时命令与恢复都必须拒绝启动，不允许静默回退默认模型：那会拿用户没配的模型真实发起付费调用。活动快照保持原样，修好配置重启后继续恢复。
- 相关测试：`tests/review-state.test.ts`（reducer 循环）、`review-contract.test.ts`（输出契约）、`review-integration.test.ts`（执行器编排）、`review-ui.test.ts`、`review-card-checkpoint.test.ts`、`review-outcome.test.ts`、`review-process.test.ts`。
