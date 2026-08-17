---
sources:
  - agent/extensions/firecode/statusbar/index.ts a042a8c55ec6 registerStatusBar setFooter fitStatusLine message_end
  - agent/extensions/firecode/statusbar/quota.ts 1d978210b0e5 registerQuota refresh subscriptionProvider loadQuota BACKOFF_MS FRESH_MS requestGeneration
  - agent/extensions/firecode/statusbar/quota-cache.ts 51567221d542 fileQuotaCache QuotaCache QuotaCacheEntry nextAttemptAt failures
  - agent/extensions/firecode/statusbar/quota-parse.ts 1818c49ceebb parseOpenAIQuota parseAnthropicQuota parseGrokQuota QuotaWindow QuotaStatus
  - agent/extensions/firecode/statusbar/render.ts 4611e8748c9a StatusLineParts fitStatusLine fitMetadataLine alignRight renderQuota renderContext renderCache renderTps latestCacheHitPercent reviewStatus badge
  - agent/extensions/firecode/statusbar/tps.ts 01cead660b89 registerTps TpsStatus MIN_SAMPLE_MS UPDATE_INTERVAL_MS
  - agent/extensions/firecode/theme.ts 485324b650f0 quotaColor contextColor cacheColor thinkingColor
---

# 状态栏

## 职责

接管 pi 的 footer，输出固定两行：首行是工作目录 / Git 分支 / 会话名，可附带 Master 的指挥官徽标（扩展状态表 `master` 键，见 [master.md](./master.md)），并把 `/fire-review` 广播的审查进度右对齐挂在行末；次行是模型（含思考等级与 fast 标记）、订阅额度、上下文占用、缓存命中率与生成速度。额度抓取覆盖 openai-codex / anthropic / xai 三家订阅制供应商，事件驱动、无定时轮询，结果与失败退避写在跨进程文件缓存里，多个 pi 会话共享同一次请求。模块自持三份可变状态：额度快照、速度快照、宿主给的重绘回调；额度与速度由各自 register 通过回调推入并立刻请求重绘（见 [../system.md](../system.md) 的 feature 装配）。

## 对外接口

- `registerStatusBar`（`statusbar/index.ts`）：模块唯一注册入口，`session_start` 时经 `ctx.ui.setFooter` 挂渲染器，`session_shutdown` 置空。插件其余部分只调这一个函数。
- `registerQuota` / `registerTps`（`quota.ts` / `tps.ts`）：以回调形式向 index.ts 推送 `QuotaStatus` / `TpsStatus` 快照，`registerQuota` 额外接收 `QuotaCache` 实现（生产用 `fileQuotaCache`，测试可注入内存实现，`tests/quota.test.ts` 即如此覆盖）。
- `render.ts` 的纯函数层：`fitStatusLine`、`fitMetadataLine`、`alignRight`、`renderQuota`、`renderContext`、`renderCache`、`renderTps`、`latestCacheHitPercent`、`reviewStatus`——入参是数据加宽度，出参字符串，不触碰会话状态，被 `tests/layout.test.ts` 直接调用。
- `quota-parse.ts` 零依赖，导出三家解析函数与 `QuotaWindow`/`QuotaStatus` 类型，`record`/`finiteNumber`/`epochMillis` 容错工具也被 quota.ts 复用。

消费本模块之外，状态栏自己只读三个外部信号：`fire-review` 状态键（[review.md](./review.md) 广播审查进度）、`pi-openai-native-fast` 状态键（[provider.md](./provider.md) 注册 fast 通道标记）、`master` 状态键；键不存在时对应片段为空，状态栏不感知这些模块是否启用。

## 数据怎么流

**进**：三路来源汇入 index.ts 的渲染闭包。

