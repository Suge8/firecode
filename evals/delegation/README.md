# 委派评测

开发工具，不属于插件、不进 `bun test`（脚本都不叫 `*.test.ts` / `*.spec.ts`，bun 不会扫到；新增文件也别这样命名）。
用来回答两个问题：改了指挥官提示词里的“委派条款”之后，主会话面对不同请求时的决策（亲手 / 委派 / 并行委派）、耗时、花费和产出质量有没有变好；以及某个角色该配哪个模型原子（`worker.ts`，见“角色选型”）。

## 前提

- 真实调用模型，**花真钱**；t3 要联网。需要 `bun`、`git`。
- `pi`：默认用 PATH 里的；设了 `PI_PACKAGES_DIR`（与 `tests/loader.ts` 同一个变量，指向 pi-mono 的 `packages/`）就改跑那份源码的 `coding-agent/src/cli.ts`。
- 你自己的 Agent 目录（`PI_CODING_AGENT_DIR`，没设则 `~/.pi/agent`）里要有认证、设置、模型表，以及 `extensions/firecode/config.jsonc`（Master 激活、角色表）。变体的临时 Agent 目录只把这些**符号链接**回去，不复制凭据；默认模型、codemode only 等设置沿用你的。
- 被测代码取**已提交**的内容（`git archive`）；未提交的提示词改动用 `--prompt-file`。评测任务是中文，变体替换的是 `master.zh.md`：配置的 `language` 须为 `zh`（或系统语言为中文），否则变体加载的是未被替换的英文提示词。
- 工作目录 `$EVAL_DIR`，默认 `<系统临时目录>/firecode-delegation-eval`：变体、fixture、全部运行记录都在这里，仓库里不留任何产物。

## 怎么跑

以下命令都在仓库根目录执行，先 `D=evals/delegation`。

```bash
bun $D/variant.ts A                                     # 变体 A：当前 HEAD 的代码与提示词
bun $D/variant.ts B --prompt-ref 74d9c01                # 同一份代码，只换提示词（取某个提交里的 master.zh.md）
bun $D/variant.ts C --prompt-file /path/to/master.md    # 或取文件；--cut '原文' 再删掉其中一段（须恰好出现一次）

bun $D/decide.ts A                                      # 首步决策（一次一个变体）：t1–t8 各 2 次，到决策即止
bun $D/decide.ts A --tasks t4-longwait --runs 1         # 只跑某几条
bun $D/decide.ts report A                               # 只重打汇总表

bun $D/run.ts A,B --runs 3 --budget 40                  # 跑到完成：t3 / t7 / t9-big，变体同批交错；超 $40 即停
bun $D/summary.ts                                       # 汇总每次运行与（任务, 变体）均值

bun $D/blind.ts                                         # 盲评导出，见下
bun $D/check.ts t3|t7|t9 $EVAL_DIR/blind/X*.md          # 核对，见下
```

`variant.ts --code-ref <提交>` 指定被测的 firecode 代码（默认 HEAD）；`--workers-codemode` 把 Worker 固定为启用 codemode（改的是变体副本里的 `master/run.ts`，配合 `run.ts --exclude-tools codemode` 测“指挥官不开 codemode”）。两个变体只差一处提示词时，用 `diff` 比较各自 `$EVAL_DIR/variants/<名>/firecode/master/prompts/master.zh.md` 确认。

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

每次运行的均值（见文末结论表的各版本）：t3 $0.6–1.5（均值 2.5–9 分钟）、t7 $1.7–3.3（5.5–8.5 分钟）、t9-big $2.9–6.3（5.5–12 分钟，单次最长 18 分钟）、t9-hand $3.8（约 9 分钟）。`decide.ts` 每次 $0.03–1.8，全套 t1–t8 ×2 约 $5。

一个变体跑 t3 / t7 / t9-big 各 3 次约 $20–30（A 30.7、B 19.1、C 20.9）；三个变体合计约 $60，务必带 `--budget`。

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

## 一次结论（2026-10-07，各格 n 见表）

A = `e70955e~1` 的旧条款；B = `b0fb416`（当时的 main）；C = `74d9c01`（动手边界改为：只有每块单独都要做很久才并行委派，几分钟能做完的亲手，按互不重叠的范围拆，派出的部分不再重做）；D = C 去掉“；你的 codemode 本身就能并行调工具、过滤输出”，且指挥官 `--exclude-tools codemode`、Worker 固定 codemode。A/B/C 代码都是 `b0fb416`，D 代码是 `74d9c01`。

```bash
bun $D/variant.ts A --code-ref b0fb416 --prompt-ref 'e70955e~1'
bun $D/variant.ts B --code-ref b0fb416
bun $D/variant.ts C --code-ref b0fb416 --prompt-ref 74d9c01
bun $D/variant.ts D --code-ref 74d9c01 --cut '；你的 codemode 本身就能并行调工具、过滤输出' --workers-codemode
```

