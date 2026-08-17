---
sources:
  - agent/extensions/firecode/index.ts 371b956bc12d REGISTRARS registerHerdrDisplay registerReview loadConfig session_start
  - agent/extensions/firecode/config.ts 17512757882e loadConfig parseJsonc parseReviewConfig parseMasterConfig FEATURES DEFAULT_KEYS CONFIG_PATH problems cached rejectUnknownKeys
  - agent/extensions/firecode/header.ts 1bd70c504b45 registerHeader FULL TINY FULL_WIDTH setHeader
  - agent/extensions/firecode/format.ts 668b4e9de4dc clip oneLine formatTokens formatDuration formatModelName Segmenter
  - agent/extensions/firecode/theme.ts 485324b650f0 FLAME ANSI pick contextColor cacheColor quotaColor sizeColor thinkingColor Threshold
  - agent/extensions/firecode/flame-frames.ts ace06ae44d00 FLAME_FRAME_COUNT flameFrameLines flameFrameWidth scaledFrameCache scaleFrame
  - agent/extensions/firecode/herdr-client.ts e6cf936c235e herdrPaneEnv herdrRequest HERDR_ENV REQUEST_TIMEOUT_MS hasResult
---

# 入口与共享基座

覆盖 FireCode 的装配层与被各功能模块共用的无状态基座：入口 `index.ts`、配置事实源 `config.ts`、启动横幅 `header.ts`，以及共享件 `format.ts`、`theme.ts`、`flame-frames.ts`、`herdr-client.ts`。总体分层见 [../system.md](../system.md)。

## 职责

入口 `index.ts` 替调用者（pi 宿主）封装一件事：**功能开关到注册函数的映射**。它读一次配置、按 `config.features` 逐个调 `registerX(pi)`，不持有任何跨模块状态，也不给模块之间牵线——每个 register 封闭自己的运行状态，关掉任何一个不影响其余。开关语义是「默认全开、显式 false 才关」（判定写成 `!== false`）。配置问题不阻断装配：入口在 `session_start` 把 `problems` 逐条 `ctx.ui.notify` 成 warning，是否因此拒绝启动由各功能自己决定（review/master 会拒绝，见下文数据流）。

`config.ts` 是唯一配置事实源：只读插件目录下的 `config.jsonc`（`CONFIG_PATH` 由 `import.meta.url` 推出），不读项目级配置、不读 pi-flow 的 config.json，零外部依赖。它明确不管的：不抛异常中断调用方（校验产出 `{ config, problems }`，调用方拿到可用默认值同时看到全部问题）、不支持运行期热更（`loadConfig()` 进程内 `cached` 一次，改配置需重启）。校验姿态是**类型错误必须记录、不得静默回退**：开关写成字符串 `"false"` 会因 `!== false` 静默启用付费审查，`review`/`master` 节写错类型时静默当空对象会拿用户没配的模型真实发起调用，因此这两节还经 `rejectUnknownKeys` 对未知字段（含嵌套）做键白名单。

`header.ts` 只做启动横幅：模块加载时把火焰 ASCII 与 wordmark 按行上色拼成 `FULL`（宽度存 `FULL_WIDTH`），渲染时只选「宽度够用 `FULL`，否则一行 `TINY`」再居中，`session_start` 后无状态。

四个共享件都是纯函数或无状态客户端，不 import 任何 FireCode 功能模块，因此不构成模块间耦合：`format.ts` 管宽度/文本/数值格式化，`theme.ts` 集中**所有阈值到颜色的映射**与品牌火焰渐变常量，`flame-frames.ts` 是可缩放到任意高度的火焰帧素材，`herdr-client.ts` 是 herdr socket 单请求单连接客户端（herdr 之外直接返回未送达，从不抛异常）。

## 对外接口

`index.ts` 只暴露默认导出 `firecode(pi)`，宿主加载插件时调一次；`REGISTRARS` 表不导出，键类型是 `Exclude<Feature, "review" | "master">`。

`config.ts` 的关键导出：

- `loadConfig(): { config, problems }`——被 index、presets、rename、review、master、openai-native 共用的唯一读取入口，状态全在模块级 `cached`（一个变量，进程内单次解析）。
- `parseReviewConfig` / `parseMasterConfig`——导出即为让测试直接打「未知字段、类型错误必须报 problems」这条契约（`tests/review-contract.test.ts`、`tests/master-state.test.ts` 在用）。
- `FEATURES` / `Feature`——开关名单一事实源；`DEFAULT_MASTER_MODELS`——master 配置不可用时 `master/index.ts` 用它兜底渲染选型表提示词；`DEFAULT_KEYS`——三个内置快捷键兜底；`CONFIG_PATH`——openai-native 的 `ctrl+f` 写回配置时定位文件。
- `parseJsonc`——手写注释剥离（字符串内斜杠不动，不支持尾逗号），避免为一个文件引依赖。

