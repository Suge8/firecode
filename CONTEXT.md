# FireCode 领域术语

FireCode 让一个指挥官按需委派工人并保留长任务上下文，配合 fire-review 对抗审查把关质量；
两者互不引用。

## 委派

**指挥官（Master）**：
决定是否委派、如何分派以及如何验收结果的主控 Agent。
_避免使用_：主控、Supervisor、Team Lead

**工人（Worker）**：
由指挥官启动、承接一段明确工作说明的 Pi 会话。
_避免使用_：工作者、任务、子代理（"子代理"另指 fire-review 的审查者子进程）

**工人池（Worker Pool）**：
当前指挥官可观察和控制的在线工人与休眠工人集合；它不记录 Goal、Task 或协作历史。
_避免使用_：团队、任务板、任务队列

**在线工人（Live Worker）**：
仍有运行进程、可继续接收追问的工人。
_避免使用_：Active Task、Running Ticket

**休眠工人（Dormant Worker）**：
进程已释放但 Pi session 仍可恢复的工人。
_避免使用_：已关闭工人、归档任务

**工作说明（Delegation）**：
指挥官交给工人的自包含委派文本，包含任务、交付物、限制和验证要求。
_避免使用_：任务、工单、Assignment Record

**工人结果（Worker Result）**：
工人停下时回传给指挥官的最终回复；它是证据输入，不代表指挥官已验收。
_避免使用_：Task Done、Review Passed

**工单库（Tracker）**：
项目内存放工单的位置（本地 `.scratch/` 或远端 issue tracker，约定见项目 docs/agents/issue-tracker.md），流程中工单的唯一事实源；插件不读写它。
_避免使用_：任务队列、任务板

**工单（Ticket）**：
工单库中的一张垂直切片工单，声明自己的阻塞边；是指挥官生成工作说明的输入，完成即删除或关闭。
_避免使用_：任务、工作说明

## 对抗审查

**fire-review**：
独立于指挥官的对抗性审查能力，拥有自己的运行状态和结果；只能由会话外部投递 `/fire-review` 触发。
_避免使用_：Master Review Gate、Worker Validator

**审查者（Reviewer）**：
每轮并行挑错的独立 pi 子进程，首行输出 PASS/FAIL；全部 PASS 才算过。
_避免使用_：质检员、子代理

**顾问（Advisor）**：
连续多轮失败后介入的仲裁模型，输出裁决而非新发现。
_避免使用_：仲裁员、第四审查者

**裁决（Verdict）**：
顾问的三选一输出：continue（继续修）/ narrow（收窄范围）/ stop（叫停交还用户）。
_避免使用_：判定、结论

**修复回合（Repair）**：FAIL 反馈注入后执行模型自动修复的那一个 turn，以 turn 正常结束判定完成；期间不得委派。
_避免使用_：返工、修复循环（后者指多轮整体）

**占用信号（Occupancy）**：
审查活跃期间经 Herdr 集成频道持有的“会话被占用”标记，防止轮间空闲被误判为结束；只影响显示与监听，失效不伤审查。
_避免使用_：blocked（那是 Herdr 的状态名）

**审查判定（Outcome）**：
从工人 session 只读解析的终态：通过 / 停止（质量裁决终止，含轮数用尽）/ 审查未完成（error·cancelled·timed_out）/ 进行中 / 无审查；是指挥官了解审查结果的唯一入口。
_避免使用_：裁决（那是顾问的词）

## 配置

**选型表（Model Roster）**：
config.jsonc 里指挥官派工时的模型依据（模型 id + 默认档位 + 适用场景），注入提示词；建议值，用户显式指定优先。
_避免使用_：花名册、模型清单
