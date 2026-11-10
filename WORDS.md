# FireCode 术语表

括号里的英文名同时是英文界面的用词；没有英文名的词在英文界面用普通英文表达。

## 委派

- **指挥官**（Master）→ `master/`；避免：主控、Supervisor、Team Lead
- **子代理**（Worker）→ `master/`；避免：工作者、任务、工人
- **子代理池**（Worker Pool）→ `master/runtime.ts`；避免：团队、任务板、任务队列
- **工作说明**（Delegation）→ `subagents` 的 `prompt`；避免：任务、工单、Assignment Record
- **子代理结果**（Worker Result）→ `master/event-format.ts`；是证据输入，不代表指挥官已验收；避免：Task Done、Review Passed
- **近况**（Trace）→ `subagents` 的 `tail`；避免：日志、历史、进度
- **工单库**（Tracker）：项目里存放工单的位置，插件不读写；避免：任务队列、任务板
- **工单**（Ticket）：工单库里的一项工作，是指挥官写工作说明的输入；避免：任务、工作说明
- **角色**（Role）→ 配置 `master.roles` 的键；避免：模型别名、预设
- **模型链**（Model Chain）：同一角色或审查席位的有序模型候选；避免：模型别名、静默降级
- **收割**（Harvest）：调研与盯守子代理取完要点即 kill；避免：清理、归档
- **审查义务**（Review Obligation）→ `review:true`、档案 `reviewNeeded`；避免：自动审查、审查触发器
- **会话进行中** / **歇下**（Session Busy）→ `busy.ts`；指挥官回合结束不等于歇下；避免：完成、空闲
- **待命**（Ack）→ `ack` 动作；清失败/被中断行并取消续跑提醒，审查义务未履行时拒绝；避免：挂起、暂停、hold
- **中断**（Interruption）→ 档案 `interruptedAt`；对审查中的子代理，interrupt 取消审查（`/fire-review --cancel`）并按中断落定，审查义务保留；不是执行失败；避免：执行失败、abort
- **续跑提醒**（Resume Reminder）→ 档案 `reloadInterrupted`；会话重载打断的回合满时限仍未续派时提醒指挥官，插件不代发“继续”；避免：自动重发、心跳
- **暂停**与**自动续跑**（Pause / Auto-resume）→ 档案 `resume`；瞬时故障（限流、断网）后暂停到恢复时刻，到时在原会话自动续跑，指挥官接手即作废；不是失败；避免：重试、失败

## 对抗审查

- **fire-review** → `review/`；避免：Master Review Gate、Worker Validator
- **审查者**（Reviewer）→ `review/`；避免：质检员、子代理
- **顾问**（Advisor）→ `review/prompts/advisor.*.md`；避免：仲裁员、第四审查者
- **裁决**（Verdict）：顾问的 continue / narrow / stop；避免：判定、结论
- **审查判定**（Outcome）→ `review/outcome.ts`；避免：裁决（那是顾问的词）
- **修复回合**（Repair）→ checkpoint `repair`；指单个回合，多轮整体叫修复循环；避免：返工
- **总结回合**（Summary Turn）→ checkpoint `summary`；避免：收尾报告、总结卡（卡指结果卡）
- **占用信号**（Occupancy）→ `busy.ts`（`OCCUPANCY_CHANNEL`）；避免：审查状态
- **herdr 投影**（Herdr Projection）→ `session/herdr-projection.ts`；会话在 herdr 里的身份、状态与恢复命令；避免：herdr 集成（那是 herdr 官方的 Pi 扩展，必须卸载）、显示投影

## 终端展示

- **轮**（Turn）→ `tools/group-view.ts`；一次人类输入及其后全部过程；避免：回合（那是模型的一次请求循环）
- **轮记录**（Round Record）→ `round.ts`；不等于整张工单完成；避免：收尾行、处理段统计、总结回合
- **均速**（Rate）→ `round.ts`；避免：请求均速、生成速度、字符速度
- **过程组**（Process Group）→ `tools/group-view.ts`；避免：工具组（它还含思考）
- **组摘要**（Group Summary）→ `tools/turn-summary.ts`；避免：完整结果、过程列表
- **过程列表**（Process List）：一轮展开后的列表；避免：完整展开、第三档
- **中间回复**（Interim Reply）→ `tools/group-view.ts` 的 `REPLY_LINES`；避免：中途正文
- **活动列表**（Activity List）→ `master/activity-list.ts`；避免：任务面板、状态栏
- **名册**（Subagent Roster）→ `master/roster.ts`、频道 `firecode:subagents`；给同进程其他扩展读的子代理清单，与角色表无关；避免：角色名册、池快照
- **进展行**（Progress Line）→ `master/progress.ts`；后台模型据新输出写的一句“在做什么”，只给人看（终端与经名册的 CuePad）；避免：摘要、状态播报
- **相位**（Phase）→ `master/phase.ts`；子代理此刻的分组、在做什么与时刻，所有展示与停摆唤醒只读它；不是档案状态（working/idle/reviewing），也不是火苗动画的错位（`flame.ts` 的 `phaseOf`）；避免：行状态
- **卡住**（Stalled）→ 相位的一种展示信号，不改子代理状态；避免：超时、挂起、失败
- **展示标题**（Display Title）→ `statusbar/`；不等于用户设置的会话名；避免：自动重命名、会话名

## 配置

- **运行配置**（Runtime Configuration）→ Pi Agent 目录下 `extensions/firecode/config.jsonc`；避免：源码配置、默认配置
- **配置模板**（Configuration Template）→ `config.example.jsonc`；避免：运行配置、默认配置
- **后台模型**（Background Model）→ 配置 `background.model`；进展行、压缩摘要与闲置压缩共用的便宜模型链，与角色、审查独立；避免：小模型配置、辅助模型、side model
- **闲置压缩**（Idle Compaction）→ `background/idle.ts`；闲置到缓存过期前预算摘要，过期后的下一次请求前应用；避免：保温、续期、定时压缩
- **模型原子**（Model Atom）→ `config.ts` 的 `parseModelAtom`；避免：模型 ID、模型对、`{ model, thinking }`
- **角色表**（Role Roster）→ 配置 `master.roles`，会话开始核对出的可用部分（只定提示词里的角色表）在 `master/roles.ts`；避免：选型表、花名册、模型清单
