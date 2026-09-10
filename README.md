# FireCode

FireCode 是一个模块化 Pi Package，提供终端状态与工具渲染、会话预设、`/fire-review` 对抗审查、`/fire-master` 进程内子代理委派和 `/fire-watch` 观察员。指挥官与观察员的新会话状态由配置决定，裸命令只翻转当前会话；各模块由功能开关独立注册，关闭任一模块不会改变其余模块。

## 安装

```bash
pi install git:github.com/Suge8/firecode@v0.6.1
```

也可在本地仓库中直接试用：

```bash
pi -e .
```

Pi Package 拥有与 Pi 相同的本机权限；安装前应审阅源码。

## 配置

运行配置不随包分发。将公开模板复制到 Pi Agent 目录后按需启用功能，再重启 Pi：

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/firecode"
curl -fsSL https://raw.githubusercontent.com/Suge8/firecode/v0.6.1/config.example.jsonc \
  -o "$agent_dir/extensions/firecode/config.jsonc"
```

公开模板提供维护者当前的完整推荐配置：除 Bark 外功能全开，Master 与 Watcher 在新会话自动激活。Watcher 会在每个主会话回合后调用模型，OpenAI priority 会按供应商规则加价；复制前应确认列出的模型均已认证并接受额外费用。配置里指定模型一律写 `"provider/model/thinking"`；审查与观察员的模型必须显式写入运行配置，否则对应功能拒绝启动。缺少运行配置时，FireCode 会关闭可选功能并在会话启动时警告；配置模板本身不会被运行时读取。

## 终端展示与额度查询

底栏第一行显示目录、会话标题和已开启模块的状态，第二行显示模型、思考档、Fast 与上下文占用。未重命名时
标题取首条用户文本的前六个字，尚未输入时显示“新会话”；这不会修改正式会话名。工作火焰和 Pi 的缓存告警保留。

连续工具调用默认合成一行，显示调用次数、运行数、失败数和最新运行动作。按工具展开快捷键（默认 `Ctrl+O`）
切换为每个工具一行，再按回到组摘要；点击组摘要也可打开列表，点击列表中的单个工具查看或收起正文。
思考、文字和通知分隔工具组，图片与自定义交互内容独立保留。其他卡片仍按 Pi 原生行为响应全局展开。

`/quota` 查询已在 Pi 中 OAuth 登录的 Codex、Claude 订阅剩余额度，并展示接口提供的 Fable 周额度。
结果带查询时间，不打断当前工作、不发送给模型；未登录或查询失败会明确显示。查询没有后台刷新或磁盘缓存，
结果是供应商返回的快照，不保证供应商零延迟。Fable 与总体周额度共享约束，不是额外额度。
`features.stats` 同时控制 `/quota` 和本地用量统计 `/tokens`。

## 开发

需要 [Bun](https://bun.sh/) 和一个 pi-mono checkout。开发版 `pi` 在 `PATH` 中时，测试会自动定位它；否则设置 `PI_PACKAGES_DIR` 为 pi-mono 的 `packages/` 目录。

```bash
bun test
```

模块边界、状态机约束和领域术语见 `AGENTS.md`、各模块的 `AGENTS.md` 与 `CONTEXT.md`。
