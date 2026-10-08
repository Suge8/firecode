<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<h3 align="center">我现在唯一保留的 Pi 扩展。</h3>

<p align="center">给 <a href="https://pi.dev">Pi</a> 加上并行子代理、多模型代码审查和更干净的终端界面。装一个就够，开箱即用。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  · <a href="README.md">English</a>
</p>

<p align="center"><img alt="指挥官并行派出三个子代理" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.zh.gif" width="860"></p>

```bash
pi install npm:pi-firecode
```

重启 Pi（1.1.0 及以上）就能用，配置文件首次启动时自动生成。

## 为什么用 FireCode

我以前装了一堆 Pi 扩展，现在只留这一个。

- **开箱即用。** 装一个就行，默认配置直接能用，界面中英文都有。
- **子代理真正可控。** 多个并行跑，每个角色用自己的模型，供应商出故障自动换备用模型；任何一个都能点开看过程、直接跟它说话。
- **审查会修问题。** 每次改动由几个模型一起审，挑出的问题打回给代理修，修完再审。
- **几乎不占上下文。** 委派只给每次请求加两个很小的工具。
- **好看。** 状态放在输入框边框里，每次请求折成一行。

## 会修问题的审查

改完代码执行 `/fire-review`。审查发现 bug，代理就去修，下一轮只复查这个问题；反复修不好时，顾问模型会出来拿主意。

<p align="center"><img alt="第 1 轮没过，代理修复后第 2 轮通过" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.zh.gif" width="760"></p>

## 看得见的子代理

每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。

<p align="center"><img alt="子代理的完整过程，在它自己的输入框里补一句话" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.zh.png" width="720"></p>

## 刻意做小

委派在每次请求里要占多少上下文（发给模型的工具定义字符数，2026 年 10 月实测）：

| | 工具数 | 字符数 |
| --- | --- | --- |
| **FireCode** | 2 | **926** |
| omp | 2 | 3,140 |
| Codex CLI | 5–6 | 4,766–9,378 |
| pi-subagents | 2–3 | 4,703–23,182 |

## 还有这些

`/fire-watch` 便宜模型帮你盯着，跑偏才开口 · `/preset` 一键切换模型、思考档和工具 · `/quota`、`/tokens` 看用量 · `Ctrl+R` 改会话名 · `Ctrl+Shift+S` 开关 OpenAI 加速档

不想要哪个功能，在 `~/.pi/agent/extensions/firecode/config.jsonc` 里写 `"features": { "<名字>": false }` 关掉。

[参与开发](.github/CONTRIBUTING.md) · MIT © Suge8
