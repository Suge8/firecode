---
sources:
  - agent/extensions/firecode/session/presets.ts 1a9628dd591d registerPresets applyPreset clearPreset preset-state before_agent_start
  - agent/extensions/firecode/session/rename.ts d03ae87c4332 registerSessionName cleanTitle MAX_TITLE_CHARS
  - agent/extensions/firecode/session/stats.ts 253b5c7b8885 registerStats usageAttribution parseDays collect
  - agent/extensions/firecode/session/bark.ts e76b3adf5dd4 registerBark buildBarkPayload hasBlockedWorker MAX_BODY_LENGTH
  - agent/extensions/firecode/session/herdr-display.ts 227d461fb9f9 registerHerdrDisplay projectIdentity publish session_info_changed
  - agent/extensions/firecode/session/working-flame.ts 672d8466be37 registerWorkingFlame flameHeightFor flameFitHeight WorkingFlame
  - agent/extensions/firecode/herdr-client.ts e6cf936c235e herdrPaneEnv herdrRequest
  - agent/extensions/firecode/master/state.ts e51063b2f460 loadMasterState masterStatePath WorkerStatus
---

# 会话功能

## 职责

`session/` 是六个彼此独立的会话级 feature，每个只导出一个 `registerX(pi)`，运行状态封闭在闭包里，互不引用。
它们由 `index.ts` 按 `config.features` 逐个注册（见 [核心装配](core.md)），关掉任何一个不影响其余。
对外只有三条接缝：bark 只读 `master/state.ts`、herdr-display 只用 `herdr-client.ts`、working-flame 只用
`flame-frames.ts` 的帧素材。

- **presets.ts**：一键切换模型、思考等级、工具集与附加指令，预设定义在 config.jsonc 的 `presets` 节。
- **rename.ts**：把 `/rename <name>` 与 `config.keys.rename` 收敛到 `pi.setSessionName`，只改 pi 会话名。
- **stats.ts**：`/tokens` 扫描会话 jsonl 按模型汇总 token 与成本；零本地 import，与其余 feature 完全解耦。
- **bark.ts**：任务彻底落定时推 iPhone Bark 通知；有待拍板子代理时升 timeSensitive。
- **herdr-display.ts**：会话身份单向投影到 herdr agent 副标题，只写带 `source` 的显示元数据，不碰 pane/tab 持久名。
- **working-flame.ts**：工作回合内编辑器上方居中的多行火焰 widget，审查占用期退让。

## 对外接口

各 feature 的注册入口与可独立测试的关键纯函数：

| feature | 注册入口 | 关键纯函数 / 常量 |
| --- | --- | --- |
| presets.ts | `registerPresets` | `applyPreset`、`clearPreset`（闭包内，经命令/快捷键触达） |
| rename.ts | `registerSessionName` | `cleanTitle`：控制字符转空格、零宽与双向控制字符删除、空白折叠、按字素切到 `MAX_TITLE_CHARS`（160） |
| stats.ts | `registerStats` | `usageAttribution`（归因规则唯一出处）、`parseDays`（接受 `7`、`--days 7`、`0` 全部，默认 30） |
| bark.ts | `registerBark` | `buildBarkPayload`（标题/正文/折叠 id/等级的唯一组装点）、`hasBlockedWorker`（只读旁路判定） |
| herdr-display.ts | `registerHerdrDisplay` | `projectIdentity`：产出 `pi·模型/思考等级`（thinking 为 `off` 时省略等级）与会话名 |
| working-flame.ts | `registerWorkingFlame` | `flameHeightFor`（终端行数四分之一钳在 3–10 行）、`flameFitHeight`（宽度不足逐级降高，装不下返回 0 即隐藏） |

presets 的用户入口有四类：`--preset` 启动标志、`/preset [名字]` 命令、每个预设自带的 `key` 快捷键、
`keys.cyclePreset` 在「无预设 + 各预设」之间轮切；选择器是 `ctx.ui.custom` 里的 `SelectList`，末尾固定追加清除项。
`usageAttribution` 与 pi 自身的 usage-totals 对齐：assistant 消息归 `provider/model` 并计一次请求，
toolResult 与 compaction / branch_summary 归 `tools/summaries` 且不计请求数。

## 数据怎么流

**presets：config 进 → 宿主状态出 → 会话记录持久化。** `session_start` 从 `loadConfig()` 取 `presets` 节
（配置问题由 index.ts 统一提示）；`applyPreset` 在**首次**应用前把当前模型、思考等级与激活工具集快照进
`originalState`（按会话可用等级存，会话侧等级集合比预设可配置的多），`clearPreset` 用它恢复默认。
附加指令不落宿主状态，而是在 `before_agent_start` 追加到 systemPrompt 末尾，每回合重新拼接。
`turn_start` 把 `preset-state` 追加进会话记录，重开会话只取最后一条恢复名字与附加指令，
**不重放** `setModel` / `setActiveTools`——用户当前选的模型优先。模型找不到、无 API key、工具名未知都只发
warning 并继续应用其余字段。

