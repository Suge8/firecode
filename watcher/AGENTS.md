# watcher：观察员

主会话每个 turn 结束后异步评估增量，按 nit / concern / blocker 三档投递建议。独立于 Master 与
fire-review 注册，关掉不影响其余；Worker 会话（`FIRECODE_MASTER_WORKER`）里不注册，审查子进程带
`--no-extensions` 天然没有。

## 观察会话

只经 `master/spawn.ts` 创建：memory 持久化（观察过程不落盘、无 checkpoint）、只读工具
read/grep/find/ls、系统提示整体替换、注入 contextFiles。`prompts/watch.zh.md` 是提示词唯一事实源，
四段结构缺一不可：角色克制（旁观者，建议供权衡勿盲从）、关注面（偏离 spec/工单、过度工程、漏需求、
未收口、危险操作）、输出契约（只准经 advise 说话，三档语义，每次至多一条）、证据纪律（先核实再开口）。

`advise` 是注入观察会话的唯一自定义工具，也是观察员唯一的输出通道：正文文字不会被任何人看到。同一次
评估的第二次调用当场拒绝，多余的问题留到下一次。

## 触发与重置

`turn_end` 把渲染好的增量推进待评估缓冲，评估在后台跑。评估期间到达的回合合并进下一批——只有缓冲，
没有积压队列，落后时天然跳到最新。喂给会话的增量始终是 append-only 的新内容，已评估过的回合留在前缀里
不重发，前缀缓存因此有效；`minimal` 渲染省略 reasoning 与 diff 正文（`context: "full"` 才带上）。

fire-review 活跃期（订阅 review 发布的 `herdr:blocked` 频道）零评估，增量留到审查结束合并处理。主会话
compaction、会话切换或观察会话自身上下文超过阈值时，丢弃观察会话与未评估增量，从当前尾部重新入场，
不回放历史。

## 投递路由

建议自带时点标记（「基于第 N 回合前的观察」）：投递时主会话可能已经走远。

- `nit`：自定义 entry 卡片，不进入模型上下文，不打断任何回合。
- `concern`：`sendMessage` + `deliverAs: "steer"`，回合进行中提请注意，不唤起。
- `blocker`：steer；指挥官空闲时 `triggerTurn` 唤起一个回合并经 `session/bark.ts` 同步推送（bark 未配置
  时静默跳过）。

用户 esc 手动中断过的现场只出卡片：人的接管权压倒一切，`agent_start` 才解除该标记。

## 配置

`watcher` 节：`enabled`（默认 true，新会话自动激活）、`model` 与 `thinking`（必须显式配置）、`context`
（默认 `minimal`）。节缺失、字段缺失、未知字段或类型错误都算配置问题：观察员拒绝启动并在 `session_start`
警告一次，绝不回退默认模型。模型必须能在内置 provider 解析——扩展注册的 provider（如 antigravity）在
子会话里不可解析，解析失败时报错引导改用内置 provider 模型。

`/fire-watch [on|off]` 只切换当前会话，不写回配置。状态栏观察员段显示当前模型。
