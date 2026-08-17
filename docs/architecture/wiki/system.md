---
sources:
  - agent/extensions/firecode/index.ts 371b956bc12d REGISTRARS registerReview registerMaster registerHerdrDisplay
  - agent/extensions/firecode/config.ts 17512757882e loadConfig FEATURES parseReviewConfig parseMasterConfig
  - agent/extensions/firecode/review/outcome.ts 390ab5ea36a2 readReviewOutcome REVIEW_OCCUPANCY_LABEL
  - agent/extensions/firecode/master/state.ts e51063b2f460 loadMasterState masterStatePath
  - agent/extensions/firecode/tools/line.ts cd6bca3c9b27 ToolLine makeResultRenderer
---

# 系统总览

FireCode 是 pi 的个人定制扩展，单一入口 `index.ts` 按 `config.jsonc` 的 `features` 开关逐个调
`registerX(pi)` 装配十余个彼此封闭的功能模块。没有中央运行时、没有共享事件总线：每个 register
把自己的状态关在闭包里，关掉任何一个不影响其余。配置的唯一事实源是 [config.ts](modules/core.md)，
校验姿态是「类型错误记录为 problem、review/master 节命中问题即拒绝启动而非静默回退」。

## 模块地图

| 模块页 | 覆盖 | 一句话职责 |
| --- | --- | --- |
| [入口与共享基座](modules/core.md) | index.ts、config.ts、header.ts、format/theme/flame-frames/herdr-client | 装配决策 + 无状态共享工具 |
| [状态栏](modules/statusbar.md) | statusbar/ | 底部两行：位置/会话名/指挥官徽标 + 模型/额度/上下文/缓存/速度 |
| [工具行渲染](modules/tools.md) | tools/ | 接管默认 4 工具的单行渲染与连续轨道 |
| [会话功能](modules/session.md) | session/ | 预设、改名、/tokens、Bark 通知、herdr 身份投影、工作火焰 |
| [Provider 请求层](modules/provider.md) | provider/ | Claude 归因头、OpenAI verbosity/加速档/原生压缩 |
| [对抗性审查](modules/review.md) | review/ | /fire-review：多模型并行审 + 顾问仲裁 + checkpoint |
| [Master 主控](modules/master.md) | master/ | /fire-master：subagents 工具管 Herdr Worker 生命周期 |

## 跨模块接缝

模块间的真实耦合只有五条，全部单向：

1. **Master → review**：`master/herdr.ts` 只读调 `review/outcome.ts` 的 `readReviewOutcome`
   读 Worker 审查终态，并用 `REVIEW_OCCUPANCY_LABEL` 区分审查占用与 Worker 提问。
   checkpoint 格式仍归 review 所有，两者不交换运行身份。
2. **bark → Master 状态**：`session/bark.ts` 经 `loadMasterState(masterStatePath(id))` 只读
   Worker Pool 持久化文件判断有无待拍板子代理，读失败按无待拍板降级。
3. **Master → tools 渲染**：`master/index.ts` 复用 `tools/line.ts` 的 `ToolLine` /
   `makeResultRenderer` 纯组件画自己的 `subagents` 工具行。
4. **review → working-flame（频道）**：review 在进程内 `herdr:blocked` 频道发布占用信号，
   工作火焰据此在审查活跃期退让；消费方不反向依赖 review 状态。
5. **review / provider / Master → statusbar（状态键）**：状态栏从宿主扩展状态表只读
   `fire-review`（审查进度）、`pi-openai-native-fast`（加速档标记）与 `master`
   （指挥官徽标，Master 按子代理状态计数写入，窄屏整段丢弃）三个键，键不存在时片段为空。

其余共享全是无状态基座：`format.ts`（宽度/文本格式化）、`theme.ts`（阈值配色）、
`flame-frames.ts`（火焰帧素材，review 活动框与工作火焰共用）、`herdr-client.ts`
（herdr socket 短连接，身份投影与占用标签共用）。

## 设计不变量

- **单一状态事实源**：review 循环状态只在 `review/state.ts` 纯 reducer 中迁移，Worker Pool
  只在 `master/state.ts` 的 v5 schema 文件中持久化；两者的执行器（`review/index.ts`、
  `master/herdr.ts`）承担全部副作用。
- **配置坏 ≠ 用户关闭**：review/master 节有问题时拒绝启动并保留 checkpoint，修好重启继续；
  静默回退默认模型会拿用户没配的模型真实发起调用。
- **宿主耦合收口**：碰 pi 内部实现的只有 `tools/grouping.ts`（组件树 + 原型 patch），
  升级 pi 时优先检查这一处。
- **纯函数可测**：`statusbar/render.ts`、`tools/line.ts`、`review/state.ts` 等纯函数层
  被 `tests/` 直接覆盖，测试入口 `bun test agent/extensions/firecode/tests`。

端到端运行路径见 [data-flow.md](data-flow.md)。
