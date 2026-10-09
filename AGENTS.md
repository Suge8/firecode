# FireCode

pi 的个人定制层：启动横幅、输入框外壳（状态嵌进边框）、工具行渲染、预设、Claude 订阅适配、`/fire-review`
对抗性审查、默认激活的 `/fire-master` 多 Agent 主控与 `/fire-watch` 观察员。

单一入口 `index.ts` 只做一件事：按 `config.features` 逐个调 `registerX(pi)`。每个 register 封闭自己的运行
状态，关掉任何一个不影响其余；跨模块接缝只有十条：`tools/machine.ts` 的审查卡预览读 `review/messages.ts` 的字段名（与生产端同源，两种语言都认），Master 只读调 `review/outcome.ts`，Master 复用 `tools/line.ts` 纯渲染组件画自己的工具行，Review 与 Watcher 经
`master/spawn.ts` 起子会话，Watcher 订阅 review 发布的占用频道判静默，statusbar 订阅同一占用频道显示审查进度（频道名与 payload 只在 `review/occupancy.ts` 定义），轮记录器、statusbar、tools 与 herdr 投影（`session/herdr-projection.ts`）经 `busy.ts` 的 `watchBusy` 读 Master 发布的在飞子代理数并消费同一个“会话歇下”边沿，Master 与 Watcher 的卡片复用 `tools/machine.ts` 的信封一行投影（信封格式由根级 `deliver.ts` 拥有），statusbar 的落定态经 `tools/round.ts` 的 `latestTurnRecord` 读轮记录（与摘要行同一合成规则），Master 的“本次运行”耗时与子代理视图经 `roundFromEntry` 读子代理会话里的轮记录。

## 模块

| 路径 | 职责 | 细则 |
| --- | --- | --- |
| `header.ts` | 会话启动横幅 | |
| `statusbar/` | 输入框外壳：状态嵌进编辑器上下边框，无独立底栏；也接宿主改名键改会话名 | [statusbar/AGENTS.md](statusbar/AGENTS.md) |
| `tools/` | 思考与工具的过程组/过程列表、轮记录（整段耗时与终态的持久化事后记录）、默认四工具渲染与单工具正文 | [tools/AGENTS.md](tools/AGENTS.md) |
| `session/` | 预设、用量查询、herdr 投影（身份、working/idle 状态、恢复命令；pane 唯一的 agent 状态上报者） | [session/AGENTS.md](session/AGENTS.md) |
| `review/` | `/fire-review` 对抗性审查：多模型并行审、顾问仲裁、checkpoint、结果卡、审查进度发布 | [review/AGENTS.md](review/AGENTS.md) |
| `master/` | `/fire-master`：进程内 Worker 池、七命令与独立查询、当前动作投影、steer 投递与审查义务 | [master/AGENTS.md](master/AGENTS.md) |
| `watcher/` | `/fire-watch` 观察员：turn 增量评估与单通道发言 | [watcher/AGENTS.md](watcher/AGENTS.md) |
| `provider/claude-sub.ts` | Claude 订阅适配：请求补 Claude Code 归因，令牌换发造成的 401 自愈一次 | |
| `provider/openai-native/` | 请求层：OpenAI verbosity、OpenAI/xAI Fast（service_tier=priority）、可选原生压缩 | |
| `round-recorder.ts` | 轮记录器：歇下时写轮记录；不属于任何可关的功能，主会话与每个子代理会话都注册 | |
| `truncated-write.ts` | 拦截带 read 截断提示的 write（把半截文件写回）；同样每个会话都注册 | |
| `evals/delegation/` | 委派条款评测开发工具，花真钱、不进 `bun test`；改指挥官委派条款时用 | [README](evals/delegation/README.md) |
| `site/` | 官网 firecode.si：独立的 Astro 静态站（自带依赖，`cd site && bun run build`），推送 main 由 Vercel 自动部署，只在 `site/`、`design/` 或 README 变化时构建；品牌素材直接引用根下 `design/`，给 Agent 的 Markdown 与 `llms.txt` 构建时从 README 生成 | |
| `deliver.ts` | 信封格式与统一投递入口（Master 事件、观察员发言共用） | |
| `busy.ts` | “会话进行中”与“歇下”边沿的唯一判定，及相关频道 | |
| `herdr-client.ts` | herdr socket 短连接客户端，只有 herdr 投影使用 | |
| `activity.ts` | 子代理活动列表的单行布局，只有 `master/activity-list.ts` 使用 | |
| `format.ts` `theme.ts` | 共享的宽度/文本格式化与品牌配色、阈值分级 | |
| `flame.ts` | 全局动画时钟、火苗、落定标记与火焰色板；横幅、tools、statusbar 共用 | |
| `jsonc.ts` | JSONC 解析与 `isRecord`（配置、openai 节读写、provider 共用的唯一对象判定） | |
| `config.ts` | 从 Pi Agent 目录解析唯一运行配置，并给出 review/master/watcher 每节能否启动的判定 | |
| `config-file.ts` | 运行配置的路径、首次播种、原始读取；不含文案（被 `i18n.ts` 依赖） | |
| `i18n.ts` `*/messages.ts` | 双语文案机制与各目录文案表，见下「文案」 | |

