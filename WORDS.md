# FireCode 术语表

## 委派

- **指挥官**（Master）→ `master/`；避免：主控、Supervisor、Team Lead
- **子代理**（Worker）→ `master/`；避免：工作者、任务、工人
- **子代理池**（Worker Pool）→ `master/runtime.ts`；避免：团队、任务板、任务队列
- **观察员**（Watcher）→ `watcher/`；避免：审查者、子代理、Supervisor
- **工作说明**（Delegation）→ `subagents` 的 `prompt`；避免：任务、工单、Assignment Record
- **子代理结果**（Worker Result）→ `master/event-format.ts`；是证据输入，不代表指挥官已验收；避免：Task Done、Review Passed
- **近况**（Trace）→ `subagents` 的 `tail`；避免：日志、历史、进度
- **工单库**（Tracker）：项目里存放工单的位置，插件不读写；避免：任务队列、任务板
- **工单**（Ticket）：工单库里的一项工作，是指挥官写工作说明的输入；避免：任务、工作说明
- **角色**（Role）→ 配置 `master.roles` 的键；避免：模型别名、预设
- **哨兵角色**（Sentinel Role）：盯守 CI、部署、长测试的低成本角色；避免：轮询票、观察员（后者观察主会话）
- **fallback 链**（Fallback Chain）→ `master.roles.*.fallback`、`master/run.ts`；避免：质量路由、瞬时限流重试、静默降级
- **收割**（Harvest）：调研与盯守子代理取完要点即 kill；避免：清理、归档
- **发落**（Disposition）→ 档案 `disposition`；指挥官对落定类事件的 send / review / kill / ack；避免：确认、处置
- **审查义务**（Review Obligation）→ `review:true`、档案 `reviewNeeded`；避免：自动审查、审查触发器
- **会话进行中** / **歇下**（Session Busy）→ `busy.ts`；指挥官回合结束不等于歇下；避免：完成、空闲
- **待命**（Ack）→ `ack` 动作；避免：挂起、暂停、hold
- **中断**（Interruption）→ 档案 `interruptedAt`；不是执行失败；避免：执行失败、abort
- **自动续跑**（Auto-resume）→ “待续跑”提醒；插件只提醒，续派仍由指挥官发；避免：自动重发、心跳

## 对抗审查

- **fire-review** → `review/`；避免：Master Review Gate、Worker Validator
- **审查者**（Reviewer）→ `review/`；避免：质检员、子代理
- **顾问**（Advisor）→ `review/prompts/advisor.*.md`；避免：仲裁员、第四审查者
- **裁决**（Verdict）：顾问的 continue / narrow / stop；避免：判定、结论
- **审查判定**（Outcome）→ `review/outcome.ts`；避免：裁决（那是顾问的词）
- **修复回合**（Repair）→ checkpoint `repair`；指单个回合，多轮整体叫修复循环；避免：返工
- **总结回合**（Summary Turn）→ checkpoint `summary`；避免：收尾报告、总结卡（卡指结果卡）
- **占用信号**（Occupancy）→ `review/occupancy.ts`；避免：审查状态
- **herdr 投影**（Herdr Projection）→ `session/herdr-projection.ts`；会话在 herdr 里的身份、状态与恢复命令；避免：herdr 集成（那是 herdr 官方的 Pi 扩展，必须卸载）、显示投影

## 终端展示

- **轮**（Turn）→ `tools/group-view.ts`；一次人类输入及其后全部过程；避免：回合（那是模型的一次请求循环）
- **轮记录**（Round Record）→ `tools/round.ts`；不等于整张工单完成；避免：收尾行、处理段统计、总结回合
- **均速**（Rate）→ `busy.ts`；避免：请求均速、生成速度、字符速度
- **过程组**（Process Group）→ `tools/group-view.ts`；避免：工具组（它还含思考）
- **组摘要**（Group Summary）→ `tools/turn-summary.ts`；避免：完整结果、过程列表
- **过程列表**（Process List）：一轮展开后的列表；避免：完整展开、第三档
- **中间回复**（Interim Reply）→ `tools/group-view.ts` 的 `REPLY_LINES`；避免：中途正文
- **活动列表**（Activity List）→ `master/activity-list.ts`；避免：任务面板、状态栏
- **卡住**（Stalled）→ 活动列表的展示信号，不改子代理状态；避免：超时、挂起、失败
- **展示标题**（Display Title）→ `statusbar/`；不等于用户设置的会话名；避免：自动重命名、会话名

## 配置

- **运行配置**（Runtime Configuration）→ Pi Agent 目录下 `extensions/firecode/config.jsonc`；避免：源码配置、默认配置
- **配置模板**（Configuration Template）→ `config.example.jsonc`；避免：运行配置、默认配置
- **模型原子**（Model Atom）→ `config.ts` 的 `parseModelAtom`；避免：模型 ID、模型对、`{ model, thinking }`
- **角色表**（Role Roster）→ `master.roles`；避免：选型表、花名册、模型清单