| 任务 | 指标 | A | B | C | D |
| --- | --- | --- | --- | --- | --- |
| t1 t2 t4 t5 t6 t8 | 首步决策符合理想 | 12/12 | 12/12 | 12/12 | 未测 |
| t3 调研 | n | 3 | 3 | 3 | 2 |
| | 决策 | 亲手 3/3 | 派 3/3 | 亲手 3/3 | 亲手 2/2 |
| | 墙钟 s | 304 | 528 | 152 | 187 |
| | 花费 $ | 0.63 | 1.54 | 0.69 | 0.63 |
| | 质量 | 版本日期全对，1 处表格支持判断错 | 全对 | 全对 | 全对 |
| t7 审计 | n | 3 | 3 | 3 | 2 |
| | 决策 | 亲手 1、派 3 个 ×2 | 派 3/3 | 亲手 3/3 | 亲手 2/2 |
| | 墙钟 s | 513 | 333 | 339 | 371 |
| | 花费 $ | 3.26 | 1.91 | 1.72 | 1.74 |
| | 真实缺陷（/16） | 8.3 | 6.3 | 8.0 | 8.0 |
| t9-big | n | 3 | 3 | 3 | 2 |
| | 派出数 | 4、4、4 | 5、4、4 | 4、4、4 | 4、3 |
| | 墙钟 s | 705 | 333 | 743 | 715 |
| | 花费 $ | 6.33 | 2.90 | 4.57 | 4.83 |
| | 植入缺陷（/14） | 10.3 | 8.7 | 10.0 | 10.0 |
| t9-hand | n=2，用 C 条款 | 墙钟 524 s，花费 $3.84，命中 8.5/14 | | | |

读法与限制：

- 小任务三版没有区别；C 没有过度委派，t4 照样派哨兵。
- 几分钟能亲手做完的调研与审计：C 最好或并列最好；B 在 t3 上被拖慢 3.5 倍、贵 2.2 倍；A 在 t7 半途委派并重复读，最贵最不稳。
- t9（亲手约 9 分钟）三版都并行，结果被**角色选择**主导而不是条款：选调研员的 5 次均值 359 s、$3.18、命中 8.8，选工程师的 4 次均值 887 s、$6.37、命中 10.75。大任务上条款的优势没有被证据支持，只是没有劣势。
- D（指挥官不开 codemode）没有更快、没有更省，质量与 C 无区别：现有证据不支持为此改代码，也不支持“关掉有害”。
- n=2–3，区间很宽（C 的 t9 342–1068 s），不能谈比例；t9 的亲手基线没有达到“单人 20 分钟”的设计目标，没测到真正超大任务；D 与 C 不是同一批交错跑的；t7 真值非穷举；t9 精度没测；隔离是软的。

## 角色选型结论（2026-10-08，Haiku 5.5 发布当天，每格 n=2）

`worker.ts` 的数字（审计 = 两块合计命中 /13，花费与墙钟为每块均值）：

| 原子 | 审计命中 | 审计 $ / 墙钟 | 调研 $ / 墙钟 | 盯守 | 实现 $ |
| --- | --- | --- | --- | --- | --- |
| haiku-5-5/low | 8.0 | 0.06 / 254 s | 0.004 / 48 s | 4/4 | — |
| haiku-5-5/medium | 7.5 | 0.13 / 420 s | 0.010 / 108 s | 4/4 | 0.010（4/4 对） |
| haiku-5-5/high | 9.0 | 0.45 / 737 s | 0.028 / 255 s | — | 0.016（4/4 对） |
| sonnet-5-5/medium（实现为 high） | 10.0 | 0.60 / 228 s | 0.147 / 98 s | 4/4 | 0.118（4/4 对） |

- Haiku 联网调研与 Sonnet 一样准（8 份报告版本日期全对），盯守全对，规格明确的小实现全对；代码审计召回约为 Sonnet 的八成；省钱不省时间，读大量代码时不比 Sonnet 快。
- Haiku high 不划算：单次输入过 10 万 token 后单价 ×5，加上长思考，审计比 Sonnet medium 更慢更贵。low 与 medium 质量无差别，low 快一倍。
- Haiku 的测试写法弱于 Sonnet（真实等待 8 秒而非假定时器），实现成本约 1/10。
- 据此：调研员 haiku/low（搜索、查资料、读日志），哨兵 haiku/low，新增批量工 haiku/medium（规格明确可机械验收的批量改动），深读代码找缺陷改派工程师。

端到端（变体 R = 上述角色表，提示词同 C）：`decide.ts` 首步决策与 C 相同（t4 派哨兵，t3/t7 亲手）；t9-big n=3 全部派工程师，墙钟 931 s［566–1176］、$6.04、命中 10.7/14，与此前“派工程师”的 4 次（887 s、$6.37、10.75）一致，比派 Sonnet 调研员的 5 次（359 s、$3.18、8.8）多找约 2 处、慢约 2.6 倍。批量工没有对应任务，派单是否命中它未测。
