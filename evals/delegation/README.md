# 委派评测

开发工具，不属于插件、不进 `bun test`（脚本都不叫 `*.test.ts` / `*.spec.ts`，bun 不会扫到；新增文件也别这样命名）。
用来回答两个问题：改了指挥官提示词里的“委派条款”之后，主会话面对不同请求时的决策（亲手 / 委派 / 并行委派）、耗时、花费和产出质量有没有变好；以及某个角色该配哪个模型原子（`worker.ts`，见“角色选型”）。

## 前提

- 真实调用模型，**花真钱**；t3 要联网。需要 `bun`、`git`。
- `pi`：默认用 PATH 里的；设了 `PI_PACKAGES_DIR`（与 `tests/loader.ts` 同一个变量，指向 pi-mono 的 `packages/`）就改跑那份源码的 `coding-agent/src/cli.ts`。
- 你自己的 Agent 目录（`PI_CODING_AGENT_DIR`，没设则 `~/.pi/agent`）里要有认证、设置、模型表，以及 `extensions/firecode/config.jsonc`（Master 激活、角色表）。变体的临时 Agent 目录只把这些**符号链接**回去，不复制凭据；默认模型、codemode only 等设置沿用你的（`--model` 时 settings 与 config.jsonc 改为各存一份，见下）。`worker.ts` 的 impl 验收还要能定位 pi-mono 源码（同 `tests/loader.ts`）。
- 被测代码取**已提交**的内容（`git archive`）；未提交的提示词改动用 `--prompt-file`。评测任务是中文，变体替换的是 `master.zh.md`：配置的 `language` 须为 `zh`（或系统语言为中文），否则变体加载的是未被替换的英文提示词。
- 工作目录 `$EVAL_DIR`，默认 `<系统临时目录>/firecode-delegation-eval`：变体、fixture、全部运行记录都在这里，仓库里不留任何产物。

## 怎么跑

以下命令都在仓库根目录执行，先 `D=evals/delegation`。

```bash
bun $D/variant.ts A                                     # 变体 A：当前 HEAD 的代码与提示词
bun $D/variant.ts B --prompt-ref 74d9c01                # 同一份代码，只换提示词（取某个提交里的 master.zh.md）
bun $D/variant.ts C --prompt-file /path/to/master.md    # 或取文件；--cut '原文' 再删掉其中一段（须恰好出现一次）
bun $D/variant.ts H --model anthropic/claude-haiku-5-5/low   # 主会话与全部角色、审查、观察员都换成这个原子（冒烟用，见下）

bun $D/decide.ts A                                      # 首步决策（一次一个变体）：t1–t8 各 2 次，到决策即止
bun $D/decide.ts A --tasks t4-longwait --runs 1         # 只跑某几条
bun $D/decide.ts report A                               # 只重打汇总表

bun $D/run.ts A,B --runs 3 --budget 40                  # 跑到完成：t3 / t7 / t9-big，变体同批交错；超 $40 即停
bun $D/summary.ts                                       # 汇总每次运行与（任务, 变体）均值

bun $D/blind.ts                                         # 盲评导出，见下
bun $D/check.ts t3|t7|t9 $EVAL_DIR/blind/X*.md          # 核对，见下
```

`variant.ts --code-ref <提交>` 指定被测的 firecode 代码（默认 HEAD）。`--model` 把变体的 settings（默认模型，并去掉 `enabledModels`：默认模型不在范围里时宿主会改用范围里的第一个）和 config.jsonc（角色表去 fallback、审查只留一个审查者、观察员）里的模型全部换成给定原子，其余沿用你的。两个变体只差一处提示词时，用 `diff` 比较各自 `$EVAL_DIR/variants/<名>/firecode/master/prompts/master.zh.md` 确认。

**便宜地验证脚本能跑通**（不测质量）：用上面的 `--model` 变体跑 `decide.ts H --runs 1`、`run.ts H --tasks t3-research --runs 1 --budget 3`、`worker.ts <同一个原子> --runs 1`，再依次 `summary.ts`、`blind.ts`、`check.ts`。Haiku low 这一套约 $0.6。要走到“指挥官派 Worker”的路径，用 `--prompt-file` 在提示词末尾加一句“调研一律派调研员”。

`run.ts` 其余参数：`--tasks`（默认 t3-research,t7-audit,t9-big，可加 t9-hand）、`--runs`（默认 3）、`--concurrency`（默认 2）、`--force`。已 settled 的结果会跳过，被预算打断的重跑会续上。`decide.ts` 参数：`--steps`（脚本数上限，超过判亲手，默认 5）、`--timeout`（秒，默认 300）。

## 机制

- **fixture** 按需生成在 `$EVAL_DIR/fixtures`，固定取提交 `b0fb416`（t7 缺陷清单与 T9 真值都绑定这份代码，不随 HEAD 漂移）。`base` 另加一个睡 15 分钟的 `scripts/e2e.sh`（t4 用）；`t9` 去掉全部测试、重建为单提交（无历史可查）、植入 14 处逻辑缺陷，真值与行号写到 `fixtures/t9-truth.json`。每次运行拿一份独立副本。
- **decide** 用探针扩展 `probe.ts` 记录所有工具调用（含 codemode 脚本内的嵌套调用），`subagents start` 只记录、拦截不执行，所以不会真起 Worker，也不花 Worker 的钱。亲手的操作真实执行在副本里。
- **run** 用 `pi --mode rpc` 发一条请求，等到主会话出现 `firecode-round`（主会话与全部 Worker 都歇下）。花费取主会话 + 全部 Worker 会话记录里的 usage。结束时按父子关系杀掉整棵进程树（pi 的 bash 工具把命令放进自己的进程组，只杀 pi 的组会留下孤儿）。
- 环境里去掉 `HERDR_*`，避免回写你的 herdr pane；不加载 cuepad-bridge、herdr-agent-state。

