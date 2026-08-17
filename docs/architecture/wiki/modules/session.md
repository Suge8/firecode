---
sources:
  - agent/extensions/firecode/session/presets.ts 1a9628dd591d registerPresets
  - agent/extensions/firecode/session/rename.ts d03ae87c4332 registerSessionName
  - agent/extensions/firecode/session/stats.ts 253b5c7b8885 registerStats usageAttribution parseDays
  - agent/extensions/firecode/session/bark.ts e76b3adf5dd4 registerBark buildBarkPayload hasBlockedWorker
  - agent/extensions/firecode/session/herdr-display.ts 227d461fb9f9 registerHerdrDisplay projectIdentity
  - agent/extensions/firecode/session/working-flame.ts 672d8466be37 registerWorkingFlame flameHeightFor flameFitHeight
---

# session：会话功能

## 职责

围绕「一次 pi 会话」本身提供六件互不依赖的小功能：一键切换工作档位（模型、思考等级、可用工具、附加指令），给会话改名，统计历史会话的 token 用量与花费，任务落定后把结论推到手机通知栏，把当前会话的身份显示到外部终端复用器的侧边栏，以及在模型工作期间用一团燃烧的火焰代替宿主默认的等待提示。

这六件事共用的只有「会话」这个语境，彼此没有调用关系：关掉任何一件，其余照常工作。它们统一属于旁路增强——推送失败、外部显示失败、统计文件读不动都不会打断正在进行的对话，失败一律静默或降级。

对外的两处只读依赖：手机通知需要知道有没有子代理正等着拍板，因此读一眼子代理池的持久化状态；火焰需要在对抗审查活跃期让位给审查活动条，因此监听审查发出的占用信号。两处都是单向读取，不回写。

## 对外接口

每个文件导出一个 `registerX(pi)`，由 `index.ts` 按 `config.features` 逐个装配。

| 文件 | 导出 | 用户入口 |
| --- | --- | --- |
| `session/presets.ts` | `registerPresets` | `--preset <名>`、`/preset [名]`、每个预设自己的快捷键、`keys.cyclePreset` 轮切 |
| `session/rename.ts` | `registerSessionName` | `/rename <新名字>`、`keys.rename` 弹输入框 |
| `session/stats.ts` | `registerStats`、`usageAttribution`、`parseDays` | `/tokens [天数]`，`0` 表示全部历史，默认 30 天 |
| `session/bark.ts` | `registerBark`、`buildBarkPayload`、`hasBlockedWorker` | 无命令；靠 `~/.pi/agent/bark-key` 是否存在启停 |
| `session/herdr-display.ts` | `registerHerdrDisplay`、`projectIdentity` | 无命令；herdr 内自动生效 |
| `session/working-flame.ts` | `registerWorkingFlame`、`flameHeightFor`、`flameFitHeight` | 无命令；工作回合内自动出现 |

纯函数是测试的抓手，也是可被复用的部分：`usageAttribution` 决定一条会话记录算到哪个模型头上，`parseDays` 解析 `/tokens` 参数，`buildBarkPayload` 组装推送体，`hasBlockedWorker` 做只读旁路判定，`projectIdentity` 拼身份字符串，`flameHeightFor` / `flameFitHeight` 算火焰高度。对应测试为 `tests/presets.test.ts`、`tests/rename.test.ts`、`tests/stats.test.ts`、`tests/bark.test.ts`、`tests/herdr-display.test.ts`、`tests/working-flame.test.ts`。

配置只来自 `firecode/config.jsonc`：预设定义在 `presets` 节，两个快捷键在 `keys` 节（`session/presets.ts`、`session/rename.ts` 各自 `loadConfig()`）。

## 数据怎么流

**预设**在会话启动时读配置拿到预设表。带命令行参数时立即套用；否则只从会话记录里捞回上次用的预设名，恢复名字与附加指令，不重放模型和工具切换——历史里的模型此刻可能已不可用，重放会在启动阶段抛出用户没要求的副作用。首次套用前会给当时的模型、思考等级和工具集拍一张快照，"清除预设"就是把快照放回去。附加指令不写进配置文件里的系统提示，而是在每次请求组装系统提示时追加到末尾。每个回合开始时把当前预设名写进会话记录，这就是下次恢复的来源。未知的模型或工具只警告不阻断，能套用多少套多少。

**改名**把用户输入清洗后（去控制字符与不可见字符、压缩空白、限长）交给宿主，只改会话名，不碰任何外部持久名称。

