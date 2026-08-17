---
sources:
  - agent/extensions/firecode/tools/index.ts ab23e4cc43df registerToolRendering executeTimed rangeSuffix lineCount
  - agent/extensions/firecode/tools/grouping.ts 2afb3a443a91 installGroupPatch uninstallGroupPatch renderFallbackToolRow FIRECODE_TOOLS patchToolRows indexJoinedRows followsToolRow
  - agent/extensions/firecode/tools/line.ts cd6bca3c9b27 ToolLine makeResultRenderer RowState RenderContext
  - agent/extensions/firecode/tools/parts.ts 67d1c047aa15 Part paint clipParts pathValue commandParts sizePart durationPart diffMeta genericArgsParts
  - agent/extensions/firecode/tools/timing.ts 01f73aa80080 executeTimed takeDuration clearDurations
---

# 工具行渲染

## 职责

把默认四个工具（读取、操作、修改、写入）在聊天记录里的展示压成一行：左边是状态点和中文标签，中间是这次干了什么（路径或命令），右边贴耗时和结果体积。宽度不够时按语义方向截断——路径丢开头保文件名，命令丢结尾保命令词；再窄就先扔掉右侧那两列，最后只剩状态点和标签。整行带底色，运行中、成功、失败三种底色区分状态。

连续的工具调用被合并成一条视觉轨道：每条行本来自带一个前导空行做间隔，紧跟在另一条工具行后面的行会把这个空行去掉，一串调用就连成一片而不是被空行切碎。

除了自己接管的四个工具，这里还兜住所有第三方工具：没被认领的工具行会被换成同样格式的通用单行，避免别的扩展按默认宽卡片渲染破坏轨道的整齐。展开某一行时回到完整输出，不做压缩。

只接管默认激活的四个工具是刻意的：宿主注册工具即等于激活，给检索类工具挂渲染包装会把它们在所有会话强行打开，渲染层不允许改变工具集。

## 对外接口

`tools/index.ts` 的 `registerToolRendering(pi)` 是唯一入口：它重新注册 read/bash/edit/write 四个工具（复用宿主原始实现，只换 label、`renderShell: "self"` 和渲染函数），在 `session_start` 装轨道 patch、`session_shutdown` 卸载，并提供 `/tool-status` 命令打印当前已加载与已启用的工具名。

`tools/line.ts` 导出可复用的渲染件：`ToolLine` 是行组件本体，`makeResultRenderer(sized)` 生成结果渲染器，`RowState` 与 `RenderContext` 是 renderCall 与 renderResult 之间共享的行状态与上下文类型。Master 模块直接用 `ToolLine` 画自己的工具行，不经 `tools/index.ts`。

`tools/parts.ts` 是着色片段层：`Part` 是带颜色的文本片段，`paint` 上色、`clipParts` 按方向截断，`pathValue`/`commandParts` 构造路径与命令主体，`sizePart`/`durationPart` 构造右侧列，`diffMeta` 从 diff 文本数出增删行，`genericArgsParts` 为未知工具挑一个有代表性的参数展示。

`tools/timing.ts` 是耗时旁路：`executeTimed` 包住执行、`takeDuration` 按调用 id 取走一次、`clearDurations` 清空。

`tools/grouping.ts` 对外只暴露 `installGroupPatch(ui, decorated)` / `uninstallGroupPatch()` 一对生命周期函数，外加 `renderFallbackToolRow` 通用兜底行与 `FIRECODE_TOOLS`（走宿主原生渲染的工具名集合）。

## 数据怎么流

一次工具调用有两个信息源，在同一行上汇合。调用参数在发起时就能画：路径被折成 `./` 或 `~` 前缀、目录暗色文件名亮色，读取还会把偏移和行数折成 `:12-40` 这样的尾缀；命令被压成一行、命令词高亮、管道重定向和环境变量赋值压暗。结果要等执行完：结果字符数和真实执行耗时回填到行状态，右侧列才出现；修改工具额外从结果里数出增删行数贴在路径后面，写入工具则直接从待写内容数行数。失败时整行转红，并在主体后面挤一段错误摘要——此时主体被压到可用宽度的四成左右，把位置让给错误原因。

耗时不能在渲染时测，因为渲染只看得到结果。所以执行被包了一层计时，按调用 id 存进一张表，渲染侧取一次即删除，长会话不会堆积；会话开始和结束都会清空这张表。

轨道合并要知道"上一条也是工具行"，这信息只在宿主的组件树里。做法是借一次 widget 生命周期拿到 TUI 实例，然后在它的重绘入口挂钩：每次重绘先尝试找到聊天容器、从里面任取一条工具行、patch 它的原型渲染方法。patch 后的渲染先判断这个工具该走原生渲染还是通用兜底行，再判断自己是否紧跟另一条工具行，是就砍掉首行空行。相邻关系是增量算的——聊天记录只增不改，所以从上次算到的位置续算，结果存在弱引用集合里。patch 状态挂在全局符号上，扩展热重载重新执行模块后仍能正确卸载；卸载时逐个校验当前函数确实是自己装的那个才还原。

## 改动指南

`tools/grouping.ts` 是全仓与宿主耦合最紧的一处：它依赖 pi 内部组件树的形状（`children` 数组、工具行同时具备 `toolName`/`render`/`setExpanded`）和原型 patch。升级 pi 时优先跑这里的验证。patch 失败只会 notify 一次警告并继续走原始渲染，不会崩会话，所以故障表现是"轨道回到空行分隔"而不是报错——排查连行问题先看有没有那条警告。

改工具集合要动 `FIRECODE_TOOLS`：不在集合里的工具会被通用兜底行覆盖，自带中文行渲染的工具（如 subagents）必须列进去，否则自渲染会被兜底行遮掉。反过来，**不要**给 grep/find/ls 加渲染包装——宿主注册即激活，包装等于强制在所有会话打开这三个工具。

带背景的行禁用 pi-tui 的截断工具：其省略号带全量重置序列，会在截断点掐断外层背景色。单行截断一律走 `format.ts` 的 `clip`，`clipParts` 内部也是基于它。

右侧列是可牺牲的：主体宽度低于下限时会从右往左弹出耗时和体积列，改这里的阈值要连带确认窄终端下不会出现主体只剩一个字符的情况。

耗时表按调用 id 取一次即删，若新增读取点必须自己缓存，第二次取会拿到 undefined。

测试在 `tests/tools.test.ts`，经 `tests/loader.ts` 复制插件目录并改写 pi 依赖后运行时加载；它覆盖的是紧凑行渲染与"只合并相邻工具行"这一条核心行为。