改 `review/` 或 `master/` 前先读对应细则页：两者的状态机、持久化与投递契约都有事故换来的硬约束。术语与命名见 `WORDS.md`。

## 硬约束

带背景的卡片里禁用 pi-tui `TruncatedText`/`truncateToWidth`：其省略号带 `\x1b[0m` 全量重置，会在截断点掐断
外层背景色（上游 #4894 已报被拒修）；单行截断一律用 `format.ts` 的 `clip`。

投递统一经根级 `deliver.ts`（机制见其头注释；唯一例外：review 的修复反馈与总结提示走 followUp 侧门，见 review/AGENTS.md 已知暴露）。两条红线是事故换来的：回合进行中以 `triggerTurn: false` 立即追加会造成快照与状态分叉、提示词缓存整段重写（#28）；以 `triggerTurn: true` 唤起歇透会话会跳过 `before_agent_start`，系统提示注入随回合抖动同样整段重写（#33，宿主缺陷，已报上游）。纯展示记录（轮记录）使用官方 CustomEntry，不走模型消息投递。

宿主私有细节只在 `tools/host.ts`；改过程分组或升级 pi 时先读 `tools/AGENTS.md`，核对原生展开与鼠标命中契约。

## 文案

界面与给模型看的文字支持中英。所有用户/模型可见文案必须经文案表，新增文案中英同时提供；代码注释保持中文。语言由 `config.jsonc` 顶层 `language` 决定（省略则跟随系统 locale：`LC_ALL`/`LC_MESSAGES`/`LANG`，再退到运行时默认 locale，zh 开头为中文，其余英文），模块加载时定下，改语言重启生效，调用处不传语言。

- 每个目录一个 `messages.ts`：`export const msg = defineMessages({ zh: {...}, en: {...} })`，用 `msg.分组.键`；带参数的文案写成函数。en 与 zh 的键、嵌套、函数参数不一致是类型错误。根目录的 `messages.ts` 另放机器消息（信封）里生产端与折叠界面共用的词汇（`envelope`），两侧必须读它，不各写一份。
- 提示词按语言分文件 `<name>.zh.md` / `<name>.en.md`，用 `i18n.ts` 的 `readPrompt(new URL("./prompts/", import.meta.url), name)` 读；英文版是等价翻译，改一边必须同步另一边。
- 生产端与解析端共用的词汇只有一份：信封分节词在根 `messages.ts` 的 `envelope`（解析端只读当前语言），审查输出契约与结果卡的字段名在 `review/messages.ts` 的 `terms`（解析端两种语言都认，理由见 [review/AGENTS.md](review/AGENTS.md)）。
- 不进文案表的：代码标识符、协议字段名、模型原子等配置值、`active: … / all: …` 这类纯技术输出、上游子包 `provider/openai-native/src` 里已是英文的诊断。
- 测试把 `LC_ALL` 固定为 zh（`tests/loader.ts`），断言默认中文；英文行为在 `tests/i18n.test.ts` 用 `language: "en"` 的配置验证。

