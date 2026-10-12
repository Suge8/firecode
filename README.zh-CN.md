<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<p align="center">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-FF7A0F?style=for-the-badge"></a>
  <a href="README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-2b2b2b?style=for-the-badge"></a>
</p>

<h3 align="center">装这一个，其余扩展都可以卸了。</h3>

<p align="center">给 <a href="https://pi.dev">Pi</a> 加上并行子代理、多模型代码审查和更干净的终端界面。装一个就够，开箱即用。</p>

<p align="center">
  <a href="https://firecode.si"><img alt="官网" src="https://img.shields.io/badge/%E5%AE%98%E7%BD%91-firecode.si-FF7A0F"></a>
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><img alt="指挥官并行派出三个子代理" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.zh.gif" width="860"></p>

## 安装

```bash
pi install npm:pi-firecode
```

需要 Pi 1.1.0 及以上。重新启动 Pi 即生效。

使用前请留意：

- **模型。** 默认配置假定你已登录 Anthropic（Claude）、OpenAI Codex 和 DeepSeek。子代理角色、审查者、顾问、观察员和预设各自用 `"provider/model/thinking"` 指定模型，改 `~/.pi/agent/extensions/firecode/config.jsonc`（Pi 的 agent 目录，设了 `$PI_CODING_AGENT_DIR` 则在那里），改完重启 Pi。
- **哪些模型可用。** 子代理、审查者和观察员是进程内的子会话，只认 Pi 内置 provider 或 `models.json` 里的模型；其他扩展注册的 provider 的模型在那里找不到。
- **herdr。** FireCode 自己上报 pane 的 agent 状态。请卸载 herdr 官方的 Pi 集成（`herdr integration uninstall pi`），也不要在 herdr 设置里给 Pi 点“install”，否则两边会互相覆盖。
- **关掉某个功能。** 在同一个文件里写 `"features": { "<名字>": false }`，名字见文件里的列表。
- **安全边界。** 子代理和审查者带有不受沙箱约束的 `bash`。子代理 `edit`/`write` 的守卫（只放行当前 checkout 和临时目录）只防误伤，不是安全边界。需要隔离就把 Pi 放进容器或只读挂载。

## 第一次使用

