# review：`/fire-review` 对抗性审查

多模型并行审、顾问仲裁、checkpoint、结果卡、审查进度发布。零外部依赖：schema 校验是手写纯函数（不引 typebox）。

## 状态与生命周期

`state.ts` 是唯一状态事实源（纯 reducer，零 IO），循环状态只经 reduce() 迁移，副作用全在 `index.ts` 执行器。命令入口的 START 一律先排队，开审只经 ADVANCE 在 idle 门里发生，没有“直接开审”的第二条路径；用户取消是 `notify_cancelled` 通知效果，不是卡。

运行时状态按会话隔离：pi 在同一进程内对同一 cwd 复用扩展模块实例，主会话与每个 Worker 子会话跑的是同一份
`index.ts`，所以 controller 与 dispatch 队列都挂在 `registerReview(pi)` 各自持有的 ReviewRuntime 上，模块级不留会话
状态。多个 Worker 可同时各审各的；一个会话的 session_shutdown 收口后清空自己的 controller，宿主随后 dispose
作废 ctx，迟到回调看到空 controller 直接返回（曾因全局单例握着被 kill 的 Worker 的死 ctx，看门狗到点连环抛错杀掉整个 pi 进程）。
`registerReview` 返回的 `settled()` 只供测试排空该会话的迁移队列。

reload/new/resume/fork 保留可恢复状态，quit 才落终态；子会话被 `master/spawn.ts` 的池释放时同样先收到 quit 再 dispose。checkpoint 的键白名单由领域类型 `satisfies` 派生：
字段增删不同步会编译失败，这是校验漂移（曾导致终态写不进去、重启后恢复出幽灵审查）的唯一防线；枚举取值（相、轮结果、顾问裁决等）在 `state.ts` 里是常量数组，类型、checkpoint 校验与顾问解析都读它，不另抄一份。

`session_start` 只恢复 checkpoint，宿主在所有异步 session_start handler 完成后发出的 `resources_discover`
才允许推进；`agent_settled` 由 review 判断能否开审。`agent_start` 另作竞态兜底：若审查仍在跑，先 abort
并等待全部审查会话释放（dispose，bash 子进程随 abort 同步被杀），执行模型才进入 turn_start。审查者的中断
不等 pi 的 `session.abort()` 返回：模型流卡在半开连接上时它永不返回（Bun fetch 在网络切换后不保证响应
AbortSignal，pi 的 agent loop 也没有 abort 竞争），等它会把 kill 与会话关闭一起拖死；卡死的审查者会话在
进程里惰性留到 TCP 层放弃。

`awaiting_fix` 把修复生命周期 `pending → awaiting_start → running → completed` 写进 checkpoint；reload
会重投未确认完成的反馈，只有 completed 才进入下一审查轮。宿主 `sendMessage` 返回 void，因此反馈用
`agent_start` 确认启动、最终 `agent_end` 确认未以 error/aborted 结束，不靠同步 try/catch 猜异步结果。

质量裁决终态（通过 / 顾问叫停 / maxRounds 用尽）先经 `summarizing` 相：结果卡照发，再投递带反循环
禁令的总结提示（followUp + triggerTurn，agent_start 回执、agent_end 收尾），总结回合结束才落 `settled`；
总结生命周期持久化，reload 重投未确认总结，失败静默收尾不升级；事故终态（取消/超时/基础设施错误/quit）
不烧总结回合。修复反馈、总结提示与状态卡 content 统一经 `deliver.ts` 的 `wrapEnvelope` 包在 `<firecode_review>` 中，折叠界面据此把它们归入过程；details 保持原始卡片数据。
占用标签持有到总结完成，Master 的审查等待自然捕获总结作为最终回复。

已知暴露：修复反馈与总结提示的 followUp 唤起仍走宿主侧门（跳过 before_agent_start，#33 上游缺陷），修复回合内扩展注入的段会被撤下再补回；因 display:false 的隐形投递无前门等价物，接受此暴露待上游修复，不在插件侧绕行。

`outcome.ts` 是外部读取审查进度与终态判定的唯一入口，checkpoint 格式仍归 review 所有：订阅方用 `outcomeOfEntry` /
`reviewProgressOf` 从刚追加的记录增量解析，`readReviewOutcome` 只在需要整份文件时（回合结束兜底）用。事故终态的 `reason` 取该轮
`details` 原文（超时、供应商报错都写在里面），枚举名只作缺失兜底：读取方不得把枚举名当原因展示。
命令入口拒绝启动（配置问题、已有审查在跑、参数错误）统一经 `checkpoint.ts` 的 `recordRefusal` 写一条拒绝记录（不动 checkpoint，不碰进行中的审查），有 UI 时另行通知；无 UI 的 Worker 里这条记录是原因唯一的出口，`outcome.ts` 把它读成 `refused`（`runId` 是这次拒绝的 id，`message` 是原文），Master 原样报给指挥官。新增拒绝分支必须走同一个 `refuse`。

## 卡片与审查进度

结果卡渲染器始终注册（即使 feature 关闭），使用 pi 原生背景卡与完整 Markdown：通过为绿底，未通过、
终止与异常为红底，其余为紫底；标题前是单色字形，字形与语义色按卡种类在 `card.ts` 的 `MARKS` 一处定义（构建时写进
details.icon，渲染时按种类上色；details 校验接受的卡种类也由它派生），不用 emoji 与品牌火焰；排队相不发卡，开始卡只发第 1 轮，后续轮边界由结果卡轮号承担。reload 与
live 外观一致，渲染器永不抛异常（details 校验失败降级 content 纯文本）。每轮 findings 只完整显示一次；
达到顾问阈值时先显示失败卡，若顾问裁定 stop，终止卡只显示顾问裁决，不再复制同一份 findings。

