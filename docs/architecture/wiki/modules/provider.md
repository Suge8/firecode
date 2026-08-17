---
sources:
  - agent/extensions/firecode/provider/claude-sub.ts 03508d39cc7e registerClaudeSub before_provider_request PI_CLAUDE_CODE_VERSION
  - agent/extensions/firecode/provider/openai-native/index.ts a678cad4eee9 registerOpenAINative
  - agent/extensions/firecode/provider/openai-native/src/extension.ts ae8e5e0f857a openAINativeExtension VERBOSITY_FLAG session_before_compact
  - agent/extensions/firecode/provider/openai-native/src/config.ts 65b3f6333305 loadOpenAINativeSettings togglePriority providerSettings TextVerbosity
  - agent/extensions/firecode/provider/openai-native/src/options.ts 8cc7c3f66613 FAST_STATUS_KEY supportsFastMode fastModeEnabled applyOpenAIOptions
  - agent/extensions/firecode/provider/openai-native/src/request-pipeline.ts ed2089566058 rewriteOpenAIProviderRequest
  - agent/extensions/firecode/provider/openai-native/src/native-compaction.ts 3025e1abc3ae compactWithOpenAINative replayOpenAINative
  - agent/extensions/firecode/provider/openai-native/src/compact-client.ts 9ebb92df1f02 executeNativeCompaction
  - agent/extensions/firecode/provider/openai-native/src/native-details.ts 3271dd205847 NATIVE_COMPACTION_STRATEGY resolveLatestNativeCompaction isNativeCompactionDetails
  - agent/extensions/firecode/provider/openai-native/src/native-replay.ts e754f172d8bb rewriteNativeResponsesPayload serializeLiveTailToResponsesInput
  - agent/extensions/firecode/provider/openai-native/src/native-runtime.ts 2639c790f88e resolveNativeCompactionTarget resolveNativeCompactionRuntime
---

# Provider 请求层

## 职责

这是 FireCode 唯一在「请求即将发出去」那一刻动手的地方：模型和会话内容都已由宿主准备好，本层只在发出前按供应商补几样宿主不会补的东西，补完就退场。

它管三件事。第一件是身份：用 Anthropic 订阅登录（OAuth）跑的会话，按 Claude Code 官方客户端的格式补上归因信息，否则这些请求在服务端不会被认成订阅用量。第二件是发挥档位：OpenAI 系可以指定回答的详略程度，OpenAI 与 xAI 可以整体切到加速通道，加速档是每个供应商各自记住的开关，底部状态栏会显示当前是否处于加速档。第三件是上下文压缩：默认走宿主自带的压缩；打开开关后改用 OpenAI 自己的压缩能力，把长会话交给服务端浓缩成一份紧凑窗口，之后每次请求都用这份窗口替换掉宿主重放的那段旧历史。

三件事互不依赖，任何一件不满足条件都原样放行请求，不改写、不报错、不阻塞对话。压缩失败是唯一会打断动作的情况——此时它取消这次压缩并把原因告诉用户，而不是悄悄退回宿主压缩，因为两种压缩产出的会话结构不一样，静默换道会让后续重放对不上。

## 对外接口

两个注册入口，均由 `index.ts` 按 `config.features` 调用：

- `registerClaudeSub`（`provider/claude-sub.ts`）：给 `anthropic` 注册固定的 `user-agent` / `x-app` 头，并在 `before_provider_request` 钩子里判断当前模型是否为 Anthropic + OAuth，是则在系统提示词块首插入一条 `x-anthropic-billing-header:` 文本块；已存在则原样返回。版本号取自本机 `claude --version`，可用 `PI_CLAUDE_CODE_VERSION`、`PI_CLAUDE_CODE_ENTRYPOINT`、`PI_CLAUDE_CODE_WORKLOAD` 覆盖，`PI_CLAUDE_OAUTH_LOG_FILE` 可落调试日志。
- `registerOpenAINative`（`provider/openai-native/index.ts`）：把 FireCode 的 `config.jsonc` 路径与 `keys.fast` 传给 `openAINativeExtension`（`src/extension.ts`），后者装配全部 OpenAI 侧行为。

