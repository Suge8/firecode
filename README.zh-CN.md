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

<p align="center"><img alt="说个任务：子代理并行干活，各自送审，没过的打回重修，指挥官汇总终审后才交到你手里" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/flow.zh.gif" width="480"></p>

## 为什么用 FireCode

- **开箱即用。** 首次启动自动写入推荐配置，换成你已登录的模型就行。界面和提示词跟随系统语言。
- **子代理可控。** 并行跑，每个角色配置模型链，出故障自动切换，随时点开干预。
- **审查交付全自动。** 复杂任务自动审查，有问题就打回修复，直到通过；每次审查怎么结束的都会告诉你。
- **核心极轻。** 完美契合 Pi 原生的极简思路，上下文保持极度轻量。
- **视觉负担低。** 你只需要在乎真正重要的结果，中间过程全部折叠，想看再展开。

## 全自动审查交付

你只管告诉指挥官要做什么。遇到复杂任务，它会自动发起对抗审查：你配置的最多五个模型一起挑问题，挑出来就打回修复，修完再审。审查通过、顾问模型在反复失败后叫停、或轮数用完时结束。想手动审，也可以随时执行 `/fire-review`。

<p align="center"><img alt="第 1 轮没过，代理修复后第 2 轮通过" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.zh.gif" width="760"></p>

别的审查工具大多交给你一份问题清单，FireCode 会一直修复、复审：

| | 审查者 | 交到你手里的是 |
| --- | --- | --- |
| **FireCode** | 最多五个模型对抗审查 | **修好并复审的代码** |
| Claude Code `/code-review` | 你会话里的一个子代理 | 问题清单；`--fix` 可直接应用 |
| Codex `/review` | 一个审查者，用当前会话的模型 | 一份问题摘要 |
| Open Code Review（阿里） | 一个模型，每组文件一个子代理 | 行级评论，要你自己修 |
| Qodo | 专项代理加一个裁判 | 排好序的问题；可应用修复 |
| PR-Agent（开源） | 每个工具一次模型调用 | 评论和修改建议 |
| multi-model-review（Pi） | 多家模型 | 一份汇总结论 |

<sub>各行于 2026-10-12 对照各产品官方文档核对。</sub>

## 清晰的子代理状态

每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。

<p align="center"><img alt="指挥官并行派出三个子代理" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.zh.gif" width="760"></p>

<p align="center"><img alt="子代理的完整过程，在它自己的输入框里补一句话" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.zh.png" width="720"></p>

## 核心极轻

完美契合 Pi 原生的极简思路：子代理只加两个小工具，审查和观察员一个都不加。下表是子代理工具在每次请求里占的上下文：

| | 子代理工具数 | 字符数 |
| --- | --- | --- |
| **FireCode** | 2 | **1,715** |
| pi-subagents（0.77.0） | 2–3 | 1,561–4,918 |
| omp（18.10.1） | 2 | 3,369 |
| Codex CLI（0.162.1） | 5–6 | 5,045–9,641 |

<sub>发给模型的工具定义（名称、说明和参数）字符数，默认设置。FireCode 于 2026-10-31 实测，其余于 2026-10-12 实测。</sub>

## 还有这些

`/fire-watch` 便宜模型帮你盯着，跑偏才开口 · `/preset` 一键切换模型、思考档和工具 · `/quota`、`/tokens` 看用量 · `Ctrl+R` 改会话名 · `Ctrl+Shift+S` 开关 OpenAI 加速档 · OpenAI 原生压缩 · 适配 Claude 订阅登录 · Claude 截图只传一次，不再每轮重传

## 安装

```bash
pi install npm:pi-firecode
```

重启 Pi（1.4.0 及以上）就能用。配置文件首次启动时生成在 `~/.pi/agent/extensions/firecode/config.jsonc`：填上你用的模型，不想要哪个功能就写 `"features": { "<名字>": false }` 关掉。

- 用 herdr？先执行 `herdr integration uninstall pi`，FireCode 会自己上报 pane 状态。
- 子代理和审查者能执行不受沙箱约束的 `bash`，需要隔离就把 Pi 放进容器。

[参与开发](.github/CONTRIBUTING.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · MIT © Suge8