## 任务

| 任务 | 类型 | 理想首步 | 备注 |
| --- | --- | --- | --- |
| t1 / t2 | 一行改动 / 简单问答 | 亲手 | |
| t3 | 联网调研 Markdown 终端渲染库 | 委派调研员 | 完成跑；真值：npm registry |
| t4 | 跑 15 分钟的 e2e | 委派哨兵 | |
| t5 | 三件小工单（带测试） | 亲手 | 边界题，理想依据是用户提供的调研结论，未独立核实 |
| t6 | 三处文案小改 | 亲手 | 对照“并行”条款会不会被滥用 |
| t7 | 审计 `review/` | 并行委派 | 完成跑；真值：16 条已核实缺陷（`tasks.ts` 的 `T7_TRUTH`，非穷举） |
| t8 | 单模块实现 | 亲手 | |
| t9-big | 六目录审计（约 1.06 万行，14 处植入缺陷） | 无预设 | 完成跑；真值：`t9-truth.json` |
| t9-hand | 同上，末尾加“完全亲手” | — | 亲手基线 |

任务原话与理想决策只在 `tasks.ts`；改理想只改它再 `decide.ts report`，不用重跑。

## 花费与耗时

一个变体跑 t3 / t7 / t9-big 各 3 次约 $20–30（单次 t3 $0.6–1.5、t7 $1.7–3.3、t9-big $2.9–6.3，t9-big 最长约 18 分钟）；`decide.ts` 全套 t1–t8 ×2 约 $5。务必带 `--budget`。

## 并发与隔离

- 每次运行独立的仓库副本、会话目录和 `TMPDIR`；但 `TMPDIR` 只是环境变量，**拦不住命令里写死的 `/tmp/xxx`**。t3/t7 的 Worker 爱写 `/tmp/mdeval`、`/tmp/fc-audit*.ts` 这类路径，同时跑会互相覆盖或误删，所以带 `serial` 的任务单独走一条串行通道（与其它任务并行，总并发 = `--concurrency` + 1）。t9 的任务文本要求临时文件只放 `TMPDIR`，仍可能违反。
- 跑完用 `bun $D/check.ts iso` 扫一遍：被多个运行共用的写死路径要人工看是不是真有串扰。
- 共享你的真实凭据与 settings（符号链接）；令牌刷新经 pi 自己的锁。并发太高会触发限流、拖慢墙钟，墙钟对比务必让各变体**同批交错**（`run.ts A,B,C`）。
- 模型偶尔会跳出副本去 grep 整个 `~/Project`（冒烟里见过一次，拖满 300 秒超时）：这是噪声，不是脚本问题；`decide.ts` 里表现为 `亲手†`。

## 盲评

分组身份会影响判断，所以先去标识再核对：

1. `bun $D/blind.ts` 把 t3/t7/t9 的最终报告打乱编号写到 `$EVAL_DIR/blind/`（X=t3、Y=t7、Z=t9），t3/t7 报告里“我派了几个调研员”之类的叙述行会被去掉；编号到变体的映射写在 `$EVAL_DIR/blind-map.json`，**打完分之前不要打开**。
2. 核对（输出只是候选，仍须人读报告确认）：
   - t3：`check.ts t3` 把表里的版本与发布日期对 npm registry；依赖数、表格/高亮支持要实测（唯一抓到的事实错误是 markdown-it-terminal 遇表格会抛错，只有没渲染实测的报告标错）。
   - t7：`check.ts t7` 按关键词预筛覆盖了 16 条里的哪几条，逐条读报告确认。报告里新出现的条目要回代码核实，成立就加进 `T7_TRUTH` 并重数旧报告。
   - t9：`check.ts t9` 列出指到“同文件且行号相差 ≤5”的植入缺陷；其余的人读确认是否说清缺陷。每份报告另有的 16–31 条其他条目不计命中，精度没测。
3. 打完分再读映射，对回变体。

## 角色选型

新模型发布或某家额度变化时，用 `worker.ts` 决定角色表里的原子。它把每个原子直接当 Worker 跑（带 `worker.zh.md`，firecode 只开 claudeSub），不经指挥官，所以只比模型本身：

```bash
bun $D/worker.ts anthropic/claude-haiku-5-5/low,anthropic/claude-sonnet-5-5/medium --tasks audit,research --runs 2
bun $D/worker.ts report
```

| 组 | 任务 | 判分 |
| --- | --- | --- |
| audit | t9 fixture 的两块（master/+format.ts 8 处、session/statusbar/watcher 5 处植入缺陷） | 自动：指到植入行 ±5；漏指行号的人读 |
| research | 同 t3 | 人读，版本日期用 `check.ts t3 <final.md…>` |
| wait | 2 分半 e2e、后台部署盯到终态 | 自动：失败场景与原因原文 |
| impl | formatDuration 进位到天；quota 8 秒超时 | 前者隐藏断言自动判，后者读 diff 与测试 |

结果在 `$EVAL_DIR/worker/<任务>__<原子>__<第几次>/`（`final.md`、`result.json`、`repo/`），已跑完的跳过。
