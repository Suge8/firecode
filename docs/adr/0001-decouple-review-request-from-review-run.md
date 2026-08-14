---
status: superseded by ADR-0002
---

# 分离审查请求身份与审查运行身份

Master 只决定是否为任务创建 Review Gate，并通过 `/fire-review --request=<Review Request ID>` 发起审查；该 ID 是调用方提供的不透明关联值。fire-review 独立生成并拥有 Review Run ID，通过 Started 与 Settled 事件同时回传两种身份。这样可以严格拒绝延迟、重复和串单结果，同时避免 Master 拥有 fire-review 的运行身份或内部轮次。

## 后果

任务交付状态与 Review Gate 状态分开；每个 Gate 绑定创建时的 Task attempt，同一 Task 的 Gate 只追加不覆盖。Team Board 快照保留每次 attempt、Request、Run、状态、详情和期限用于审计，只有当前 attempt 的 Gate 能满足 required 策略。无身份旧终态可作为不带 attempt 的审计事实保留，但不能授权完成。Review Passed 只满足 Gate，不自动完成任务；Review Failed 返回修复；基础设施、启动或结算超时形成 Review Unavailable，由 Master 独立完成项目验证。

Worker bridge 在发送前把 Review Event 写入 Pi session custom entry，收到 Team Board ACK 后再确认；reload 或断线会重放未确认事件。Team Board 按 Worker、Task、Review Request ID、Run ID 与阶段幂等处理。startup 和 settlement deadline 都以绝对时间持久化并由单次计时器恢复，因此 review 关闭、配置错误或事件交付中断不会阻塞 Master。
