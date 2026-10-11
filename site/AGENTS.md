# 官网 site/

构建与检查：`cd site && bun install && bun run check && bun run build`。仓库根的 `bun run typecheck` 不覆盖这里。

- 产品事实只从仓库读，入口是 `src/repo.ts`：标语与简介取 README 里紧挨着的 `<h3>` 与 `<p>`；审查对比表、核心极轻表按表头文字定位（`HEADS`）；演示里的角色模型取 `config.example.jsonc` 的 researcher 与 engineer。找不到时构建失败。改这些内容去改 README 或模板，站点里不另写一份；新增读取的仓库文件同时加进 `vercel.json` 的跳过构建判定。
- `astro.config.mjs` 不 import 任何 .ts：配置加载时会去找仓库根的 tsconfig，它继承的 `.pi-mono` 只在开发机上存在，Vercel 上会构建失败。
- 中文用系统字体，不引网络中文字体。中文断行只由 `global.css` 里 `html:lang(zh)` 一条规则管，区块里不另写。
- 滚动播放的一幕（Agents、Review）用 `scroll.ts` 的 `scrollStory` 加 `components/Story.astro`：轨道的第一个子元素 sticky 钉住，滚动距离用轨道的 `::after` 垫块给出。sticky 只在父元素的内容区里移动，用 padding 给距离不会钉住。
- 区块里的循环 CSS 动画由全局样式统一处理：离开视口时按 `data-offscreen` 暂停，减少动效时只播一遍。
- 减少动效时不加载火焰（three.js），首屏显示静态标志；首屏标题的入场不等火焰。