## 配置

唯一运行配置是 Pi Agent 目录（由官方 `getAgentDir()` 解析，含 `PI_CODING_AGENT_DIR` 覆写）下的
`extensions/firecode/config.jsonc`；用户侧安装见 README。文件不存在时，主会话在扩展加载时（`registerFirecode`，先于 `loadConfig`）把随包模板 `config.example.jsonc` 原样写过去（`config-file.ts` 的 `seedConfig`，构建把模板复制进 `dist` 以便打包后定位），本次会话即按新文件生效；不区分 TUI/print/rpc，提示“已生成配置…重启生效”留到有 UI 的 `session_start` 显示一次。已存在的文件（含内容有问题）绝不覆盖，子会话不写盘，写入失败明确报错。改完本机运行配置后，把其中属于推荐配置的部分
同步进 `config.example.jsonc`，个人化内容（自定义 instructions、私人扩展名）留在本机。模板首次启动时原样写给所有用户，所以注释、角色名与角色 `use` 一律英文；角色名只由配置决定，代码与提示词不点名。

顶层 `language` 是唯一语言设置，不再有 `review.language`（旧写法按未知字段报错）。

配置里凡是指定模型的位置都写同一个模型原子 `"provider/model/thinking"`，解析在 `config.ts` 的 `parseModelAtom`
一处收口；旧的分字段与两段式写法一律报配置问题。

不要新建 keys.json，也不要读项目级配置。快捷键启动时绑定，改完需重启；加速档开关键（`keys.fast`）只改 `openai` 节，其它注释
保留。
快捷键冲突：宿主对扩展用 `registerShortcut` 注册的键，与*全部*内置键位（含只在会话列表等选择器里生效的）逐键比对，不分上下文，
撞上任何一个都在启动时弹 “Extension issues”；撞到编辑器全局保留键则扩展直接被跳过，其余则扩展先于内置处理。
所以默认键必须避开宿主全部默认键位（`tests/config-seam.test.ts` 守），改名这类宿主已有键位的动作不注册快捷键，
而是挂宿主的编辑器动作（见 `statusbar/index.ts` 的 `ShellEditor`）。
`review`、`master` 与 `watcher` 节有问题时对应功能拒绝启动而不是回退默认——静默回退会拿用户没配的模型
真实发起调用。能否启动只由 `loadConfig()` 给出的每节判定决定（文件级与 features 问题阻断三节），消费端不再自己筛
问题；关闭的功能那一节的问题不进 session_start 全局警告。
子会话只注册与界面无关的功能：横幅、工具渲染、预设与用量命令只属于交互主会话。

## 测试

```bash
bun test
bun run typecheck
```

`tests/loader.ts` 从 `PATH` 中的开发版 `pi` 定位 pi-mono；非开发版安装通过 `PI_PACKAGES_DIR` 指向其
`packages/`。loader 把当前仓库复制到临时目录并改写宿主包导入，供需要运行时值的用例使用。
`bun run typecheck` 用同一个定位结果：把 `.pi-mono`（已忽略）链到 pi-mono 根，`tsconfig.json` 继承其 tsconfig（宿主包路径映射只在 pi-mono 一处），
再调用它自带的 `tsc`。只检查运行时代码，测试、`scripts/` 与 `evals/` 因需要 Bun 类型而排除。
`pi-smoke` 用例启动真实 `pi` 并按 package.json 加载 `dist/`，先 `bun run build`。
