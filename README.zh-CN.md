<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<h3 align="center">装这一个，其余扩展都可以卸了。</h3>

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
- **审查不止给报告。** 几个不同的模型一起审，挑出的问题打回给代理修，直到修好为止。
- **核心很轻。** 子代理只有两个小工具，审查和观察员一个工具都不加。
- **视觉负担低。** 中间过程全部折叠，你只看结果；工具细节想看再展开。

## 更强的全自动审查交付

改完代码执行 `/fire-review`。几个不同家的模型审查代理实际做的事：改了哪些文件、会话里说了什么，还会自己跑测试取证。挑出的问题直接打回给代理修，下一轮再查；反复修不好时，由顾问模型决定继续、收窄范围还是停下。

<p align="center"><img alt="第 1 轮没过，代理修复后第 2 轮通过" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.zh.gif" width="760"></p>

多数开源审查工具给完报告就结束了：

| | 审查者 | 发现问题后修吗 | 修完再查吗 |
| --- | --- | --- | --- |
| **FireCode** | 多家模型 | 自动修 | 查到通过为止 |
| Qwen Code `/review` | 最多 16 个代理，同一个模型 | `--fix` 修一次 | 不查 |
| Open Code Review（阿里） | 同一个模型，逐文件审 | 不修，你修完自己标记 | 不查 |
| PR-Agent / Qodo | 分工代理，同一个模型 | 手动触发 | 不查 |
| multi-model-review（Pi） | 多家模型 | 不修 | 不查 |

## 清晰的子代理状态

每个子代理都列在输入框上方，点一下就能看它的完整过程，并直接跟它说话。

<p align="center"><img alt="子代理的完整过程，在它自己的输入框里补一句话" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.zh.png" width="720"></p>

## 核心很轻

子代理工具在每次请求里占多少上下文（发给模型的工具定义字符数，2026 年 10 月实测）。审查和观察员跑在各自的会话里，不加任何工具。

| | 子代理工具数 | 字符数 |
| --- | --- | --- |
| **FireCode** | 2 | **926** |
| omp | 2 | 3,140 |
| Codex CLI | 5–6 | 4,766–9,378 |
| pi-subagents | 2–3 | 4,703–23,182 |

## 还有这些

`/fire-watch` 便宜模型帮你盯着，跑偏才开口 · `/preset` 一键切换模型、思考档和工具 · `/quota`、`/tokens` 看用量 · `Ctrl+R` 改会话名 · `Ctrl+Shift+S` 开关 OpenAI 加速档

用 Claude 订阅的话，登录令牌刚好轮换导致的请求失败会自动重试一次，不会打断当前回合。

不想要哪个功能，在 `~/.pi/agent/extensions/firecode/config.jsonc` 里写 `"features": { "<名字>": false }` 关掉。

[参与开发](.github/CONTRIBUTING.md) · MIT © Suge8
