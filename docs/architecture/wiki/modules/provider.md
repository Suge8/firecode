---
sources:
  - agent/extensions/firecode/provider/claude-sub.ts 03508d39cc7e registerClaudeSub shouldApply buildBillingHeader detectClaudeCodeVersion before_provider_request
  - agent/extensions/firecode/provider/openai-native/index.ts a678cad4eee9 registerOpenAINative CONFIG_PATH loadConfig
  - agent/extensions/firecode/provider/openai-native/src/extension.ts ae8e5e0f857a openAINativeExtension VERBOSITY_FLAG toggleFastMode session_before_compact updateFastStatus
  - agent/extensions/firecode/provider/openai-native/src/request-pipeline.ts ed2089566058 rewriteOpenAIProviderRequest replayOpenAINative applyOpenAIOptions
  - agent/extensions/firecode/provider/openai-native/src/config.ts 65b3f6333305 loadOpenAINativeSettings togglePriority replaceKeyedObject openaiRoot withConfigLock
  - agent/extensions/firecode/provider/openai-native/src/options.ts 8cc7c3f66613 applyOpenAIOptions supportsFastMode fastModeEnabled PRIORITY_MODEL_IDS FAST_STATUS_KEY
  - agent/extensions/firecode/provider/openai-native/src/native-compaction.ts 3025e1abc3ae compactWithOpenAINative replayOpenAINative executeNativeCompaction resolveLatestNativeCompaction resolveNativeCompactionRuntime
  - agent/extensions/firecode/provider/openai-native/src/native-replay.ts e754f172d8bb rewriteNativeResponsesPayload extractFreshPreamble expected-pi-replay-mismatch serializeLiveTailToResponsesInput
---

# Provider 请求层

## 职责

provider/ 是 FireCode 唯一改写出站模型请求的地方，两个互不相干的扩展共用 pi 的
`before_provider_request` 钩子：`claude-sub.ts` 给 Anthropic OAuth 会话补 Claude Code 归因，
`openai-native/` 管 OpenAI 系的 verbosity、加速档（service_tier=priority）与可选的原生压缩。
二者都由入口按 `config.features` 决定是否注册（见 [core.md](core.md)、[../system.md](../system.md)）。

模块内部分工：`openai-native/index.ts` 只是薄适配，把根 `config.ts` 的 `CONFIG_PATH` 与
`loadConfig().config.keys.fast` 喂给 `openAINativeExtension`；`src/extension.ts` 承担全部宿主接线；
`src/request-pipeline.ts` 编排请求改写；`src/native-*.ts` 与 `src/compact-client.ts` 实现原生压缩；
`src/responses-input.ts` 收口消息 ↔ Responses input 的双向序列化，被压缩与 replay 共用，
保证两条路径产生同构的 input。

## 对外接口

**`registerClaudeSub(pi)`**（claude-sub.ts）：注册后做两件事——用
`pi.registerProvider("anthropic", …)` 静态挂上 `user-agent: claude-cli/<版本>` 与 `x-app: cli`
两个请求头；再在 `before_provider_request` 里往 system 数组首位插一个以
`x-anthropic-billing-header:` 开头的文本块。生效条件由 `shouldApply` 收口：当前模型是 anthropic
供应商且 `modelRegistry.isUsingOAuth` 为真才改写，API Key 会话原样通过。环境变量
`PI_CLAUDE_CODE_VERSION` / `PI_CLAUDE_CODE_ENTRYPOINT` / `PI_CLAUDE_OAUTH_LOG_FILE` 等是调试覆盖口。

**`registerOpenAINative(pi)`**（openai-native/index.ts → extension.ts）：注册 `--verbosity` 标志
（`VERBOSITY_FLAG`，覆盖配置里的 textVerbosity）、`/fast` 命令与加速档快捷键（默认 `ctrl+f`，
来自根 config 的 `keys.fast`）。加速档开启且当前模型支持时，`updateFastStatus` 写状态项
`⚡ fast`（键 `FAST_STATUS_KEY`），`model_select` 重算、`session_shutdown` 清除。

**压缩条目 details 契约**（native-details.ts）：原生压缩写进会话的压缩条目 details 固定为
`strategy: "openai-native-compact"` + 身份四元组（provider/api/model/baseUrl）+
`compactedWindow` 数组 + `createdAt`。该文件同时提供逐字段校验（`isNativeCompactionDetails`）
与结构化克隆——会话文件里的 details 是外部输入，读回来必须验；身份不匹配或校验失败即放弃接管。

## 数据怎么流

### before_provider_request 两条改写路径

Anthropic 路径（claude-sub.ts）：`buildBillingHeader` 拼出的版本号 = 检测到的 Claude Code 版本 +
`versionSuffix` 派生的三位后缀，后者对首条 user 文本的固定下标采样再哈希，同一会话稳定。
版本来自 `detectClaudeCodeVersion`：环境变量优先，其次实测 `claude --version`（1 秒超时），
都没有则用文件内的回退常量——本机没装 Claude Code 不阻塞启动。幂等性靠首块前缀判断：system
里已有 billing 块就直接返回，不叠加；改写返回新 payload，不原地改宿主对象。日志文件存在时
把注入内容按行追加成 JSONL，写失败静默。

