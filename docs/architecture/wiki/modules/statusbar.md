---
sources:
  - agent/extensions/firecode/statusbar/index.ts a042a8c55ec6 registerStatusBar reviewStatus fitMetadataLine fitStatusLine
  - agent/extensions/firecode/statusbar/render.ts 4611e8748c9a StatusLineParts renderLocation renderQuota renderContext renderCache renderTps reviewStatus alignRight fitMetadataLine fitStatusLine latestCacheHitPercent
  - agent/extensions/firecode/statusbar/quota.ts 1d978210b0e5 registerQuota FRESH_MS BACKOFF_MS REQUEST_TIMEOUT_MS subscriptionProvider grokCliToken loadQuota
  - agent/extensions/firecode/statusbar/quota-cache.ts 51567221d542 QuotaCache QuotaCacheEntry fileQuotaCache
  - agent/extensions/firecode/statusbar/quota-parse.ts 1818c49ceebb QuotaStatus QuotaWindow parseOpenAIQuota parseAnthropicQuota parseGrokQuota
  - agent/extensions/firecode/statusbar/tps.ts 01cead660b89 TpsStatus registerTps
  - agent/extensions/firecode/theme.ts 485324b650f0 quotaColor contextColor cacheColor thinkingColor
---

# 状态栏

## 职责

在终端底部常驻两行信息，让用户不离开对话就知道自己在哪、在用什么、还剩多少。

第一行是身份：当前目录名与 Git 分支、会话名，以及处于指挥官模式时的徽标；右端还会挂上对抗性审查的实时进度。第二行是资源：模型名与思考等级（若开了加速档另加标记）、订阅额度余量、上下文占用、缓存命中率、本轮输出速度。

除了显示，这里还负责两件后台工作。一是向供应商查订阅额度余量——只在会话启动、切换模型、每轮结束这三个时机抓，从不定时轮询，结果和失败退避写进一个跨进程的小文件，同时开多个会话时共用一次请求。二是统计生成速度，从请求发出到最后一段输出落定，边生成边给出每秒 token 数，回合结束后改显示总耗时加均速。

窄终端是常态而非异常：两行都有明确的降级阶梯，宁可整段丢弃也不显示半截内容。

## 对外接口

对外只有一个入口 `registerStatusBar(pi)`，由插件总入口按 feature 开关调用；它内部再挂 `registerQuota` 与 `registerTps` 两个采集器，并通过宿主的 footer 接口注册渲染回调。

- `render.ts` 是纯函数层，也是唯一被测试直接消费的接口：`renderLocation` / `renderQuota` / `renderContext` / `renderCache` / `renderTps` 产出各段文本，`reviewStatus` 从宿主的扩展状态表里取 `fire-review` 键，`latestCacheHitPercent` 从会话条目倒查最近一条助手消息的 usage，`fitMetadataLine` / `fitStatusLine` / `alignRight` 负责按宽度取舍。`StatusLineParts` 是第二行的输入契约（每个可压缩段都成对给出完整版与紧凑版）。
- `quota.ts` 暴露 `registerQuota(pi, update, cache)`：`update` 回调推 `QuotaStatus`，`cache` 是注入的缓存实现，测试因此可以不碰文件系统。
- `quota-cache.ts` 定义接口 `QuotaCache` 与条目 `QuotaCacheEntry`（windows / nextAttemptAt / failures），生产实现是 `fileQuotaCache(directory)`。
- `quota-parse.ts` 只做响应解析：`parseOpenAIQuota` / `parseAnthropicQuota` / `parseGrokQuota` 各自把供应商 JSON 压成 `QuotaWindow[]`。
- `tps.ts` 暴露 `registerTps(pi, update, now?)` 和状态类型 `TpsStatus`，第三个参数是可注入的时钟。
- 颜色分级不在本模块：`quotaColor` / `contextColor` / `cacheColor` / `thinkingColor` 都来自 `theme.ts`。

## 数据怎么流