**stats：会话 jsonl 进 → Markdown 出。** `collect` 递归扫描 agent 目录下 `sessions/` 的全部 `.jsonl` 逐行解析，
读文件、读目录、解析行三处失败都按跳过处理——会话文件可能在扫描过程中被轮转；时间过滤用消息内 timestamp、
缺失时回落条目 timestamp。TUI 下用宿主 `Markdown` 组件渲染在 `DynamicBorder` 卡里，非 TUI 直接 console 打印。

**bark：会话事件 + Master 状态文件进 → HTTP 推送出。** `message_end` 记住最后一条 assistant 文本；
`agent_settled` 且 `ctx.isIdle()` 为真（不再自动续跑）时组包发送。标题优先会话名、回落 cwd 目录名，
正文经 markdown 剥离后截到 `MAX_BODY_LENGTH`（200），`id` 固定取会话 id——同会话新通知靠 APNs CollapseID
顶掉旧的。等级判定是与 [Master](master.md) 的唯一接缝：`hasBlockedWorker` 经 `masterStatePath(sessionId)` 用
`loadMasterState` 读状态文件，有 `WorkerStatus` 为 `blocked` 的子代理即升 `timeSensitive` 并加「待拍板」副标题。
推送地址取 `~/.pi/agent/bark-key`，缺失静默停用；网络失败吞掉。

**herdr-display：宿主事件进 → herdr-client 出。** 监听 `session_start`、`session_info_changed`
（宿主已把 `/rename`、快捷键与自动命名收口到这一个事件，所以改名投影不从 rename.ts 接线）、
`model_select`、`thinking_level_select`；投递经 `herdrRequest` 调 `pane.report_metadata`，同时写
`display_agent`、`title` 和自定义 token `session`——herdr 侧边栏行布局只能消费自定义 token，`title` 不在
token 集里。只有 `session_shutdown` 且 reason 为 `quit` 才清空，其余切换由新 `session_start` 覆盖；
seq 单调递增，herdr 据此丢弃过期上报。

**working-flame：宿主事件 + 占用频道进 → TUI widget 出。** `agent_start` 挂载、`agent_end` 撤下
`aboveEditor` 槽位的 `WorkingFlame` 组件（100ms 定时器驱动帧，随 dispose 清理），帧素材来自
`flame-frames.ts` 的 `flameFrameLines` / `flameFrameWidth`，与 [审查](review.md) 活动框共用同一套。
订阅 `herdr:blocked` 频道（review 模块发布）拿 `reviewHeld`，只有 `turnActive && !reviewHeld` 才挂 widget，
宿主 Working 文本行在两者都不成立时才复显。模块只是频道消费方，不反向依赖 review 状态。

## 改动指南

**改哪个 feature 就只看它自己 + 一跳 import**：presets/rename 看 `config.ts`，bark 看 `master/state.ts`，
herdr-display 看 `herdr-client.ts`，working-flame 看 `flame-frames.ts` 与 review 的占用频道发布端
（`review/index.ts` 的 `herdr:blocked`）。测试对应 `tests/{presets,rename,stats,bark,herdr-display,working-flame}.test.ts`。

常见坑：

- **占用退让的 queueMicrotask 仲裁**（working-flame.ts）：review 也写 `setWorkingVisible`，且它的写入在同一
  同步调度链里排在占用事件之后；本模块所有 UI 写入必须经 `queueMicrotask` 合并、在调度链收尾后作为最终仲裁者
  落地，否则复发「占用期 `agent_end` 无条件复显 Working 行」的最后写者竞态。widget 槽位必须是 `aboveEditor`：
  多行帧塞进单行 spinner 通道是旧 working-style.ts 的真实事故。
- **投影的串行链与去重键**（herdr-display.ts）：`publish` 把请求串进一条 Promise 链避免乱序覆盖；去重键取
  「链尾意图」而非已确认身份，否则 A→B→A 快速切回会把过时的 B 留在 pane 上。只有 `herdrRequest` 返回送达
  才记为已发布，失败清空链尾意图由下一事件重试。自禁用条件三个都要保：`herdrPaneEnv()` 为空、
  `FIRECODE_MASTER_WORKER`、`ctx.mode !== "tui"`——无头调用不能接管可见会话的显示。
- **bark 加密时 id 必须在密文外**（bark.ts）：AES-256-GCM 时折叠头（CollapseID）由服务端写，它读不到密文内的
  id，所以 `id` 提到顶层明文（只是本地会话 uuid，无内容敏感性）；level/subtitle 等内容字段由设备端解密应用，
  留在密文内。`hasBlockedWorker` 是只读旁路：读失败一律按无待拍板降级，状态文件的完整性与恢复归 Master，
  通知不放大故障。
- **presets 的恢复语义是刻意收窄的**：重开会话只恢复名字与附加指令，不重放模型和工具切换；改这里前先确认
  没有把「恢复」扩成「重放」。