`format.ts` 只暴露五个纯函数：`clip`（按显示宽度截断、`Intl.Segmenter` 保字素簇，`from` 决定保头部命令还是尾部路径 basename；带背景卡片里是 pi-tui 截断的唯一替代，见 AGENTS.md 禁令）、`oneLine`（压平换行塞单行）、`formatTokens`、`formatDuration`、`formatModelName`（剥 provider 前缀与日期后缀，状态栏、herdr 身份投影、审查进度共用同一种模型名写法）。

`theme.ts` 暴露 `ANSI`/`FLAME` 常量与五个取色函数：`contextColor`、`cacheColor`（两者方向相反：填充越高越红、命中越高越绿，故分列两张表）、`quotaColor`、`sizeColor`、`thinkingColor`。内部 `pick` 按降序阈值表取首个 `value >= at` 档位，表用 `satisfies readonly Threshold[]` 约束颜色必须是宿主 `ThemeColor`。

`flame-frames.ts` 暴露 `FLAME_FRAME_COUNT`、`flameFrameLines(height, frameIndex)`（最近邻缩放到任意高度）、`flameFrameWidth(height)`（缩放后可见宽度）、`flameFrameCacheSize`（测试用）。

`herdr-client.ts` 只暴露 `herdrPaneEnv()`（校验 `HERDR_ENV=1` 与 pane/socket 环境变量）和 `herdrRequest(source, method, params): Promise<boolean>`——只在 herdr 回了不带 `error` 的对象型 `result` 时才算送达（`hasResult`），超时 500ms、连接错误、`end` 一律 `false`。

## 数据怎么流

配置从 `config.jsonc` 单点进入：`loadConfig` 解析并缓存，`problems` 随返回值流向两条路——入口把全部问题 notify 给用户；`review/index.ts` 与 `master/index.ts` 各自按前缀（`review`/`master`/`未知字段 …`/`config.jsonc`/`features`）过滤，命中即拒绝启动而非降级（静默回退默认模型会花真钱跑错模型）。

装配决策从 `firecode(pi)` 流出，三处例外直接写在入口：`registerHerdrDisplay` 无条件注册（无 feature 开关，靠自身在 herdr 之外自我禁用，见 [session.md](session.md)）；`registerMaster` 单独判定（不在 `REGISTRARS` 键类型里，见 [master.md](master.md)）；`registerReview` 额外接收「features 整节是否类型错误」——`features` 非对象时 config 把所有开关安全回退成 `false`，那是「配置坏」而非「用户关闭」，review 据此不封存活跃 checkpoint，且历史结果卡渲染与 checkpoint 收口始终注册、开关只控制命令与执行循环（见 [review.md](review.md)）。

共享件的消费方向全是单向流出：`format.ts` 流向状态栏、工具行、review 进度/卡片/UI 与 header（[statusbar.md](statusbar.md)、[tools.md](tools.md)、[review.md](review.md)）；`theme.ts` 流向状态栏（context/cache/quota/thinking）、工具行（`sizeColor`）与 header（`FLAME`/`ANSI`）；`flame-frames.ts` 流向 review 活动框与 working 火焰 widget（[review.md](review.md)、[session.md](session.md)）；`herdrRequest` 的布尔送达结果是上层重试与租约续约的判据——herdr 身份投影只把确认送达记为已发布，review 占用标签靠它做 TTL 续约兼投递重试。

## 改动指南

- 增删功能开关：同时改 `config.ts` 的 `FEATURES` 与 `index.ts` 的 `REGISTRARS`——两者由 `Exclude<Feature, "review" | "master">` 键类型编译期对齐，漏配会编译失败，这是有意的防漂移，不要绕。
- 改 `features` 回退语义前先看入口注释：非对象回退成全关是「安全回退」，但 review 依赖「配置坏 ≠ 用户关闭」的区分（`problems.includes("features 必须是对象")` 作为第二参传入），改回退值会连带改变 checkpoint 封存行为。
- 改 review/master 节校验：先看 `parseReviewConfig`/`parseMasterConfig` 与两侧的前缀过滤（`review/index.ts` 的 `loadReviewConfig`、`master/index.ts` 的 `loadMasterModels`）——problems 消息前缀就是门禁匹配键，改消息文案可能让门禁漏判；契约测试在 `tests/review-contract.test.ts`、`tests/master-state.test.ts`。
- 改 `flame-frames.ts` 缩放：`scaleFrame` 裁行尾空白格是为了让实际渲染宽度与 `flameFrameWidth`（按 `trimEnd` 计宽）一致，去掉裁剪会让窄屏适配按小宽度放行、渲染却溢出；缓存 `scaledFrameCache` 只留最近一个高度，多高度轮换会整批重算。
- 改 `herdrRequest` 前守住送达语义：`true` 必须意味着 herdr 真收到并回了 `result`，上层（身份投影去重、占用标签续约）都拿它当「已发布」判据，放宽会造成静默丢投递。Windows 端点是命名管道改写，别按 Unix socket 假设。
- 带背景卡片里截断文本一律用 `format.ts` 的 `clip`，禁用 pi-tui `TruncatedText`/`truncateToWidth`（省略号带 `\x1b[0m` 全量重置，会掐断外层背景色）。
