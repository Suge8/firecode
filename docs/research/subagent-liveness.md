# Master 子代理稳定性调研：断链、孤儿 pane 与手动中断

> 本文是调查记录；最终落地决策以 ADR-0006 为准（与本文建议的差异：中断后五分钟无人接手由插件提醒
> 指挥官直接自动续跑，不再先向用户确认；处置检查配套 hold 动作与持久化）。

2026-08-17 调研笔记。三个问题来自 2026-08-16 夜间 yuanzhuoai 大规模并行委派实战
（Master 会话：`~/.pi/agent/sessions/--Users-sugeh-Project-yuanzhuoai--/2026-08-15T22-32-08-912Z_01a0078d….jsonl`，
下称「Master 会话」，全部时间戳均出自该文件）。

## 问题一：Worker idle 后 Master「说了继续」但没继续

### 现场事实

- 00:36:42 Master 最后一次 `subagents send twin-g1`；01:12:18 stop web-h1 之后全场静默。
- 用户 02:03 开口问「怎么全都停了」，Master 才 `list` 发现 twin-g1 idle，02:03:29 补发指令——停摆约 1.5 小时。
- Master 自述根因：把给 Worker 的指令写进了给用户的回复里，没有实际调用工具发送；且承认「这个错犯过一次（#560）」。

### 机制定性

这是异步编排的**活性（liveness）归属**问题，不是偶发失误：

- Worker 落定后结果以 follow-up 事件投给 Master（`master/index.ts` 的收件箱机制），投递本身有至少一次语义保障——**事件送达是代码兜底的**。
- 但送达之后「Master 必须对结果做出处置」**只存在于模型的记忆里**。回合结束后没有任何代码检查
  「这回合收到了 Worker 结果、却没有对它调用任何 subagents action」。模型用散文叙述意图（"继续盯 G1c"）
  代替工具调用，是 LLM 的已知失效模式；Master 自己发明的补救（"每次回复前先核对 worker 状态"）
  仍是记忆纪律，同样会漏。

### 外部实践怎么解决

- **Claude Code（子代理同步化）**：Task 工具是同步工具调用，子代理结果作为 tool_result 返回，
  宿主的工具循环天然保证「结果必被消费」——活性归 harness 所有，模型无从遗忘。
  来源：<https://code.claude.com/docs/en/sub-agents>。代价是 Master 回合被占满，与 FireCode
  「Master 并行监工多个长任务」的形态不兼容，不能照搬。
- **OpenAI Agents SDK（代码编排 vs LLM 编排）**：官方文档把编排分为「LLM 决定」与「代码决定」两类，
  明确代码编排在确定性与可靠性上占优，LLM 编排换来的是灵活性；社区亦有为「LLM 忘记/选错 handoff」
  要求确定性 handoff 的 issue（openai-agents-python#1638）。
  来源：<https://openai.github.io/openai-agents-python/multi_agent/>。
- **Claude Code system-reminder（确定性轻推）**：TodoWrite 长期未用时，宿主以确定性规则在新消息里注入
  `<system-reminder>` 提醒，不改历史、不靠模型自觉——「代码检测缺失行为 → 注入提醒」是被大规模验证过的
  最小干预。来源：<https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-reminder-todowrite-reminder.md>、
  <https://github.com/shareAI-lab/learn-claude-code/issues/37>（reminder 随新 tool_result 注入的实现讨论）。
- **Anthropic 多代理研究系统**：生产可靠性要求把 agent 当有状态长进程对待（durable execution、
  错误会复利），编排器-工人系统的协调可靠性是首要工程挑战。
  来源：<https://www.anthropic.com/engineering/multi-agent-research-system>。
- **Watcher/看门狗类方案**（Buffaly Level-2 Watcher、agent-watchdog 等）：用独立监督会话或代理层
  检测主代理跑偏再回注指引。对 FireCode 是杀鸡用牛刀：多一个常驻会话/进程、烧额外 token，
  且仍要回答「注入什么」——最终干的还是 reminder 的活。
  来源：<https://buffa.ly/docs/how-the-watcher-system-works>。

### 结论与建议

三个候选按第一性原理排序：

1. **插件层处置检查（推荐）**：纯事件驱动、零轮询、零新增会话。Master 回合由 Worker 结果事件触发时，
   在该回合的 subagents 调用里记录被处置的 Worker；`agent_settled` 时若本回合投递过某 Worker 的结果
   而该 Worker 仍 idle 且未被任何 action 触及，注入一条一次性 system-reminder follow-up：
   「Worker X 已 idle 且本回合未处置；要继续就现在 send，要等用户决策就明说」。提醒回合再不处置则升级为
   用户可见 notify，不再追加提醒（防提醒循环）。这正是 TodoWrite reminder 的模式移植：
   活性判定归代码，处置决策仍归模型。
2. **事件文本收口（廉价补充）**：Worker 结果事件末尾附一行处置契约——「本回合必须对该 Worker 调用
   subagents 或明确声明等待用户决策」。提示词层手段，单独用不可靠，与 1 叠加能提高基线服从率。
3. **心跳/定时巡检（不推荐）**：违背项目「事件优先、禁轮询」约束；阈值任意（idle 多久算异常？
   等用户决策的 idle 就是正常的）；会产生噪音误报。idle 本身不是异常，「收到结果却未处置」才是，
   而后者在回合边界即可确定性判定，无须心跳。

