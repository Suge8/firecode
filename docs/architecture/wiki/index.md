---
baseline: 07e9f9034ad8cbf23b767c60daa5f87091987b83
sources:
  - agent/extensions/firecode/index.ts 371b956bc12d REGISTRARS
---

# FireCode 架构 Wiki

pi 的个人定制扩展层。代码是事实源，本 wiki 是持续维护的压缩理解；
每页 frontmatter 记录来源文件哈希，`node docs/architecture/verify.mjs` 做过期检查。

## 导航

- [系统总览](system.md)——模块地图、五条跨模块接缝、设计不变量
- [数据流](data-flow.md)——启动装配、请求改写、审查循环、Master 委派、辅助流

### 模块页

- [入口与共享基座](modules/core.md)——index.ts 装配、config.ts 配置事实源、共享工具
- [状态栏](modules/statusbar.md)——底部两行渲染、订阅额度抓取与缓存退避
- [工具行渲染](modules/tools.md)——默认 4 工具单行化、连续轨道、宿主原型 patch
- [会话功能](modules/session.md)——预设、改名、/tokens、Bark、herdr 投影、工作火焰
- [Provider 请求层](modules/provider.md)——Claude 归因、verbosity/加速档、原生压缩
- [对抗性审查](modules/review.md)——reducer/执行器分层、状态机、checkpoint、占用信号
- [Master 主控](modules/master.md)——subagents 工具、Worker 生命周期、事件投递

## 维护

同步流程见仓库 `~/.agents/skills/development/architecture-wiki/SKILL.md`：
代码变更后按 baseline diff 定位受影响页面，改正文或刷哈希，重渲染 `architecture.html`。