1. 宿主 ctx 与事件：模型与思考等级（`ctx.model`、`pi.getThinkingLevel()`）、上下文占用（`ctx.getContextUsage()`）、会话名与条目（`ctx.sessionManager`）、分支变化订阅与扩展状态表（`footerData`）。缓存命中率由 `latestCacheHitPercent` 从最近一条带 usage 的助手消息反推 `cacheRead / (input + cacheRead + cacheWrite)`，因此 `message_end`（助手消息）也触发重绘。
2. 额度 API：`session_start` 与 `model_select` 强制刷新（先推 `loading` 态），`agent_end` 每轮跟一次不强制。`subscriptionProvider` 先过滤——provider 须属三家之一，anthropic / xai 还须 OAuth 登录态（`modelRegistry.isUsingOAuth`）。token 来源各异：OpenAI 与 Anthropic 走 pi 凭据，OpenAI 还从 JWT payload 解出 `chatgpt_account_id` 补请求头；xAI billing 拒绝 pi 的 OAuth token，只认官方 CLI 写在 `~/.grok/auth.json` 的登录态（按 scope 前缀筛选并检查过期）。请求 3 秒超时；xAI 月度与周度两请求走 `Promise.allSettled`，全败才算失败。
3. 缓存文件：`fileQuotaCache` 每个 provider 一个 JSON 文件（`~/.pi/agent/tmp/firecode-quota-<provider>.json`），条目只有窗口数据、`nextAttemptAt`、连续失败数三个字段；读取用 `isEntry` 校验形状，损坏当无缓存；写入走临时文件加 rename 原子覆盖，避免多进程互相截断。在 `nextAttemptAt` 之前其他会话直接复用结果，不发请求。
4. 速度：`tps.ts` 从 `before_provider_request` 起表，`message_update` 的文本/思考/工具增量累加估算 token（4 字符≈1 token，官方 output token 优先），`message_end` 结算整轮耗时。

**出**：所有数据拼成 `StatusLineParts` 交给 render.ts 纯函数产出两行字符串，经 `tui.requestRender` 画进 footer。着色阈值统一走 `theme.ts` 的 `quotaColor`/`contextColor`/`cacheColor`/`thinkingColor`，裁剪走 `format.ts` 的 `clip`/`formatTokens`/`formatDuration`。

## 改动指南

先看的文件按改动类型分：改布局或降级顺序看 `render.ts`（配 `tests/layout.test.ts`）；改抓取时机、退避或 token 来源看 `quota.ts`（配 `tests/quota.test.ts`）；改某家供应商的响应解析只看 `quota-parse.ts`；改数据接线看 `index.ts`。

常见坑：

- **七级降级候选**：`fitStatusLine` 按固定序列逐级收窄——完整 → 去速度 → 模型去 fast 标记 → 额度只留最紧窗口 → 去额度 → 去缓存 → 上下文紧凑形式，取第一个 `visibleWidth` 不超限的候选；全放不下再保上下文、裁模型名。新增片段必须排进这个序列，否则窄终端会溢出。空片段在拼接时被过滤，不会留孤立分隔符。首行的 `badge`（指挥官态）是整段取舍：放不下就丢，不截半个；会话名与位置则有截断阶梯。宽度一律用 `visibleWidth`，片段都带 ANSI 颜色码。
- **requestGeneration 世代号**：切模型或关会话让在飞额度响应失效，回来的旧结果只写缓存不更新 UI，防止把上个模型的额度画到新模型上。绕过世代号直接 `update` 会重新引入这个竞态。
- **缓存文件退避档**：发请求前先把 `nextAttemptAt` 推到当前时间加 `FRESH_MS`（60 秒）占住窗口，兼作进程内并发保护；成功按同 TTL 重写，失败按 `BACKOFF_MS` 的 1 / 2 / 5 分钟递增并清空窗口，末档为上限。退避状态在文件里跨进程共享，改档位影响所有并行会话。
- **三家解析容错**：供应商响应是各家 CLI 内部接口而非公开契约，解析不得抛错——逐层 `record`/`finiteNumber` 校验，缺字段的窗口被过滤而非报错。OpenAI 标签从 `limit_window_seconds` 反推，Anthropic 读 `five_hour`/`seven_day` 的 utilization，xAI 要把月度 used/limit 折算百分比再并周度信用。改解析先跑 `tests/quota.test.ts`。
- **速度抖动阈值**：实时 t/s 要求采样窗口至少 `MIN_SAMPLE_MS`（1 秒）、刷新间隔不低于 `UPDATE_INTERVAL_MS`（250ms），删掉会导致状态栏高频重绘。
