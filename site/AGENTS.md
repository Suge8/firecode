# 官网 site/

构建与检查：`cd site && bun install && bun run check && bun run build`。仓库根的 `bun run typecheck` 不覆盖这里。

- 产品事实只从仓库读，入口是 `src/repo.ts`：标语与简介取 README 里紧挨着的 `<h3>` 与 `<p>`；审查对比表、核心极轻表按表头文字定位（`HEADS`）；演示里的角色模型取 `config.example.jsonc` 的 researcher 与 engineer。找不到时构建失败。改这些内容去改 README 或模板，站点里不另写一份；新增读取的仓库文件同时加进 `vercel.json` 的跳过构建判定。
- `astro.config.mjs` 不 import 任何 .ts：配置加载时会去找仓库根的 tsconfig，它继承的 `.pi-mono` 只在开发机上存在，Vercel 上会构建失败。
- 中文用系统字体，不引网络中文字体。中文断行只由 `global.css` 里 `html:lang(zh)` 一条规则管，区块里不另写。
- 滚动播放的一幕（Agents、Review）用 `scroll.ts` 的 `scrollStory` 加 `components/Story.astro`：轨道的第一个子元素 sticky 钉住，滚动距离用轨道的 `::after` 垫块给出。sticky 只在父元素的内容区里移动，用 padding 给距离不会钉住。
- 区块里的循环 CSS 动画由全局样式统一处理：离开视口时按 `data-offscreen` 暂停，减少动效时只播一遍。
- 减少动效时不加载火焰（three.js），首屏显示静态标志；首屏标题的入场不等火焰。

## README 两张表的来源与口径

审查对比表各行按官方来源核对（上次 2026-10-12）：[Claude Code Code Review](https://code.claude.com/docs/en/code-review)（“Review a diff locally”）、[Codex 斜杠命令](https://developers.openai.com/codex/cli/slash-commands)与 [Codex review 任务](https://github.com/openai/codex/blob/27065a9/codex-rs/core/src/tasks/review.rs)、[Open Code Review README](https://github.com/alibaba/open-code-review/blob/357c3f0/README.md)、[Qodo 文档](https://docs.qodo.ai/code-review)、[PR-Agent README](https://github.com/The-PR-Agent/pr-agent)、[multi-model-review](https://github.com/Scott-Meyer/multi-model-review)（npm 0.2.2）。核不到来源的行删掉，不沿用旧说法。

核心极轻表的口径：每个子代理/委派工具 `JSON.stringify({name, description, parameters}).length`，默认设置，表里写版本号；改了工具定义、默认角色或要更新竞品版本时重测。
- FireCode：`subagents` 与 `subagents_list`，模板角色、英文界面（中文界面 1,031）。指挥官提示词另占英文 8,740、中文 2,745 字符（去除首尾空白后的 JS 字符串长度），加每角色一行，不计入。
- pi-subagents 0.77.0（[5852aa0](https://github.com/nicobailon/pi-subagents/tree/5852aa08ccd55e8c64dd16e69d1b96a17e92b8aa)）：`subagent` 3,357、`bg_wait` 1,133、加载器 `subagents_enable` 428。低值是能中途加工具的模型上只有加载器与 `bg_wait` 常驻；启用委派后或其他模型上默认 4,490–4,918。复现：把它的 `index.ts` 加载到只记录 `registerTool` 的假 `ExtensionAPI` 上量。
- omp（`@oh-my-pi/pi-coding-agent` 18.10.1，[5d0aaff](https://github.com/can1357/oh-my-pi/tree/5d0aaffaf1f987503ce129a642fb6e30339615af)）：`task` 2,856、`wait` 513；交互会话多出的提问工具 `ask` 不算委派，不计入。
- Codex CLI 0.162.1（[092d3ac](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d)）：默认 `multi_agent_v1` 五个共 9,641（`spawn_agent` 6,581、`send_input` 1,561、`wait_agent` 703、`close_agent` 515、`resume_agent` 281）；`features.multi_agent_v2 = true` 六个共 5,045。`spawn_agent` 的说明列出账号可用模型（这里是二进制内置的五个，占 837），数字随模型列表浮动。
- omp 与 Codex 的复现：从 npm 装进临时目录，对一个只记录请求体、回一个词的本地 HTTP 服务用假密钥非交互跑一次（`omp -p`、`codex exec`；omp 在 `models.yml` 加供应商，Codex 加 `wire_api = "responses"` 的 `model_providers` 条目），取第一次请求的 `tools`。