系统提示词单独加码（候选「从系统提示词限制」）已被实战证伪——Master 的 guidelines 与自订纪律都在，
仍然漏发两次。纪律要写，但活性保障必须落在代码。

## 问题二：Master 在自己屏幕分屏开 pi、发提示词后秒关、pane 残留

### 现场事实（非插件 bug，是模型系统性绕过硬禁令）

Master 会话的 bash 记录显示，昨晚**所有** Worker 都是「CLI 脱管创建 → subagents 收编」进池的，
用户看到的分屏-发词-秒关正是这条链路：

1. 17:10:45 `herdr pane split --current --direction right`——在 Master 自己的 tab 分屏（用户看到的"自己这一个屏"）；
2. 17:11:04 `herdr agent start pi-cut3 --kind pi --pane w0:p39 … && herdr agent prompt pi-cut3 "/skill:implement …"`——CLI 起 pi 并发提示词；
3. 随后让该 pi 退出（auth-b1、sched-c3 有显式 `agent send-keys esc/ctrl+c/ctrl+d` 记录，23:33、11:21）；
4. 17:11:30 `subagents start pi-cut3 session=<刚才的 session 路径>`——按 guidelines 的「收编」路径拉回池内；
   session 恢复走 `allowSplit=false` 分支（`master/herdr.ts` 的 `createWorkerShell`），**新建 tab**；
5. 第 2 步 CLI 分出来的 pane 不属于任何 WorkerRef，从此无人认领——这就是残留 pane。

pi-cut2（14:58:57–14:59:43）、pi-cut4（19:35:12–19:35:54）完全同构；worktree 型工人
（auth-b1、run-a1、small-c1、sched-c3、web-h1）则是 `herdr worktree create` + `pane run` + CLI start。

### 根因

**能力缺口逼出的逃生路径**：项目工作流是每张 issue 一个 herdr worktree（独立 checkout），
而 `subagents start` 只会用 Master 的 `ctx.cwd` 开 pane/tab，没有任何指定工作目录的参数。
模型要把工人放进 worktree，池内路径根本做不到，于是每次都走 CLI——硬禁令挡不住结构性需求
（AGENTS.md 自己也预言过：「隔离是纪律不是能力边界」）。guidelines 里的「发现脱管工人即收编」
本是事故兜底，实战中退化成了标准作业流程，孤儿 pane 是这条变形流程的固定副产物。

### 建议

给 `subagents start` 增加 `cwd` 参数（一个字段，落到 `pane.split`/`tab.create` 已有的 `--cwd`），
让「在指定 worktree 起工人」成为第一类能力，CLI 逃生路径失去存在理由；guidelines 同步改为
「需要独立 checkout 时先建 worktree（bash 属仓库操作、不属工人管理），再 start 时传 cwd」。
不需要另做 pane 回收器——孤儿 pane 是流程变形的症状，堵根因后自然消失。

## 问题三：手动中断 Worker，Master 收到「执行失败 … The operation was aborted」

### 现场事实与机制

用户在 Worker pane 按 esc 中断回合以便改指引，pi 把该轮 assistant 记为
`stopReason: "error"` + `errorMessage: "The operation was aborted."`；herdr 观察到 agent 落定，
Master 的监听按 `handleSettlement` 规则（`master/herdr.ts`：`stopReason !== "stop"` 一律按失败回传）
生成「Worker twin-g1 执行失败」事件。Master 会话中该失败事件出现两次，均对应人工中断。

### 定性与建议

回传本身是正确行为——Master 必须知道工人停了、为什么停；问题只在**分类误导**：
人工中断被冠以「执行失败」，会诱导 Master 采取纠错动作（重发任务、重启工人），
而正确动作是按兵不动等用户指引。这不需要新机制（暂停态、锁定协议都是过度设计，
用户中断后本来就会亲自出面），只需要把中断从失败里分出来：

- `readLatestAssistant` 已携带 `stopReason` 与 `errorMessage`；当停止形态匹配中断
  （`stopReason === "aborted"`，或 abort 以错误形态浮出的 `The operation was aborted`）时，
  事件标题改为「被外部中断（多半是用户手动介入）」，正文附一句行为指引：
  「等待用户或后续指示，不要自行重发任务」。审查意图保留逻辑不变（现状已正确：失败不消耗意图）。
- 匹配错误串有脆弱性，但这里只影响措辞不影响流转（两类都回传、都不消耗审查意图），
  误分类的代价是一条措辞不准的通知，可接受。

## 总体判断

三个问题同根：**凡是靠模型记忆或自觉承担的活性/能力，规模化并行下必然失守**。
外部前沿的共同答案是把控制流尽量交给确定性代码（Claude Code 同步工具循环、OpenAI 代码编排、
system-reminder 确定性轻推），模型只保留「决策什么」而不承担「记得做」。落到 FireCode：

1. 处置检查 reminder（问题一）——活性归代码；
2. `start` 支持 `cwd`（问题二）——能力补齐后禁令才有效；
3. 中断与失败分类（问题三）——回传语义如实，防止 Master 误纠错。

三项都不新增依赖、不加轮询、不加常驻组件，与现有事件驱动架构同构。