渲染是拉取式的：宿主每次重画都会调渲染回调，回调当场从会话上下文取目录、分支、会话名、模型、思考等级、上下文占用和最近一条助手消息，再叠上两个采集器缓存在闭包里的额度与速度，拼成两行返回。采集器拿到新数据时不直接画，只请求宿主重画，真正的取数仍发生在下一次渲染里——所以状态栏没有自己的一份显示状态副本。

宽度取舍分两条独立的阶梯。第一行先试完整拼接，放不下就丢掉徽标（整段丢，不截半个），再按预算截会话名，实在不够就只留位置；审查进度是右对齐挂载的，左右之间凑不出两格空隙就整段不显示。第二行按一张候选顺序表逐个试：先砍速度，再砍模型的加速标记，再把额度压成只显示最紧的那个窗口，接着依次砍额度、缓存、上下文的窗口大小；全部候选都放不下才退到「截断的模型名加上下文」，最后只剩上下文。空的额度、缓存、速度段会在拼接时被自然丢弃。

额度这条链更长一些。触发时先判断当前模型的供应商是否属于订阅制——只有 OpenAI Codex、Anthropic、xAI 三家，且后两家必须确实走 OAuth 登录；不满足就清空显示。然后读缓存：还在新鲜期或退避窗口内就直接用缓存里的窗口值，一次网络都不发。真要发请求时先把退避窗口写回缓存占位，防止同进程内并发叠加；请求带三秒超时，成功后写回窗口值并清零失败计数，失败则累加失败次数并按一分钟、两分钟、五分钟三档退避（末档为上限）。手动触发（会话启动、切模型）会先显示加载态，回合结束的自动刷新则安静进行。xAI 的凭据不走 pi 自己的登录态，而是读官方 CLI 在用户主目录留下的登录文件，并检查过期时间。所有响应解析都容错，取不到就当作没有该窗口。

速度统计以一次请求为周期：请求发出记起点，第一段增量到达记生成起点并立刻显示活跃态，之后每 250 毫秒最多更新一次、且要求已累计一秒样本才给数值，期间优先用宿主给的官方输出 token 数，没有才用字符数除以四估算。助手消息结束时改成完成态，耗时按请求起点算（含首字延迟），速率按纯生成区间算，随后清零等下一次请求。切模型和会话结束都会清空。

## 改动指南

改布局阶梯就是改 `render.ts`，它零 IO、零会话依赖，`tests/layout.test.ts` 已经覆盖 `fitStatusLine` / `fitMetadataLine` / `alignRight` 及各 `renderX`；新增一段信息时记得同时补 `StatusLineParts` 的紧凑版本并把它插进 `fitStatusLine` 的候选表，否则窄屏会直接跳过整行降级逻辑。

带背景的场景禁用 pi-tui 的 `TruncatedText` / `truncateToWidth`，本模块一律用 `format.ts` 的 `clip`（省略号带全量重置会掐断外层背景色）；宽度计算必须走 `visibleWidth`，不能用字符串长度——所有段都含 ANSI 与 emoji。

`fitMetadataLine` 的徽标参数（指挥官状态，来自扩展状态表的 `master` 键）是整段取舍：放不下就丢，不参与截断阶梯。新增同类整段元素时沿用这个约定，不要引入第二种半截显示。

`quota.ts` 里的三个 URL 都是供应商自家 CLI 的内部接口，schema 不是公开契约，会无预警变；解析改动应集中在 `quota-parse.ts` 并保持全部字段容错，`tests/quota.test.ts` 用固定响应样本锁住解析结果。改退避策略要同时看 `BACKOFF_MS` 与写缓存的时机：请求前的那次占位写入是防并发叠加的，删掉它会让同一进程重复打接口。缓存文件按 provider 分文件、临时文件加进程号后 rename 覆盖，跨进程共享靠的就是这条；写失败被有意吞掉，因为缓存只是加速手段。

`tps.ts` 的时钟是注入的，`tests/tps.test.ts` 靠它做确定性断言；不要在内部直接调 `performance.now()`。速率与耗时用的是两个不同区间（生成区间 vs 含首字延迟的整段），改动时别把它们合并。
