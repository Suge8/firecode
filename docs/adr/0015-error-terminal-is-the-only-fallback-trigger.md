---
status: accepted
amends: 0012-role-dispatch-and-provider-fallback
---

# error 终态是 fallback 的唯一判据

Worker 回合以 error 终态结束即触发角色 fallback，原因取错误消息首句原文，不再按关键词分类故障类型。

0012 用三条正则白名单识别"确定性供应商故障"：额度计费、模型不可用、5xx 与 service unavailable。实测近一周全部会话的 error 文本，最高频的两类是 `Our servers are currently overloaded`（302 次）与 `An error occurred while processing your request`（121 次），两条都不含 5xx 数字或既定字样，白名单一条都不匹配，降级因此从未发生；限流的 429 同样漏判。更重要的是分类结果对决策没有影响：三个标签走同一条切换路径，只被拼进一句切换提示，而原始错误首句比标签更准确。

替代方案是继续往白名单里补关键词。供应商每换一次措辞就漏一次，而这套分类本身不参与任何判断，属于必然腐化且无收益的维护面。另一个替代是交宿主统一处理，但宿主不知道 FireCode 的角色与 fallback 链。

## 后果

本地网络故障、上下文溢出这类换模型也解决不了的 error 同样会触发降级，代价是沿链至多多试两跳后落失败，链用尽仍明确报错。瞬时限流不再被特殊对待：宿主的退避重试仍在 error 终态之前，重试用尽后的限流按故障降级。切换提示里出现的是供应商原话而不是归类标签。
