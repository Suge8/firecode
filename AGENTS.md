# FireCode

pi 扩展。入口 `index.ts` 按 `config.features` 逐个调 `registerX(pi)`；各文件的职责与契约在头注释。

## 什么时候读什么

- 改 `master/`：先读 [master/AGENTS.md](master/AGENTS.md)。
- 改 README 的标语或两张表、改官网：[site/AGENTS.md](site/AGENTS.md)。
- 改指挥官的委派条款：[evals/delegation/README.md](evals/delegation/README.md)。
- 写文案、起名：[WORDS.md](WORDS.md)。

## 约束

- 主会话里发给模型的消息只经 `deliver.ts`；纯展示记录用宿主 CustomEntry。
- 系统提示注入写进 `before_agent_start` 的 `systemPromptOptions.sections`，不返回 `systemPrompt`：返回值会让宿主整段替换系统提示，任何一段变化都重写整个已缓存前缀。
- 进程内事件频道各只有一个定义处和一个发布者（`busy.ts`、`round.ts`、`master/roster.ts`），读者用它们导出的读法，不自己订阅。
- 读宿主私有字段只在 `tools/host.ts`。
- 配置有问题时，对应功能拒绝启动或整节不生效，不回退默认模型：回退会拿用户没配的模型真实发起调用。只读 Pi Agent 目录下的那一份运行配置，不读项目级配置。
- 默认快捷键避开宿主的全部默认键位（宿主不分上下文逐键比对，`tests/config-seam.test.ts` 守）。宿主已有键位的动作挂它的编辑器动作，不注册快捷键。
- `config.example.jsonc` 首次启动时原样写给所有用户：注释、角色名与角色 `use` 用英文；代码与提示词不点具体角色名。改完本机运行配置后，把属于推荐配置的部分同步进模板。
- `bun run typecheck` 另跑 `scripts/deps.ts` 的禁用写法与依赖规则，修法在报错里。

升级 pi 时：改 `scripts/pi-source.ts` 的 `PI_VERSION`，再 `rg "升级 pi"` 逐处核对注释里列的宿主依赖。

## 文案

用户与模型可见的文字都进所在目录的 `messages.ts`，中英同时提供；代码注释用中文。提示词按语言分文件（`prompts/<name>.zh.md`、`<name>.en.md`），改一边同步另一边。语言在模块加载时定下，调用处不传。测试固定为中文，英文行为在 `tests/i18n.test.ts` 验。

README 只写给用户；开发者与 agent 才需要的事实写在这里、配置模板注释或头注释。

## 测试

```bash
bun run setup
bun test
bun run typecheck
```

- 生产代码没有只为测试开的注入口：测试走真实的子会话池，供应商用 faux（`tests/faux-host.ts`），要缩短等待只改池的 `timing`。
- `pi-smoke` 用例加载 `dist/`，先 `bun run build`。
- CI 约 1 分钟：推送后前台跑 `gh pr checks <编号> --watch --fail-fast` 等到终态。
- 发版时读 [CONTRIBUTING](.github/CONTRIBUTING.md)。
