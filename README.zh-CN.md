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
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><img alt="指挥官并行派出三个子代理" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.zh.gif" width="860"></p>

## 为什么用 FireCode

- **开箱即用。** 默认配置就是推荐配置，支持多语言。
- **子代理可控。** 并行跑，每个角色独立选模型，出故障自动切换，随时点开干预。
- **审查交付全自动。** 不用盯着，交到你手里的就是审查通过的结果。
- **核心极轻。** 完美契合 Pi 原生的极简思路，上下文保持极度轻量。
- **视觉负担低。** 你只需要在乎真正重要的结果，中间过程全部折叠，想看再展开。

## 全自动审查交付

你只管告诉指挥官要做什么。遇到重要、难的任务，它会自动发起对抗审查：你配置的任意多个模型一起挑问题，挑出来就打回修复，修完再审，直到通过才交给你，交出来的是质量过关、满足需求的代码。反复卡住时，顾问模型会出来拿主意。想手动审，也可以随时执行 `/fire-review`。

<p align="center"><img alt="第 1 轮没过，代理修复后第 2 轮通过" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.zh.gif" width="760"></p>

别的审查工具交给你一份问题清单，FireCode 交给你修好并复审通过的代码：

| | 审查者 | 交到你手里的是 |
| --- | --- | --- |
| **FireCode** | 任意多个模型对抗审查 | **修好、复审通过的代码** |
| Qwen Code `/review` | 最多 16 个代理，同一个模型 | 问题清单；`--fix` 修一次，不复审 |
| Open Code Review（阿里） | 同一个模型，逐文件审 | 问题清单，要你自己修 |
| PR-Agent / Qodo | 分工代理，同一个模型 | 评论和修改建议 |
| multi-model-review（Pi） | 多家模型 | 一份汇总结论 |

## 清晰的子代理状态

每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。

<p align="center"><img alt="子代理的完整过程，在它自己的输入框里补一句话" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.zh.png" width="720"></p>

## 核心极轻

完美契合 Pi 原生的极简思路：子代理只加两个小工具，审查和观察员一个都不加。下表是子代理工具在每次请求里占的上下文（发给模型的工具定义字符数，2026 年 10 月实测）：

| | 子代理工具数 | 字符数 |
| --- | --- | --- |
| **FireCode** | 2 | **926** |
| omp | 2 | 3,140 |
| Codex CLI | 5–6 | 4,766–9,378 |
| pi-subagents | 2–3 | 4,703–23,182 |

## 还有这些

`/fire-watch` 便宜模型帮你盯着，跑偏才开口 · `/preset` 一键切换模型、思考档和工具 · `/quota`、`/tokens` 看用量 · `Ctrl+R` 改会话名 · `Ctrl+Shift+S` 开关 OpenAI 加速档 · 适配 Claude 订阅登录

## 安装

```bash
pi install npm:pi-firecode
```

重启 Pi（1.1.0 及以上）就能用，配置文件首次启动时自动生成。不想要哪个功能，在 `~/.pi/agent/extensions/firecode/config.jsonc` 里写 `"features": { "<名字>": false }` 关掉。

[参与开发](.github/CONTRIBUTING.md) · MIT © Suge8