**统计**递归扫会话目录下所有 jsonl，逐行判定归属：助手消息算到"提供方/模型"并计一次请求，工具结果与压缩记录统一归到一个"工具与摘要"的伪模型且不计请求数，其余行忽略。时间过滤按记录自带的时间戳，没有时间戳的记录不会被排除掉。单个文件读失败或单行解析失败都跳过继续，最后汇总成 Markdown 表格；有界面时弹卡片，无界面时直接打印。

**通知**在每轮消息里记住最后一段助手正文，等到本轮彻底落定且宿主确认已进入空闲才推送。标题优先用会话名，没有才退到工作目录名——直接在家目录跑时目录名恰好是用户名，不适合当标题。同一会话固定用会话 id 作通知 id，新通知会顶掉旧的，通知栏每会话只留一条。此时读一眼子代理池状态，若有子代理处于阻塞待答状态，就加"待拍板"副标题并升级为时效性通知以穿透专注模式。配置了端到端加密时整包加密，但通知 id 必须留在明文顶层——折叠是服务端写的推送头，它读不到密文里的字段。子代理进程内不发通知，通知只归指挥官会话。

**身份投影**是单向的：会话启动、宿主上报会话信息变化（改名、快捷键、自动命名都已在宿主收口）、选模型、选思考等级四类事件各触发一次同步，把「pi·模型/思考等级」写成外部 agent 副标题，会话名同时写标题和一个自定义 token 供侧边栏行布局引用。请求串行排队避免乱序覆盖，去重以队尾意图为准而非已确认身份——否则 A→B→A 快速切回会把过期的 B 永久留在界面上。只有确认收到成功回执才记为已发布，失败静默并由下一个事件重试。只有真正退出才清空显示；重载、切会话等由新会话的启动事件覆盖。非交互模式和子代理进程内不投影。

**火焰**在工作回合开始时挂到编辑器上方的独立多行槽位，回合结束撤下，动画计时器随组件销毁清理。火焰出现即等待信号，因此同时隐藏宿主的文字版等待提示。审查活跃时审查活动条自带火焰，本模块整体退让避免两团火同烧。所有界面写入都推迟到微任务合并后一次落地，从而排在审查模块的同步写入之后当最终仲裁者——否则审查占用期一个回合结束事件就会无条件把文字提示复显出来。高度按终端行数取约四分之一、钳在 3 到 10 行之间；宽度装不下就逐级降高，实在放不下才整体隐藏。

## 改动指南

预设的恢复语义是刻意的：`session_start` 只回填 `activeName` / `activePreset`，不调 `setModel` / `setActiveTools`。想改成"完全恢复"前先想清楚模型已下线、工具已改名时的失败路径。快照 `OriginalState` 的思考等级类型取自 `pi.getThinkingLevel()` 而非配置里的 `Preset["thinkingLevel"]`——会话侧的等级集合比预设可配的多（含 `max`），用窄类型存会丢档位。

`session/stats.ts` 的归属规则必须与 pi 自己的 usage-totals 保持一致，改 `usageAttribution` 前先对齐宿主口径，否则 `/tokens` 会和宿主状态栏对不上账。它扫的是磁盘上全部历史会话，不是当前会话。

`session/bark.ts` 对 `master/state.ts` 是只读旁路：`hasBlockedWorker` 吞掉任何异常并按"无待拍板"降级，状态文件的损坏与恢复归 Master 报告，通知不放大故障。加密分支里 `id` 提到密文外是硬要求，挪回密文内折叠就失效。`registerBark` 开头对 `FIRECODE_MASTER_WORKER` 的早退不能删——子代理进程也会加载本插件。

`session/herdr-display.ts` 只写带 `source` 的显示元数据（`display_agent` / `title` / 自定义 token）。不要在这里改 workspace、pane label 或 tab label：那些是持久共享名称，herdr 没有条件 rename 与 CAS 接口，"先查再改"消不掉 split/move 竞态。上报的 `seq` 必须单调递增，herdr 靠它丢弃过期上报。改名事件只订阅宿主的 `session_info_changed`，不要从 `session/rename.ts` 直接接线。

`session/working-flame.ts` 必须走 `setWidget` 的 `aboveEditor` 槽位。把多行帧塞进单行 spinner 通道是已经发生过的事故，会与工具输出互相踩踏。`sync()` 的微任务合并同样不能改成同步调用——它保证本模块在同一调度链里最后落地，是"审查占用期不复显文字提示"的唯一保证。素材本身来自 `flame-frames.ts`，自带 ANSI 颜色与行尾复位，渲染时只加左侧缩进即可居中，不要再套截断或着色。