1. 启动 Pi。`config.jsonc` 不存在时，FireCode 会写入推荐配置并立刻使用；填上你能用的模型，重启即可。
2. 描述一个由几部分组成的任务。指挥官（Master）会拆分任务并启动子代理，它们列在输入框上方；点一个就能看它的完整过程或直接跟它说话。
3. 复杂任务由指挥官在交还结果前送审。你也可以随时自己执行 `/fire-review`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/fire-master` | 开关当前会话的指挥官模式（新会话默认开）；`/fire-master status` 列出子代理 |
| `/fire-review [关注点]` | 对这个会话到目前为止做完的事做对抗审查 |
| `/fire-watch` | 开关当前会话的观察员：便宜模型帮你盯着，跑偏才开口（新会话默认关） |
| `/preset` | 一键切换模型、思考档和工具；启动时可用 `--preset`；模板绑定了 `Alt+1`–`Alt+6` |
| `/quota` | 查看 Codex、Claude 订阅的剩余额度 |
| `/tokens [天数]` | 统计会话文件里的 token 和花费 |
| `/fast` | 开关 OpenAI/xAI 加速档（`Ctrl+Shift+S`） |

在输入框里按 Pi 的改名键（默认 `Ctrl+R`）可以改会话名。在子代理的全过程视图里，`Ctrl+Shift+X` 中断它；审查中的子代理被中断时会取消这场审查，审查义务保留。`/fire-review --cancel` 可手动停掉进行中的审查。

OpenAI 原生压缩（`openai.nativeCompaction`，模板里开启）使用 OpenAI/Codex 自带的上下文压缩。压缩结果是只能由同一模型和基址续用的密文窗口，切换模型后不能续用，FireCode 会提示。手动 `/compact` 在窗口不可用时会取消并说明原因；自动压缩则回落到普通摘要并给出警告。想一直用普通摘要，把 `nativeCompaction` 设为 `false` 并重启。

## 审查与交付

你只管告诉指挥官要做什么。遇到复杂任务，它会发起对抗审查：你配置的任意多个模型一起挑问题，挑出来就打回修复，修完再审。审查通过、顾问模型在反复失败后叫停、或轮数用完时结束，结果卡会写明是哪一种。故障、超时和取消如实报告，不算通过。

<p align="center"><img alt="第 1 轮没过，代理修复后第 2 轮通过" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.zh.gif" width="760"></p>

别的审查工具报告问题，有的能一次性应用修复。FireCode 反复修复、复审，直到审查通过、顾问叫停或轮数用尽：

| | 审查者 | 交到你手里的是 |
| --- | --- | --- |
| **FireCode** | 任意多个模型对抗审查 | **修好并复审的代码** |
| Claude Code `/code-review` | 你的 Claude Code 会话派生的一个子代理 | 问题清单；`--fix` 把它应用到工作区 |
| Codex `/review` | 一个审查者，用当前会话的模型（或 `review_model`） | 一份问题摘要 |
| Open Code Review（阿里） | 一个配置好的模型；改动文件分组，每组一个子代理 | 行级审查评论，要你自己修 |
| Qodo | 并行的专项代理，加一个汇总裁判代理 | PR 上按严重度排序的问题；Qodo 可以生成并应用修复 |
| PR-Agent（开源） | 每个工具一次 LLM 调用，模型可配置 | 审查评论和代码修改建议 |
| multi-model-review（Pi） | 多家模型，互相交叉核对 | 一份汇总结论 |

竞品各行于 2026-10-12 对照以下来源核对：[Claude Code 文档 Code Review](https://code.claude.com/docs/en/code-review)（“Review a diff locally”一节）、[Codex 斜杠命令](https://developers.openai.com/codex/cli/slash-commands)与 [Codex 的 review 任务](https://github.com/openai/codex/blob/27065a9/codex-rs/core/src/tasks/review.rs)、[Open Code Review README](https://github.com/alibaba/open-code-review/blob/357c3f0/README.md)、[Qodo 文档](https://docs.qodo.ai/code-review)、[PR-Agent README](https://github.com/The-PR-Agent/pr-agent)、[multi-model-review](https://github.com/Scott-Meyer/multi-model-review)（npm 0.2.2）。这些产品会变，引用某一行前请先对照来源。

## 清晰的子代理状态

每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。主界面里每一轮折叠成一行摘要（当前在做什么，结束后是 `✓ 耗时 · 均速`），思考、工具调用和子代理结果点开才展开。

<p align="center"><img alt="子代理的完整过程，在它自己的输入框里补一句话" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.zh.png" width="720"></p>

## 核心极轻

指挥官只加两个小工具，审查和观察员一个都不加。下表是子代理工具在每次请求里占的上下文（发给模型的名称、说明和参数，2026-10-12 实测）：

| | 子代理工具数 | 字符数 |
| --- | --- | --- |
| **FireCode** | 2 | **1,713** |
| pi-subagents（0.77.0） | 2–3 | 1,561–4,918 |
| omp（18.10.1） | 2 | 3,369 |
| Codex CLI（0.162.1） | 5–6 | 5,045–9,641 |

测法：每个工具的 `name`、`description`、`parameters` 的 JSON 字符数。FireCode 统计 `subagents` 与 `subagents_list`，用模板里的角色和英文界面（中文界面是 1,022）。pi-subagents 0.77.0（[提交 5852aa0](https://github.com/nicobailon/pi-subagents/tree/5852aa08ccd55e8c64dd16e69d1b96a17e92b8aa)，2026-10-11；默认设置）注册 `subagent`（3,357）、`bg_wait`（1,133）和加载器 `subagents_enable`（428）。低值是在能中途加工具的模型上，只有加载器和 `bg_wait` 在请求里的情形；启用委派之后，或在其他模型上默认，是 4,490–4,918。复现 pi-subagents 的数字：把它的 `index.ts` 加载到一个只记录 `registerTool` 调用的假 `ExtensionAPI` 上（工具注册在 `src/extension/index.ts`、`src/extension/tool-activation.ts` 和 `src/runs/background/wait-tool.ts`），对记录到的每个工具用同样的方法量。omp（`@oh-my-pi/pi-coding-agent` 18.10.1，[提交 5d0aaff](https://github.com/can1357/oh-my-pi/tree/5d0aaffaf1f987503ce129a642fb6e30339615af)，2026-10-12；默认设置）发送两个：`task`（2,856）和 `wait`（513）；交互会话还会发向用户提问的工具 `ask`，不计入，换用其他 API 格式时总数相差不到 50 字符。Codex CLI 0.162.1（[提交 092d3ac](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d)，2026-10-09）默认发送五个（`multi_agent_v1`：`spawn_agent` 6,581、`send_input` 1,561、`wait_agent` 703、`close_agent` 515、`resume_agent` 281，共 9,641），设置 `features.multi_agent_v2 = true` 后发送六个（`spawn_agent` 2,652、`followup_task` 606、`wait_agent` 611、`send_message` 462、`interrupt_agent` 384、`list_agents` 330，共 5,045）；每个 `spawn_agent` 的说明里列出账号可用的模型，这里是二进制内置的五个（默认版本占 837 字符），所以数字随模型列表变化。复现 omp 与 Codex 的数字：各自从 npm 装进临时目录，对着一个记录请求体并只回一个词的本地 HTTP 服务、用假密钥非交互运行一次（`omp -p`、`codex exec`；omp 在 `models.yml` 里加一个供应商，Codex 加一个 `wire_api = "responses"` 的 `model_providers` 条目），第一次请求里的 `tools` 字段就是工具定义，用同样的方法量。这里只算工具定义：指挥官提示词另给系统提示增加约 8,500 字符（英文文件 8,527，中文 6,625），再加每个角色一行。

[参与开发](.github/CONTRIBUTING.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · MIT © Suge8