`openAINativeExtension` 对宿主暴露：`--verbosity` 标志（`VERBOSITY_FLAG`）、`/fast` 命令与可配置快捷键（默认 `ctrl+f`），并挂 `session_start`、`model_select`、`session_before_compact`、`before_provider_request`、`session_shutdown` 五个钩子；状态栏槽位键是 `options.ts` 的 `FAST_STATUS_KEY`。

内部分工：

| 文件 | 关键导出 | 作用 |
| --- | --- | --- |
| `src/config.ts` | `loadOpenAINativeSettings` `togglePriority` `providerSettings` `TextVerbosity` | 读 `config.jsonc` 的 `openai` 节（`nativeCompaction` + `providers`），字段非法只记 warning 不抛；写回时加 pid 锁、只替换 `openai` 这一个对象再原子改名，保留其余注释 |
| `src/options.ts` | `supportsFastMode` `fastModeEnabled` `applyOpenAIOptions` | 加速档能力判定（xAI 全支持，OpenAI Responses 限 `PRIORITY_MODEL_IDS` 白名单）；写 `text.verbosity`（仅 Responses API）与 `service_tier: "priority"` |
| `src/request-pipeline.ts` | `rewriteOpenAIProviderRequest` | 请求改写的单一入口：先原生压缩重放，再套 verbosity / priority |
| `src/native-compaction.ts` | `compactWithOpenAINative` `replayOpenAINative` | 压缩与重放两条流程的编排 |
| `src/native-runtime.ts` | `resolveNativeCompactionTarget` `resolveNativeCompactionRuntime` | 供应商 / API / baseUrl / payload 形状校验，以及从 `modelRegistry.getApiKeyAndHeaders` 取凭据 |
| `src/compact-client.ts` | `executeNativeCompaction` | 直接 `fetch` Responses 端点（`store:false`、`stream:true`、input 末尾追加 `compaction_trigger`），解析 JSON 或 SSE，产出压缩窗口 |
| `src/native-details.ts` | `NATIVE_COMPACTION_STRATEGY` `isNativeCompactionDetails` `resolveLatestNativeCompaction` | 压缩 checkpoint 的结构定义、校验与「最近一次本策略压缩」的定位 |
| `src/native-replay.ts` | `serializeLiveTailToResponsesInput` `rewriteNativeResponsesPayload` | 会话条目转 Responses input；核对宿主重放并替换其中的历史段 |
| `src/responses-input.ts` | `serializeMessagesToCompactRequest` `serializeMessagesToResponsesInput` | Pi 会话消息到 Responses input 的转换器（Pi 未导出，本模块自持一份） |

## 数据怎么流

Anthropic 一侧只有一条直路：请求出发前检查当前模型是不是订阅登录的 Anthropic，是就把归因文本块放到系统提示词最前面，其中携带一个由首条用户消息几个固定位置的字符与版本号算出的短后缀。其余情况一律不动。

OpenAI 一侧有两条流。

**压缩流**在宿主准备压缩时启动。先确认当前模型确实是支持原生压缩的那类供应商并能拿到凭据，拿不到就取消压缩并提示。接着决定送什么给服务端：如果本会话此前已经做过一次同款压缩，就拿那次的紧凑窗口，再补上从那次之后新长出来的对话尾巴；如果从没压缩过，就把整段会话序列化后送出。服务端返回的结果里必须恰好有一份压缩产物，否则视为失败；成功则把这份产物连同「回收了哪些近期消息」一起写进会话的压缩记录，同时记下产出它的供应商、接口、模型和服务地址。