OpenAI 路径（request-pipeline.ts 的 `rewriteOpenAIProviderRequest`）：先在开启原生压缩时用
`replayOpenAINative` 把 payload 换成压缩窗口版本（返回 undefined 就保留原 payload），再用
`applyOpenAIOptions` 套 verbosity 与 service_tier。options.ts 定义两条能力边界：verbosity
只加给 Responses API 模型（`openai-responses` 与 `openai-codex-responses`），写进
`payload.text.verbosity`，非法值当作未设置；加速档 `supportsFastMode` 对 xai 全放行，对 OpenAI
只认 `PRIORITY_MODEL_IDS` 白名单，`fastModeEnabled` 再叠加供应商配置的 `priority`，满足才写
`service_tier: "priority"`。两处改写都是写前比对，已是目标值就不复制对象；payload 未变时
extension.ts 返回 undefined，避免无谓复制。

### session_before_compact 压缩三段流

`nativeCompaction` 关闭时钩子返回 undefined，宿主走默认压缩。开启后由
`compactWithOpenAINative`（native-compaction.ts）编排：

**触发取材。** `resolveNativeCompactionTarget` 判定当前模型是否 openai/openai-codex +
Responses API 且有 baseUrl，不匹配返回 undefined 交还宿主；`resolveNativeCompactionRuntime`
再向 modelRegistry 取 apiKey 与 headers，取不到就 `cancel` 并报错——不静默降级。取材分两种：
`resolveLatestNativeCompaction` 找到上一次本扩展写的压缩条目时，用它的 `compactedWindow` 加上
`serializeLiveTailToResponsesInput` 序列化的增量尾巴；没有任何压缩时用 `buildSessionContext`
的完整消息序列化成请求。上一次压缩不是本扩展写的、或身份四元组不匹配，则放弃接管。

**压缩调用。** `compact-client.ts` 的 `executeNativeCompaction` 直接向 `responsesUrl` POST，
`input` 末尾追加 `{ type: "compaction_trigger" }`，`store: false`、`stream: true`；响应兼容
整段 JSON 与 SSE 两种形态，openai-codex 额外补 `chatgpt-account-id`（从 JWT 解出）等归因头。
输出里必须恰好一个 `type: "compaction"` 项，否则算失败；成功时按约 64k token 预算从尾部回收
user/developer/system 消息，与压缩项一起组成新的 `compactedWindow`。失败分类（`non-2xx`、
`empty-body`、`malformed-response`、`network-error` 等）转成用户可见错误，`aborted` 静默取消。

**落盘 replay。** 窗口连同身份四元组按 details 契约写成压缩条目。之后每次请求经
`replayOpenAINative` → `rewriteNativeResponsesPayload`（native-replay.ts）：先用
`extractFreshPreamble` 剥出首尾的 developer/system 提示包裹，再按 pi 自己的序列化规则重算一份
「期望 payload」，与宿主实际给的 `input` 深比较；不一致就以 `expected-pi-replay-mismatch`
放弃改写、原样发出。只有确认宿主拼法与预期一致，才用 `compactedWindow` 替换压缩点之前的
全部内容，保留其后的实时尾巴。

### /fast 写回 config

`/fast` 与快捷键触发 `togglePriority`（src/config.ts）：在 `<config>.lock` 文件锁内读—改—写，
`replaceKeyedObject` 只替换 `openai` 这一段文本以保住 jsonc 注释，再经临时文件 + rename 原子
覆盖。切换成功后扩展内的 settings 立刻更新，无需重启；写失败弹错误通知。读取侧
`loadOpenAINativeSettings` 经 `openaiRoot` 取 `openai` 子节（根对象没有该键时把整个文件当设置，
供独立单测用），字段类型不对只记 warning 并回退默认（`nativeCompaction: false`、空 providers），
首条 warning 在 `session_start` 提示一次，不阻塞会话。

## 改动指南

先看的文件：动宿主接线（钩子、命令、状态项）改 `src/extension.ts`；动请求改写顺序改
`src/request-pipeline.ts`；动压缩流程从 `src/native-compaction.ts` 入手，HTTP 细节在
`src/compact-client.ts`，replay 校验在 `src/native-replay.ts`，details 契约在
`src/native-details.ts`；动配置读写改 `src/config.ts`。测试在 `src/*.test.ts` 与 `test/`
（含 native-runtime 单测与 pi 冒烟测试）。

常见坑：

- **压缩改写必须在选项改写前**：`replayOpenAINative` 整体重建 `input` 数组，而
  `applyOpenAIOptions` 只动顶层字段；调换顺序会让选项写在被丢弃的旧 payload 上。
- **replay 深比较是安全阀，不是冗余**：`expected-pi-replay-mismatch` 分支保证 pi 侧序列化规则
  变化时 replay 自动失效退回原样发送，而不是发出拼错的上下文。改 `responses-input.ts` 的
  序列化必须同时想到压缩与 replay 两个消费方。
- **openai 节容错与根 config 严格策略相反**：根 `config.ts` 对 review/master 节报配置问题即
  拒绝启动（错配会拿错模型真实发起调用），而这里错配至多少一个请求字段，故只 warning 回退默认。
  不要把两侧策略拉齐。
- **文件锁的夺锁语义**：锁文件记 pid，`withConfigLock` 发现持锁进程已死才夺锁重建，活进程持锁
  时直接抛错。改锁逻辑要保住"多 pi 进程并发 `/fast` 不互相覆盖"这一前提。
