# FireCode

FireCode 是一个 Pi 扩展包：把会话状态嵌进输入框边框、把每轮过程折叠成一行摘要，并提供对抗审查、多子代理指挥与观察员。各功能独立开关，关掉任一个不影响其余。

```text
─ ⣾⣿⣷ 处理中 1m3s · ⠹ 审查 第2轮 1/3 · 1 阻断 ──────────── 观察员 指挥官 ─
 输入区
─ 优化插件状态栏和工具展示 ───────────── gpt-6-astra/medium Fast · 42.3%/200k ─
```

## 安装

```bash
pi install npm:pi-firecode
```

需要 Pi 1.1.0 及以上，升级用 `pi update`。扩展拥有与 Pi 相同的本机权限，安装前请审阅源码。

## 配置

配置不随包生效。把推荐模板复制到 Pi Agent 目录，再重启 Pi：

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/firecode"
curl -fsSL https://unpkg.com/pi-firecode/config.example.jsonc -o "$agent_dir/extensions/firecode/config.jsonc"
```

- 模板里的模型一律写成 `"provider/model/thinking"`，换成你已登录的模型。
- 审查、指挥官、观察员会真实调用配置里的模型；某一节配错时该功能拒绝启动并提示，不会改用默认模型。
- 会额外花钱的：观察员每回合调用一次模型（模板里默认不自动开启）；OpenAI 加速档按供应商规则加价。
- 没有配置文件时，可选功能全部关闭，并在会话启动时提示。

## 功能

| 功能 | 入口 | 做什么 |
| --- | --- | --- |
| 输入框状态 | 自动 | 上边框显示进行状态、计时与审查进度，下边框显示会话标题、模型、思考档与上下文占用 |
| 过程折叠 | 自动；点摘要或 `Ctrl+O` 展开 | 每次输入折成一轮：一行摘要（耗时、均速）、最近 3 条中间回复的首句、最终回复全文 |
| 预设 | `/preset`、预设里配的快捷键 | 一键切换模型、思考档、工具集与附加指令 |
| 对抗审查 | `/fire-review` | 多个模型并行审查改动；没过自动修复再审，连续失败请顾问模型裁决 |
| 指挥官 | `/fire-master`（新会话默认开启） | 按角色表把工作派给子代理并行执行；输入框上方列出子代理，点一行看它的全过程并可直接补话 |
| 观察员 | `/fire-watch` | 每回合结束后用便宜模型评估新增内容，跑偏或过度工程时插话 |
| 用量 | `/quota`、`/tokens` | 查 Claude、Codex 订阅剩余额度；统计本地会话的 token 与成本 |
| 会话名 | `/rename`、`Ctrl+R` | 改当前会话名 |
| OpenAI 请求层 | `Ctrl+F` 切加速档 | 回答详略、加速档、可选的 OpenAI 原生上下文压缩 |
| Claude 订阅适配 | 自动 | 请求带 Claude Code 归因；令牌换发导致的 401 自动重试一次 |

在配置的 `features` 里写 `false` 即可关闭对应功能，比如 `"features": { "watcher": false }`。

## 开发

需要 [Bun](https://bun.sh/) 和一份 pi-mono 源码：开发版 `pi` 在 `PATH` 中时测试会自动定位它，否则把 `PI_PACKAGES_DIR` 设为 pi-mono 的 `packages/` 目录。

```bash
bun test   # 测试
pi -e .    # 在本地仓库直接试用
```

模块边界、状态机约束与术语见 `AGENTS.md`、各模块的 `AGENTS.md` 与 `WORDS.md`。
