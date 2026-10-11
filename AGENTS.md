# FireCode

pi 扩展：启动横幅、输入框外壳（状态嵌进边框）、工具行渲染、预设、Claude 订阅适配、`/fire-review` 对抗性审查、默认激活的 `/fire-master` 多 Agent 指挥官与 `/fire-watch` 观察员。

单一入口 `index.ts` 按 `config.features` 逐个调 `registerX(pi)`。功能开关只管可关的部分；轮记录器、截断写入拦截、日期段、herdr 投影、审查卡渲染始终注册。每个可关的 register 封闭自己的运行状态，关掉任何一个不影响其余。子会话（Worker、观察员）只注册与界面无关的部分：横幅、工具渲染、预设、用量命令与输入框外壳只属于交互主会话。模块之间谁依赖谁看 import；下面只记 import 看不出的约定：

- 进程内事件频道各有唯一定义处与唯一发布者，读者不自己订阅：在飞子代理数与审查占用在 `busy.ts`（读者经 `watchBusy`、`busyView`），轮记录写入通知在 `round.ts`，子代理名册 `firecode:subagents`（给同进程其他扩展的对外接口）在 `master/roster.ts`；契约都在各自头注释。
- Master 读审查结果只经 `review/outcome.ts`；输入框外壳的落定态与摘要行读同一份轮记录、同一条合成规则（`round.ts`）。

## 模块

| 路径 | 职责 | 细则 |
| --- | --- | --- |
| `header.ts` | 会话启动横幅 | |
| `statusbar/` | 输入框外壳：状态嵌进编辑器上下边框，无独立底栏；也接宿主改名键改会话名 | [statusbar/AGENTS.md](statusbar/AGENTS.md) |
| `tools/` | 经宿主 `registerToolRenderer` 只接管 read/bash/edit/write/grep/find/ls 的渲染（不重新注册工具）；思考与工具的过程组/过程列表、轮记录的宿主适配 | [tools/AGENTS.md](tools/AGENTS.md) |
| `session/` | 预设、用量查询、herdr 投影（pane 唯一的 agent 状态上报者） | [session/AGENTS.md](session/AGENTS.md) |
| `review/` | `/fire-review` 对抗性审查：多模型并行审、顾问仲裁、checkpoint、结果卡、审查进度发布 | [review/AGENTS.md](review/AGENTS.md) |
| `master/` | `/fire-master`：进程内 Worker 池、七命令与独立查询、当前动作投影、steer 投递与审查义务 | [master/AGENTS.md](master/AGENTS.md) |
| `watcher/` | `/fire-watch` 观察员：turn 增量评估与单通道发言 | [watcher/AGENTS.md](watcher/AGENTS.md) |
| `provider/claude-sub.ts` | Claude 订阅适配：只在订阅凭据下注册，请求补 Claude Code 归因，令牌换发造成的 401 自愈一次 | |
| `provider/openai-native/` | 请求层：OpenAI verbosity、OpenAI/xAI Fast（service_tier=priority）、可选原生压缩（走宿主公开流，见「硬约束」） | |
| `round.ts` | 轮记录：测量、格式、合成规则与写记录的记录器（宿主渲染适配在 `tools/round.ts`） | |
| `truncated-write.ts` | 拦截带 read 截断提示的 write（把半截文件写回） | |
| `today.ts` | 系统提示的日期段 | |
| `evals/delegation/` | 委派条款评测开发工具，花真钱、不进 `bun test`；改指挥官委派条款时用 | [README](evals/delegation/README.md) |
| `site/` | 官网 firecode.si：独立的 Astro 静态站（自带依赖），推送 main 由 Vercel 部署，只在 `site/`、`design/`、两份 README、`config.example.jsonc`、`jsonc.ts` 变化时构建（判定在 `site/vercel.json`）；品牌素材引用根下 `design/`；改 README 的标语或两张表前先读 | [site/AGENTS.md](site/AGENTS.md) |
| `deliver.ts` | 信封格式与统一投递入口（Master 事件、观察员发言、review 的修复反馈与总结提示共用） | |
| `busy.ts` | “会话进行中”与“歇下”边沿的唯一判定，及它的两个输入频道 | |
| `status-keys.ts` | 宿主扩展状态（`setStatus`）的键，发布方与输入框外壳共用 | |
| `process-shared.ts` | 跨模块拷贝共享的进程唯一状态 | |
| `spawn.ts` | 全插件唯一的进程内子会话入口：进程里只有一个池，根 `index.ts` 建一次，Master、Review、Watcher 共用；非隔离子会话注册主会话已加载的这份 FireCode，宿主从磁盘另读的那份不注册，同一进程里只跑一个版本 | |
| `format.ts` | 共享的宽度/文本格式化 | |
| `flame.ts` | 全局动画时钟、火苗、落定标记与火焰色板；横幅、tools、statusbar 共用 | |
| `jsonc.ts` | JSONC 解析与 `isRecord`（配置与 provider 共用的唯一对象判定） | |
| `config.ts` | 从 Pi Agent 目录解析唯一运行配置（含 `openai` 节校验），并给出 review/master/watcher 每节能否启动的判定 | |
| `config-file.ts` | 运行配置的路径、首次播种、原始读取；不含文案（被 `i18n.ts` 依赖） | |
| `i18n.ts` `*/messages.ts` | 双语文案机制与各目录文案表，见下「文案」 | |