顾问卡与审查结果卡同构：裁决进标题（顾问指引 · 继续修复），正文首行为粗体模型分节，三段正文标题加粗且
段间补空行（Markdown 把单换行折进同段，不补会糊成一块）。

主会话审查进度不由本模块绘制：执行器经占用频道发布 `ReviewProgress`（只有审查相的票数可数），
由输入框外壳显示。进度只读 reducer 的当前状态，不另派生逐审查者工具进度或摘要，也不为它设计时器。`ui.ts` 的 `ReviewUi`（每场审查一个实例，各自记着要还原的标题与编辑器）只管编辑器接管与终端标题（“审查中 R轮次 · 会话名”）。Working 指示的可见性归 statusbar 管，本模块不写。

`ui.ts` 等待模型时接管编辑器：禁止输入，esc/Ctrl+C 随时取消审查（顾问阶段 esc 跳过咨询），`awaiting_fix` 与
`summarizing` 相把输入交还用户。接管时保存 `getEditorComponent()` 的当前工厂，解锁还原它（可能是别的扩展设置的自定义编辑器，
不是宿主默认）；锁定期间输入区收起成一行暗色“审查进行中 · esc 取消”（快捷键文案取自 keybindings），上下边框取自被包住的编辑器。按键必须经 keybindings/终端转义序列匹配，不能只比裸 `\x1b`。
无 TUI 的会话照常运行完整审查循环，不访问 UI；取消由会话退出或总体 watchdog 负责，结果卡仍写入会话记录。

审查会话的最终回复取会话事件中完整的 assistant 消息。

给审查者的会话证据有篇幅预算：单条消息超过 3000 字只给前 3000 字，命令轨迹超过 200 字截短，总结材料超过 4000 字截短；
每个截断处都写明是证据截断、原文多少字，消息与命令轨迹的截断还给出会话文件路径，审查提示说明这些标记不是回复没写完、需要时读文件核对
（裸“[…]”曾让审查者把完整的长交付物连判三轮未完成）。

## 文案与契约字段名

用户可见文案、拼给模型的提示正文与校验报错都在 `messages.ts`；审查/顾问的政策提示词在 `prompts/*.{zh,en}.md`。
`messages.ts` 的 `terms` 是审查输出契约与结果卡字段名（发现、严重程度、证据、卡点、原因、用时、模型……）的唯一来源：卡片与汇总取当前语言，
解析端（`reviewer.ts` 校验审查者输出、`state.ts` 回顾已收口问题、`tools/machine.ts` 取审查卡预览）经 `termPattern` 两种语言都认。
取舍：只认当前语言更省，但会话历史会跨语言（切换 `language` 后恢复旧会话，旧卡片与滚动开放清单里仍是原语言），模型也可能不照提示词语言写字段名，
只认当前语言会让整票作废为格式错误、旧卡片预览退化成第一句正文。代价是多一种语言的字段名要随契约同步，仅此一处。
发现字段名只认当前提示词的两种语言写法，不留旧措辞别名：契约改字时同步改 `terms` 与提示词，已落盘的旧措辞发现按格式无效处理。

## 占用信号

审查活跃期只有一个出口：进程内 `firecode:review` 频道（定义见根 `busy.ts`，读者一律经 `watchBusy`），review 是唯一发布者，不接触 herdr。
`busy.ts` 把它算进“会话进行中”，herdr 投影据此报 working 并带“对抗审查进行中”标签（不报 blocked：审查期间不需要用户决定任何事，
blocked 会触发需要关注的通知）；终态、取消、退出时发布 `active:false`，reload 恢复时重新持有。订阅方故障不影响审查。

## 契约与配置

审查政策与 PASS/FAIL 输出契约以 `prompts/review.{zh,en}.md` 为唯一事实源，经 spawn 整体替换系统提示；需求、
关注点、往轮结果和完整会话记录留在 user prompt，记录中的需求照常生效，但不能反向改写审查职责、工具边界与
输出契约。审查会话使用 memory 持久化，关闭自动扩展、Skill、
模板和上下文注入；项目约定由审查者按 system policy 主动读取适用的 AGENTS.md。每条 FAIL 发现必须六要素齐全（标题、严重程度、问题、违反的约定与期望、证据、验证命令，标签
加粗；校验容忍非粗体），同票混入非法发现整票作废为缺席票。有裁决就成轮：一轮里只要有一票 PASS/FAIL，就按有裁决的票形成结论，缺席者（会话故障、超时、输出契约违例）在结论里点名而不阻断；全员缺席才是基础设施不可用。往轮发现清单随轮注入顾问裁决
（`prompt.ts`），审查者不得原样重提已仲裁事项——僵尸发现的收敛闭环。

审查者的只读是契约而非能力边界：排除 write/edit 只挡住这两个工具，保留的 `bash` 仍能在项目目录执行任意
命令。保留 bash 是有意的——审查者要跑测试取证；真需要物理隔离得上容器或只读挂载。

config.jsonc 的 `review` 节必须显式完整配置（字段见 `config.ts`）；公开包不内置依赖个人认证或偏好的模型。
该节有任何配置问题时，`/fire-review` 与 checkpoint 恢复都拒绝启动；活动 checkpoint 保持原样，修好配置并重启后继续恢复。
不读 pi-flow 的 config.json。
