<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<p align="center">
  给 <a href="https://pi.dev">Pi</a> 的多子代理指挥与对抗审查扩展：轻、稳，终端里安静不吵。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  · <a href="README.md">English</a>
</p>

<p align="center">
  <img alt="FireCode 并行派出三个子代理" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="860">
</p>

## 快速开始

```bash
pi install npm:pi-firecode
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/firecode"
curl -fsSL https://unpkg.com/pi-firecode/config.example.jsonc -o "$agent_dir/extensions/firecode/config.jsonc"
```

重启 Pi（需要 1.1.0 及以上）。模板是维护者自己的完整配置，把里面每个 `"provider/model/thinking"` 换成你已登录的模型。之后用 `pi update` 升级。

## 为什么用 FireCode

**审查会自己闭环。** `/fire-review` 让多个模型并行审查你的改动。有 FAIL 就把问题直接交回给代理修，下一轮只复查上一轮指出的问题；连续不过时由顾问模型裁决是继续、收窄还是叫停；轮数有硬上限。进度写进会话，重载后接着审，不会丢。

<p align="center"><img alt="/fire-review 审查结果卡" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-review.png" width="720"></p>

**子代理不会丢。** 指挥官（`/fire-master`）按角色派活：每个角色有自己的模型和思考档，还有一条备用模型链，某家供应商出故障时在同一个会话里接着跑。结果先写进会话再投递，重载后重投。每个子代理都列在输入框上方，点一下就能看它的全过程，并直接跟它说话。

<p align="center"><img alt="输入框上方三个子代理在跑" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-subagents.png" width="720"></p>

**轻。** 委派只有两个工具，工具定义合计 926 字符。子代理是进程内的 Pi 会话，没有后台进程，Pi 退出不留孤儿。npm 包是一个 121 kB 的单文件。

**终端里安静。** 状态嵌在输入框边框里。每次请求折成一行摘要（耗时、均速、最近几条中间回复），下面是最终回复；点摘要或按 `Ctrl+O` 看全部工具调用。

<p align="center"><img alt="一次请求折成一行摘要" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-fold.png" width="720"></p>

## 和同类工具对比

依据 2026 年 10 月的公开文档与源码。

| | FireCode | Claude Code | Codex CLI | omp | pi-subagents |
| --- | --- | --- | --- | --- | --- |
| 审查 → 修复 → 复审循环 | 多模型、顾问裁决、轮数上限 | 单次（`--fix` 修一次） | 单个审查者，不修复 | 并行审查，不回流修复 | 提示词模板，最多 3 轮 |
| 子代理备用模型链 | 有 | 有 | 未找到 | 有 | 无 |
| 重载后子代理的结果 | 持久化并重投 | 记录保留 | 可续派，尽力投递 | 可复活，无人接收的结果丢弃 | 后台运行不受影响 |
| 查看并干预每个子代理 | 能 | 能 | 能 | 能 | 能 |
| 委派工具定义体量 | 926 字符 | — | — | 3,140 字符 | — |

## 功能

| 功能 | 入口 | 做什么 |
| --- | --- | --- |
| 指挥官 | `/fire-master`（默认开启） | 按角色把工作并行派给子代理，输入框上方实时列出 |
| 对抗审查 | `/fire-review` | 多模型审查，自动修复再审，顾问裁决 |
| 观察员 | `/fire-watch` | 便宜模型每回合看一眼，跑偏时才插话 |
| 输入框状态 | 自动 | 进度、计时、审查轮次、标题、模型与上下文占用都在边框里 |
| 过程折叠 | 自动，`Ctrl+O` | 每次请求一行摘要，细节按需展开 |
| 预设 | `/preset`、你配的快捷键 | 一起切换模型、思考档、工具集与附加指令 |
| 用量 | `/quota`、`/tokens` | Claude、Codex 订阅剩余额度；本地 token 与成本统计 |
| Claude 订阅适配 | 自动 | 请求带 Claude Code 归因；令牌换发导致的 401 自动重试一次 |
| OpenAI 请求层 | `Ctrl+F` | 回答详略、加速档、可选的原生上下文压缩 |

在配置里写 `"features": { "<名字>": false }` 关掉任一功能。

## 开发

需要 [Bun](https://bun.sh/) 和一份 pi-mono 源码，见 [CONTRIBUTING](.github/CONTRIBUTING.md)。

```bash
bun test
bun run typecheck
bun run build && pi -e .
```

架构、约束与术语见 `AGENTS.md`、各模块的 `AGENTS.md` 与 `WORDS.md`。

MIT © Suge8