**重放流**在此后每次请求出发时启动。它先找到最近一次压缩记录，并核对记录上的身份与当前模型完全一致——换了模型或换了服务地址就放弃改写，因为那份紧凑窗口属于另一个服务端。然后它按同样规则从会话重新拼一遍宿主应该发出的内容，与手上这份请求逐项比对：只有完全对得上，才敢把其中「压缩之前那段历史」整体换成紧凑窗口，保留前后的提示词外壳和压缩点之后的新对话。任何一处对不上就整体放弃改写，让原请求照常发出。这个比对是重放的安全阀：它把「宿主怎么组织上下文」这个假设变成每次都要现场验证的事实，宿主改了排布只会退化成不压缩，不会发出一份错位的上下文。

改写完成后，同一条请求继续过详略与加速档：详略只写给 OpenAI Responses 接口，命令行标志优先于配置；加速档要求模型在支持名单里且该供应商的开关是开的，才写入优先通道字段。两者都只在值确实需要变化时才复制对象，否则原样返回，宿主据此判断是否有改写发生。

加速档开关翻转时改的是配置文件本身：读、翻、只重写那一个配置节、写临时文件再原子改名，全程持有一把带进程号的锁，锁主进程已死则夺锁。所以状态是持久的，多个会话看到同一份。

## 改动指南

- **加速档模型白名单是硬编码的**：`options.ts` 里的 `PRIORITY_MODEL_IDS` 只列了几个 gpt-5.x id，xAI 则整体放行。新模型上线不改这里，`/fast` 会提示「当前模型不支持加速档」——这是最常见的"功能失灵"来源。
- **verbosity 只对 Responses API 生效**：`applyOpenAIOptions` 显式跳过 xAI Completions，因为那边没有这个字段；给 xAI 配 `textVerbosity` 不会报错，只是无效。
- **重放的比对是全等比对**：`rewriteNativeResponsesPayload` 用 `expected-pi-replay-mismatch` 兜底。升级 pi 后若原生压缩"突然不生效"，先看这个分支——宿主改了上下文拼装顺序即会静默退化。同理，压缩记录的身份四元组（provider/api/model/baseUrl）任一不符都会被 `resolveLatestNativeCompaction` 判为 mismatch。
- **压缩失败必须显式取消**：`native-compaction.ts` 的失败路径返回 `{ cancel: true }` 而非 `undefined`。不要"改成回退宿主压缩"——宿主压缩写入的 details 不是本策略格式，之后的重放会一路 mismatch，等于永久关掉原生压缩且用户不知情。
- **配置写回不能整文件重序列化**：`config.ts` 的 `replaceKeyedObject` 靠括号配对只替换 `openai` 节，为的是保住 `config.jsonc` 里的注释。改这里要同时想到单测场景——它也支持不带 `openai` 外壳的独立配置文件。
- **配置错误只降级不阻断**：`loadOpenAINativeSettings` 把非法字段收成 warnings，`session_start` 只弹第一条。这与 review / master 节「配置有问题就拒绝启动」的策略相反，是有意的：这里的错配最多丢一个可选优化，不会拿错模型发起真实调用。
- **Codex 的压缩请求头是手搓的**：`compact-client.ts` 绕过宿主 provider 层直接 `fetch`，自己补 `chatgpt-account-id`（从 access token 的 JWT claim 解出）、`originator`、`openai-beta`。宿主那边改了 Codex 鉴权方式，这里不会自动跟上。
- **服务端返回同时支持 JSON 与 SSE**：`parseSseOutput` 在没有 `response.completed` 输出时会退回收集到的 `response.output_item.done` 项。放宽解析前先确认失败原因，`missing-compaction`（压缩产物不是恰好一份）和 `malformed-response` 是两类不同故障。
- **测试**：`bun test agent/extensions/firecode/provider/openai-native`，用例在 `src/*.test.ts`（config / options / native-details / native-compaction / compact-client）与 `test/`（native-runtime、pi-smoke）。`claude-sub.ts` 无单测，改动需实跑一次 Anthropic OAuth 会话验证。
