---
sources:
  - agent/extensions/firecode/tools/index.ts ab23e4cc43df registerToolRendering renderShell executeTimed makeResultRenderer registerCommand
  - agent/extensions/firecode/tools/grouping.ts 2afb3a443a91 installGroupPatch uninstallGroupPatch patchToolRows FIRECODE_TOOLS renderFallbackToolRow followsToolRow GROUP_PATCH REQUEST_RENDER_PATCH
  - agent/extensions/firecode/tools/line.ts cd6bca3c9b27 ToolLine RowState makeResultRenderer ExpandedResult
  - agent/extensions/firecode/tools/parts.ts 67d1c047aa15 Part pathValue commandParts diffMeta genericArgsParts clipParts
  - agent/extensions/firecode/tools/timing.ts 01f73aa80080 executeTimed takeDuration clearDurations
---

# 工具行渲染

## 职责

把 pi 默认 4 工具（read/bash/edit/write）的展示收敛成单行：状态字形 + 中文标签 + 主体 +
右侧耗时/大小列，连续的工具行再合并成一条无空行的轨道；未知第三方工具收口为通用单行兜底。
渲染接管不改变工具集——`tools/index.ts` 的文件头说明了为什么不包装 grep/find/ls：
原版 pi 注册即激活，包装它们等于在所有会话强制打开这三个工具。

`tools/index.ts` 是唯一注册入口：对四个工具各调一次 `pi.registerTool`，以 `renderShell: "self"`
接管外壳，用 `LABEL` 把工具名换成「读取/操作/修改/写入」，原生 `createReadTool` 等实例按 cwd
缓存复用；同文件还注册了 `tool-status` 命令用于查看已加载与已启用工具。

## 对外接口

`line.ts` 与 `parts.ts` 是纯渲染，不依赖注册流程，构成被 [Master](./master.md) 复用的接缝：
`master/index.ts` 直接 import `ToolLine`、`makeResultRenderer` 和 `Part` 画自己的 `subagents` 工具行。

- `ToolLine`（`line.ts`）：单行组件，输入标签、`Part[]` 主体、截断方向、meta 后缀与
  `RenderContext`，输出一行带背景色的成品。`RowState` 是 renderCall / renderResult 之间共享的
  行状态（字符数、耗时、±diff 后缀、错误摘要）。
- `makeResultRenderer(sized)`（`line.ts`）：折叠时只回写 `RowState`，展开时才产出
  `ExpandedResult` 的完整输出；`sized` 决定是否统计结果字符数驱动大小列。
- `Part` 及其原语（`parts.ts`）：`pathValue` 路径按 cwd/家目录缩写、目录暗 basename 亮；
  `commandParts` 命令分层着色；`diffMeta` 从 diff 文本算 ±N；`genericArgsParts` 给兜底行挑
  最能代表意图的参数；`clipParts` 的方向参数决定路径保尾、命令保头。大小与耗时列有噪音阈值
  （小于 100 字符、快于 1 秒不占列）。
- `FIRECODE_TOOLS`（`grouping.ts`）：走 pi 原生渲染（会消费工具自带 renderCall）的白名单，
  含本模块 4 工具 + grep/find/ls + `subagents`。这是一条契约：自带渲染的工具必须登记，
  否则会被通用兜底行盖掉。

宽度与文本处理下沉在共享的 `format.ts`，配色阈值在 `theme.ts`，与
[状态栏](./statusbar.md)共用同一套品牌色。

## 数据怎么流

工具调用进入渲染管线走 pi 的 renderCall/renderResult 双钩子：renderCall 用参数构造 `ToolLine`
（read 附 offset/limit 转成的 `:12-40` 区间后缀，write 附 `+N` 行数），renderResult 经
`makeResultRenderer` 把结果折算进 `RowState`，下一帧 `ToolLine` 再把这些状态画到右侧列。
edit 的 `renderResult` 额外从结果 `details.diff` 派生 `±N` 写进 `state.meta`。

耗时从执行侧流到渲染侧靠 `timing.ts` 的一张 `Map`：`index.ts` 把每个工具的 `execute` 包进
`executeTimed` 写入真实耗时，渲染侧按 `toolCallId` 用 `takeDuration` 取走即删，
会话起止再 `clearDurations` 兜底，避免长会话堆积。

grouping patch 的介入点在每帧渲染前：`installGroupPatch` 包装 tui 的 `requestRender`，
每次触发先尝试 `patchToolRows`——因为工具行组件要等聊天区里真的出现一行才能拿到它的原型。
替换后的行 `render` 做两件事：白名单内或已展开的行走原生渲染，其余走 `renderFallbackToolRow`；
随后若本行紧跟另一条工具行（`followsToolRow` 经增量索引判定，聊天记录只增不改所以从上次
长度续算，结果存 WeakSet），就砍掉首个空行形成连续轨道。

## 改动指南

改行内布局先看 `line.ts`（宽度分配：右侧列不够 `MIN_VALUE_WIDTH` 就逐个 pop，错误时主体
压到四成给摘要让位），改着色与片段先看 `parts.ts`，改注册与各工具的 renderCall 差异看
`index.ts`，改轨道合并与兜底看 `grouping.ts`。行为回归由 `tests/tools.test.ts` 保护：
紧凑状态行的渲染结果，以及只有相邻工具行才合并轨道。

常见坑：

- 原型 patch 的宿主耦合：`grouping.ts` 是与宿主耦合最紧的一处。它借一次 `ui.setWidget`
  生命周期拿 tui 实例（拿到即注销 widget），`findChatContainer` 在组件树里深度优先找
  「children 中含工具行」的容器，靠鸭子类型识别行对象（同时具备 `render`、`setExpanded`、
  `toolName`），再 `Object.getPrototypeOf` 替换其 `render`。组件树形状、`children` 数组、
  行字段名、`render` 签名都是 pi 内部实现，升级宿主时优先检查这里。patch 失败不中断渲染，
  只在首次异常 `ui.notify` 一次警告。
- globalThis 状态与热重载：patch 状态挂在 `globalThis` 上（`Symbol.for` 打标记幂等安装卸载），
  因为扩展热重载会重新执行模块，状态留在模块作用域就卸载不掉旧 patch；
  `uninstallGroupPatch` 只在当前函数仍是自己装的那一份时才还原。
- 白名单漏登记：新工具若自带渲染却不在 `FIRECODE_TOOLS`，会被兜底行遮掉——`subagents`
  在名单里就是这个原因。

模块整体的注册位置与 feature 开关见[总览](../system.md)。
