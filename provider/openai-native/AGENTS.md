# pi-openai-native

- `index.ts` 是唯一 Pi 插件入口；请求顺序固定为 native replay → OpenAI options。
- `nativeCompaction` 与 provider 的 `textVerbosity`/`priority` 只从入口旁 `config.json` 读取；修改后用 `/reload` 生效。
- Fast 快捷键为 `Ctrl+F`（`ctrl+f`）；`agent/keybindings.json` 已从 `tui.editor.cursorRight` 移除该键（方向键替代）。
- native compaction 仅支持 `openai`、`openai-codex`；`rc` 仅应用 Responses options。
- 不要改动 `openai-native-compact-v1` 或 checkpoint 校验；已有 session 依赖它。
- 验证：`cd agent/extensions/pi-openai-native && bun test`。
