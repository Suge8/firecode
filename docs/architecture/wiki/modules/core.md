---
sources:
  - agent/extensions/firecode/index.ts 371b956bc12d firecode REGISTRARS registerHeader registerHerdrDisplay registerReview registerMaster loadConfig
  - agent/extensions/firecode/config.ts 17512757882e loadConfig FEATURES Feature FireCodeConfig LoadedConfig CONFIG_PATH parseJsonc parseReviewConfig parseMasterConfig DEFAULT_KEYS DEFAULT_MASTER_MODELS
  - agent/extensions/firecode/format.ts 668b4e9de4dc oneLine clip formatTokens formatDuration formatModelName
  - agent/extensions/firecode/theme.ts 485324b650f0 ANSI FLAME contextColor cacheColor quotaColor sizeColor thinkingColor
  - agent/extensions/firecode/header.ts 1bd70c504b45 registerHeader
  - agent/extensions/firecode/herdr-client.ts e6cf936c235e herdrPaneEnv herdrRequest
  - agent/extensions/firecode/flame-frames.ts ace06ae44d00 flameFrameLines flameFrameWidth FLAME_FRAME_COUNT
---

# 入口与共享基座

## 职责

这一层负责两件事：把整个定制层装配起来，以及提供所有功能模块共用的底层能力。

装配的规则很简单——读一次配置，按开关逐个启用功能，任何一个功能关掉都不影响其余。配置只有一份文件，读一次后缓存，解析时不静默纠正用户的错误：写错的开关名、写错类型的值、重复占用的快捷键、审查与子代理花名册里的未知字段都会被收集成问题清单，会话启动时以警告形式提示，而不是悄悄回退成默认值再拿默认模型发起真实调用。

共享基座包括四类东西：把任意文本安全塞进单行 UI 的宽度与数值格式化、把数值阈值映射成颜色的品牌配色表、会话开头的火焰横幅、以及一套可任意缩放的火焰动画帧素材。此外还有一个与外部终端复用器通信的最小客户端，供身份投影和审查占用标签共用。它们都是无状态的纯能力，谁需要谁调用，不反向依赖任何功能模块。

## 对外接口

| 文件 | 对外交付 |
| --- | --- |
| `index.ts` | 默认导出 `firecode(pi)`，插件唯一入口 |
| `config.ts` | `loadConfig()`（带缓存，返回 `config` 与 `problems`）、`FEATURES` / `Feature`、`CONFIG_PATH`、`parseJsonc`、`parseReviewConfig` / `parseMasterConfig`（导出供测试）、`DEFAULT_KEYS`、`DEFAULT_MASTER_MODELS` |
| `format.ts` | `oneLine` `clip` `formatTokens` `formatDuration` `formatModelName` |
| `theme.ts` | `ANSI` `FLAME` 与 `contextColor` `cacheColor` `quotaColor` `sizeColor` `thinkingColor` |
| `header.ts` | `registerHeader(pi)` |
| `herdr-client.ts` | `herdrPaneEnv()` `herdrRequest(source, method, params)` |
| `flame-frames.ts` | `flameFrameLines(height, frameIndex)` `flameFrameWidth(height)` `FLAME_FRAME_COUNT` |

`clip` 支持从头或从尾截断（`from: "start"` 保留尾部，用于路径），并接受自定义省略号——`header.ts` 的居中就用空省略号调用它。`herdrRequest` 返回是否送达：非受管环境、连接失败、超时（500ms）和响应带 error 一律为 `false`。

## 数据怎么流

启动时入口先读配置。配置里的功能开关按「省略即开启」解释，于是只有显式写 `false` 才会跳过某个功能；对应的注册函数拿到宿主 API 后各自订阅事件、注册命令和渲染器，彼此之间没有调用关系。

有两处刻意偏离这个规则。终端复用器的身份投影没有开关，它总是被启用，因为它在复用器之外会自我禁用，且只写显示层。对抗审查则不是简单的开或关：无论开关如何，历史结果卡的渲染与检查点收口都必须注册，否则重开会话会看到空白卡、未完成的审查也无人收尾；开关只决定命令和执行循环是否可用。还有一种情况要区分——整节开关写成了非对象，这时所有功能会被安全地全部关闭，但这属于配置坏而不是用户主动关闭，入口会把这个区别告诉审查模块，让它不要把进行中的检查点当成用户放弃而封存。

配置的问题清单不阻断启动。清单非空时，入口挂一个会话启动回调，把每条问题作为警告提示给用户；配置读取本身已缓存，同一进程内多次取用不会重复解析，也不会产生互相打架的第二份事实源。

共享基座是被动的：状态栏、工具行、审查界面、子代理事件卡在渲染时向格式化与配色求值，横幅和工作火焰按当前终端宽高向火焰素材要对应尺寸的帧。配色表把所有阈值到颜色的判断收在一处，遵循「首个满足下限的档位胜出」；缓存命中率的方向与上下文填充相反，这类语义差异也表现在同一张表里，而不是散落在各个渲染点。

## 改动指南

新增一个功能模块时，在 `config.ts` 的 `FEATURES` 数组里加名字，再在 `index.ts` 的 `REGISTRARS` 表里加一行即可；`REGISTRARS` 的类型排除了 `review` 与 `master`，这两个不能塞进表里——`registerReview` 需要额外传入启用标志与「features 整节类型错误」标志，`registerMaster` 单独判断。

配置解析的红线是「不静默回退」。`parseReviewConfig` 与 `parseMasterConfig` 对未知字段（含嵌套对象，走 `rejectUnknownKeys`）一律记录问题；改字段时记得同步 `REVIEW_KEYS` 白名单，漏改会让合法字段被报成未知。开关的类型校验也别去掉：写成字符串 `"false"` 时因为入口用 `!== false` 判断仍会启用，而启用审查意味着真实模型调用。同理，`features` 写成非对象时不能回退成 `{}`，因为 `{}` 在入口语义里正是「全部启用」。

`parseJsonc` 是手写的注释剥离器，不支持尾逗号；配置文件里的注释是唯一用法文档，改配置结构时连注释一起改。

带背景色的卡片里不要用 pi-tui 的 `TruncatedText` / `truncateToWidth`：它们的省略号带全量重置序列，会在截断点掐断外层背景色。单行截断一律走 `clip`，它按字素簇切分并用 `visibleWidth` 计宽，宽字符和 emoji 不会被劈开。

`flame-frames.ts` 的缩放帧只缓存一个高度（`scaledFrameCache` 单槽）。同一时刻两处以不同高度交替取帧会不断重算，代价不高但不是零；真要并存多个尺寸，得先把缓存改成按高度分槽。

`herdrRequest` 的失败是静默的，只以返回值表达送达与否。调用方必须自己决定重试或降级——审查占用标签就是靠定时续约兼作失败重试，因为对端没有「进程退出即清理」的接口。