改 `review/` 或 `master/` 前先读对应细则页：两者的状态机、持久化与投递契约都有事故换来的硬约束。术语与命名见 `WORDS.md`。

## 硬约束

带背景的卡片里禁用 pi-tui `TruncatedText`/`truncateToWidth`：其省略号带 `\x1b[0m` 全量重置，会在截断点掐断外层背景色（[earendil-works/pi#4894](https://github.com/earendil-works/pi/issues/4894) 已报，被拒修）；单行截断一律用 `format.ts` 的 `clip`。

投递统一经根级 `deliver.ts`（机制见其头注释），没有例外。以 `triggerTurn: true` 唤起歇透会话会跳过 `before_agent_start`，该回合第一次工具调用后扩展注入的段被撤下，下一次前门回合再补回，所以唤醒一律走前门 `sendUserMessage`（[#33](https://github.com/Suge8/firecode/issues/33)）。这是宿主缺陷，上游 [pi#8712](https://github.com/earendil-works/pi/issues/8712) 被自动关闭未处理，同一缺陷的 [pi#5581](https://github.com/earendil-works/pi/issues/5581) 仍开着。纯展示记录（轮记录）使用官方 CustomEntry，不走模型消息投递。

系统提示注入一律写进 `before_agent_start` 的 `systemPromptOptions.sections`，不返回 `systemPrompt`：返回值会让宿主整段替换系统提示并丢掉段更新，任何一段变化（日期、技能表、MCP 摘要）都会重写整个已缓存前缀。

OpenAI 原生压缩经宿主的 `@earendil-works/pi-ai/compat` 入口（`streamSimple`）走宿主流，不自带 Responses 序列化。升级 pi 时核对这个入口还在；宿主删掉它时，迁到宿主当时对扩展公开的等价接口（`provider/openai-native/src/host-stream.ts` 是唯一使用处）。

宿主私有细节只在 `tools/host.ts`；改过程分组或升级 pi 时先读 `tools/AGENTS.md`，核对原生展开与鼠标命中契约。

## 文案

界面与给模型看的文字支持中英。所有用户/模型可见文案必须经文案表，新增文案中英同时提供；代码注释保持中文。语言由 `config.jsonc` 顶层 `language` 决定（省略则跟随系统 locale：`LC_ALL`/`LC_MESSAGES`/`LANG`，再退到运行时默认 locale，zh 开头为中文，其余英文），模块加载时定下，改语言重启生效，调用处不传语言。

- 每个目录一个 `messages.ts`：`export const msg = defineMessages({ zh: {...}, en: {...} })`，用 `msg.分组.键`；带参数的文案写成函数。en 与 zh 的键、嵌套、函数参数不一致是类型错误。
- 提示词按语言分文件 `<name>.zh.md` / `<name>.en.md`，用 `i18n.ts` 的 `readPrompt(new URL("./prompts/", import.meta.url), name)` 读；英文版是等价翻译，改一边必须同步另一边。
- 生产端与解析端共用的词汇只有一份：信封分节词与耗时词汇在根 `messages.ts` 的 `envelope`（信封格式归 `deliver.ts`；生产端与折叠界面 `tools/machine.ts` 都读它，解析端只读当前语言），审查输出契约与结果卡的字段名在 `review/messages.ts` 的 `terms`（解析端两种语言都认，理由见 [review/AGENTS.md](review/AGENTS.md)）。
- 不进文案表的：代码标识符、协议字段名、模型原子等配置值、`active: … / all: …` 这类纯技术输出。
- 测试把 `LC_ALL` 固定为 zh（`tests/loader.ts`），断言默认中文；英文行为在 `tests/i18n.test.ts` 用 `language: "en"` 的配置验证。

## 配置

唯一运行配置是 Pi Agent 目录（由官方 `getAgentDir()` 解析，含 `PI_CODING_AGENT_DIR` 覆写）下的
`extensions/firecode/config.jsonc`；用户侧安装见 README。文件不存在时，主会话在扩展加载时（`registerFirecode`，先于 `loadConfig`）把随包模板 `config.example.jsonc` 原样写过去（`config-file.ts` 的 `seedConfig`，构建把模板复制进 `dist` 以便打包后定位），本次会话即按新文件生效；不区分 TUI/print/rpc，提示“已生成配置…重启生效”留到有 UI 的 `session_start` 显示一次。已存在的文件（含内容有问题）绝不覆盖，子会话不写盘，写入失败明确报错。改完本机运行配置后，把其中属于推荐配置的部分同步进 `config.example.jsonc`，个人化内容（自定义 instructions、私人扩展名）留在本机。模板首次启动时原样写给所有用户，所以注释、角色名与角色 `use` 一律英文；角色名只由配置决定，代码与提示词不点名。官网的演示模型也取自模板（`site/AGENTS.md`）。

顶层 `language` 是唯一语言设置，不再有 `review.language`（旧写法按未知字段报错）。

配置里凡是指定模型的位置都写同一个模型原子 `"provider/model/thinking"`，解析在 `config.ts` 的 `parseModelAtom`
一处收口；旧的分字段与两段式写法一律报配置问题。

不要新建 keys.json，也不要读项目级配置。快捷键启动时绑定，改完需重启。加速档开关键（`keys.fast`）只替换文件里顶层的 `openai` 键（关闭写 `false`），其它注释保留；注释里出现的 `"openai": {` 不会被误改。
快捷键冲突：宿主对扩展用 `registerShortcut` 注册的键，与*全部*内置键位（含只在会话列表等选择器里生效的）逐键比对，不分上下文，
撞上任何一个都在启动时弹 “Extension issues”；撞到编辑器全局保留键则扩展直接被跳过，其余则扩展先于内置处理。
所以默认键必须避开宿主全部默认键位（`tests/config-seam.test.ts` 守），改名这类宿主已有键位的动作不注册快捷键，
而是挂宿主的编辑器动作（见 `statusbar/index.ts` 的 `ShellEditor`）。
`review`、`master` 与 `watcher` 节有问题时对应功能拒绝启动而不是回退默认——静默回退会拿用户没配的模型
真实发起调用。能否启动只由 `loadConfig()` 给出的每节判定决定（文件级与 features 问题阻断三节），消费端不再自己筛
问题；关闭的功能那一节的问题不进 session_start 全局警告。

## 文档

README 中英两份的标语（`<h3>` 紧跟简介 `<p>`）与“审查对比”“核心极轻”两张表是官网构建的解析契约，格式见 `site/AGENTS.md`。核心极轻的字符数按 README 表下写的口径重测，改了工具定义或默认角色后中英两份一起更新。

## 测试

```bash
bun test
bun run typecheck
```

`tests/loader.ts` 从 `PATH` 中的开发版 `pi` 或 `PI_PACKAGES_DIR` 定位 pi-mono，把当前仓库复制到临时目录并改写宿主包导入，供需要运行时值的用例使用（机制见其头注释）；`typecheck` 用同一个定位结果（见 `scripts/typecheck.ts` 头注释）。搭建步骤与 pi 版本见 [CONTRIBUTING](.github/CONTRIBUTING.md) 与 `.github/workflows/ci.yml`。`pi-smoke` 用例启动真实 `pi` 并按 package.json 加载 `dist/`，先 `bun run build`。
