# 委派评测

维护者专用：需要维护者本机的登录凭据、会真实花钱，贡献者不需要跑。

开发工具，不属于插件、不进 `bun test`（脚本都不叫 `*.test.ts` / `*.spec.ts`，bun 不会扫到；新增文件也别这样命名）。
用来回答两个问题：改了指挥官提示词里的“委派条款”之后，主会话面对不同请求时的决策（亲手 / 委派 / 并行委派）、耗时、花费和产出质量有没有变好；以及某个角色该配哪个模型原子（`worker.ts`，见“角色选型”）。在真实会话上下文里比较提示词或工具改动用 `replay.ts`（见“真实会话重放”）。

## 前提

- 真实调用模型，**花真钱**；t3 要联网。需要 macOS（被测会话跑在 `sandbox-exec` 里，见“机制”）、`bun`、`git`。
- `pi`：默认用 PATH 里的；设了 `PI_PACKAGES_DIR`（与 `tests/loader.ts` 同一个变量，指向 pi-mono 的 `packages/`）就改跑那份源码的 `coding-agent/src/cli.ts`。
- 你自己的 Agent 目录（`PI_CODING_AGENT_DIR`，没设则 `~/.pi/agent`）里要有认证、设置、模型表，以及 `extensions/firecode/config.jsonc`（Master 激活、角色表）。变体的临时 Agent 目录只把这些**符号链接**回去，不复制凭据；默认模型、codemode only 等设置沿用你的（`--model` 时 settings 与 config.jsonc 改为各存一份，见下）。`worker.ts` 的 impl 验收还要能定位 pi-mono 源码（同 `tests/loader.ts`）。
- 被测代码取**已提交**的内容（`git archive`，不含 `evals/`）；未提交的提示词改动用 `--prompt-file`。评测任务是中文，变体替换的是 `master.zh.md`：配置的 `language` 须为 `zh`（或系统语言为中文），否则变体加载的是未被替换的英文提示词。
- 工作目录 `$EVAL_DIR`，默认 `<系统临时目录>/firecode-delegation-eval`：变体、fixture、全部运行记录都在这里，仓库里不留任何产物。

## 判新旧：改了什么 → 跑哪条命令

先 `D=evals/delegation`。每一行：候选和对照用同一条命令各跑一遍，再按判定规则比。噪声底是**同一配置自己重复跑**出的区间，差异落在区间里就是没差异，不得因一次跑出的差异下结论。

| 改了什么 | 命令 | 单次花费与耗时 | 噪声底（出处） | 判定 |
| --- | --- | --- | --- | --- |
| 指挥官提示词、委派条款、注入段、工具描述（首个动作变没变） | `bun $D/replay.ts run <变体> --runs 5 --budget 20`，再 `report <候选> --base <对照>` | 12 个时点 × 5 次约 $16（含冷写），单次 12–40 秒 | 原样继续每点 5 次，自身一致率 85%（2026-11-06，`compact-trigger/replay-report.md`） | 候选与对照多数动作的一致率 ≥ 对照自身一致率 − 6 点；低于线的点读“不一致”原文，确认没变差才算过 |
| 压缩触发点、压缩提示词、压缩后前缀（先压缩再继续） | `bun $D/replay.ts compact <变体>`，再 `run`、`report <变体> --base <对照>` | 每次压缩另花 $0.4–0.7（Opus 摘要）、40–130 秒；其余同上 | Opus 摘要每点 5 次自身一致率 72%（`compact-trigger/replay-report.md`） | 同上，线 = 对照自身 − 6 点（66%）；无一处决策变差 |
| 压缩摘要换模型 | `bun $D/replay.ts compact <变体> --summary-model <provider/模型/思考档>`，再 `run`、`report <变体> --base <Opus摘要变体>` | 每次压缩 Luna $0.005/42 秒、Haiku $0.009/30 秒、Terra $0.049/52 秒、Opus $0.445/85 秒 | Opus 摘要自身一致率 72%（`summary-model/REPORT.md`） | 同上，线 66%；摘要变体的 compact.json 另记花费与耗时 |
| 压缩摘要的写法（模型、思考档、verbosity、附加指令） | 每份摘要 `replay.ts compact <变体> [--summary-model …] [--instructions-file …]`，每个配置 3 份，再 `bun $D/detail.ts score 对照=a,b,c 候选=d,e,f` | 每份 12 个时点的压缩约 $0.1–0.6（随模型），评分不花钱；标准答案一次 `detail.ts gt` 约几美分/点 | 细节保住率（条目池）：Luna 3 份 32–34%，Haiku 3 份 45–48%（`summary-detail/REPORT.md`） | 比对照高 ≥ 10 点，且大于两边各自份间极差；其余一律无效。命令自动给“有效/更差/无效” |
| 影响整单亲手长任务的改动（上下文构成、工具输出、缓存） | `bun $D/run.ts <变体> --tasks t9-hand --runs 3 --budget 10` | $2.34–2.83、262–400 秒 | t9-hand 自身重复 $2.34–2.83、262–400 秒（`climb-log.md`） | 候选 3 次的花费、墙钟逐次对照区间：全落区间内 = 没差异；`check.ts t9` 的命中数不低于对照 |
| 同上，多轮长会话（上下文逐批长到 30 万以上） | `bun $D/run.ts <变体> --tasks t9-rounds --runs 3 --budget 14 --reserve 5` | $2.95–3.48、446–644 秒 | t9-rounds A 组（对照）自身 $2.95–3.48、446–644 秒（`context-mask` 下报告） | 同上 |
| 派活条款对完成跑的影响（调研、审计、六目录审计） | `bun $D/run.ts <变体[,变体…]> --runs 3 --budget 40`（默认 t3/t7/t9-big），再 `blind.ts` 盲评、`check.ts` 核对 | t3 $0.6–1.5、t7 $1.7–3.3、t9-big $2.9–6.3，最长约 18 分钟 | 未测：先把对照跑 3 次定区间 | 变体同批交错跑；花费、墙钟出区间且质量命中数（真值）不降 |
| 冷启动首步决策 | `bun $D/decide.ts <变体>` | 全套 t1–t8、t11 各 2 次约 $5，单次数秒到数分钟 | 两版提示词各 10 次决策完全一样（噪声为 0，但与真实会话对不上，所以只作粗筛） | `report` 的符合数下降才算退步 |
| 角色的模型原子 | `bun $D/worker.ts <原子[,原子…]> --tasks audit,research --runs 2`，再 `worker.ts report` | 随原子；单格见 `report` | 未测：同一原子每格重复 ≥ 3 次定区间 | 质量不降且墙钟或花费出区间 |
| 技能触发 | FriedBun 的 `evals/skill-trigger/`（搬家中） | | | 命令以后补 |

两类时点清单、标准答案含个人会话路径，不进仓库，放在仓库外：重放时点 `~/.cache/firecode-eval/context-mask/replay/points.json`（12 个，与 `summary-model/replay/points.json` 相同），命令用 `REPLAY_POINTS` 指过去；`EVAL_DIR` 另设一个临时目录放运行产物。细节保住率的标准答案在 `$EVAL_DIR/detail/gt/`，可直接用 `EVAL_DIR=~/.cache/firecode-eval/summary-detail` 读那份已造好的（同一批 12 个时点的 `compacted.jsonl` 须在 `$EVAL_DIR/replay/runs/<变体>/` 下）。

**从会话重新选点**（时点或会话变了，旧噪声底作废，须重测）：

```bash
export EVAL_DIR=$(mktemp -d)                              # 产物只写这里
bun $D/replay.ts scan --max-tokens 260000                 # 读你的 sessions/ → $EVAL_DIR/replay/candidates.json
REPLAY_POINTS=~/.cache/firecode-eval/my-points.json bun $D/replay.ts pick --count 12   # 6 组（项目 × 类型）各 2 个
bun $D/detail.ts gt                                       # 需要细节保住率时，先用 compact 造出至少一份摘要
```

**冒烟**（只验证命令能跑，不测质量）：整单、决策、角色类用下文“便宜地验证脚本能跑通”的 H 变体（另可加 `run.ts H --tasks t9-hand|t9-rounds --runs 1 --budget 1`）。重放、压缩与评分只跑 1 个时点：`REPLAY_POINTS` 指到只含这一个时点的文件，依次 `replay.ts run main --points <id> --runs 2`、`replay.ts compact C --points <id> --summary-model <完整原子>`、`replay.ts run C --points <id> --runs 2`、`replay.ts report C --base main`、`detail.ts gt --model <完整原子>`、`detail.ts score a=C b=C`，约 $1.3（时点 16 万 token，Opus 续跑两次占大头）。

## 怎么跑

以下命令都在仓库根目录执行，先 `D=evals/delegation`。

```bash
bun $D/variant.ts A                                     # 变体 A：当前 HEAD 的代码与提示词
bun $D/variant.ts B --prompt-ref 74d9c01                # 同一份代码，只换提示词（取某个提交里的 master.zh.md）
bun $D/variant.ts C --prompt-file /path/to/master.md    # 或取文件；--cut '原文' 再删掉其中一段（须恰好出现一次）
bun $D/variant.ts H --model anthropic/claude-haiku-5-5/low   # 主会话与全部角色、审查都换成这个原子（冒烟用，见下）

bun $D/decide.ts A                                      # 首步决策（一次一个变体）：t1–t8、t11 各 2 次，到决策即止
bun $D/decide.ts A --tasks t4-longwait --runs 1         # 只跑某几条
bun $D/decide.ts report A                               # 只重打汇总表

bun $D/run.ts A,B --runs 3 --budget 40                  # 跑到完成：t3 / t7 / t9-big，变体同批交错；超 $40 即停
bun $D/summary.ts                                       # 汇总每次运行与（任务, 变体）均值

bun $D/blind.ts                                         # 盲评导出，见下
bun $D/check.ts t3|t7|t9 $EVAL_DIR/blind/X*.md          # 核对，见下
```

`variant.ts --code-ref <提交>` 指定被测的 firecode 代码（默认 HEAD）。`--model` 把变体的 settings（默认模型，并去掉 `enabledModels`：默认模型不在范围里时宿主会改用范围里的第一个）和 config.jsonc（角色表去 fallback、审查只留一个审查者）里的模型全部换成给定原子，其余沿用你的。两个变体只差一处提示词时，用 `diff` 比较各自 `$EVAL_DIR/variants/<名>/firecode/master/prompts/master.zh.md` 确认。

**便宜地验证脚本能跑通**（不测质量）：用上面的 `--model` 变体跑 `decide.ts H --runs 1`、`run.ts H --tasks t3-research --runs 1 --budget 3`、`worker.ts <同一个原子> --runs 1`，再依次 `summary.ts`、`blind.ts`、`check.ts`。Haiku low 这一套约 $0.6。要走到“指挥官派 Worker”的路径，用 `--prompt-file` 在提示词末尾加一句“调研一律派调研员”。

`run.ts` 其余参数：`--tasks`（默认 t3-research,t7-audit,t9-big，可加 t9-hand、t9-rounds）、`--runs`（默认 3）、`--concurrency`（默认 2）、`--reserve`（一次运行的预留美元：已花加在跑再加一次预留超过 `--budget` 就不再开新的，免得被截成半截；有运行完成后改取最贵那次的 1.1 倍）、`--force`。已 settled 的结果会跳过，被预算打断的重跑会续上。`decide.ts` 参数：`--steps`（模型回合数上限，超过判亲手，默认 15）、`--timeout`（秒，默认 300）。

## 机制

- **fixture** 按需生成在 `$EVAL_DIR/fixtures`，固定取提交 `b0fb416`（t7 缺陷清单与 T9 真值都绑定这份代码，不随 HEAD 漂移）。`base` 另加一个睡 15 分钟的 `scripts/e2e.sh`（t4 用）；`t9` 去掉全部测试、重建为单提交（无历史可查）、植入 14 处逻辑缺陷，真值与行号写到 `fixtures/t9-truth.json`。每次运行拿一份独立副本。
- **decide** 用探针扩展 `probe.ts` 记录所有工具调用（含 codemode 脚本内的嵌套调用），`subagents start` 只记录、拦截不执行，所以不会真起 Worker，也不花 Worker 的钱。亲手的操作真实执行在副本里。
- **run** 用 `pi --mode rpc` 发一条请求，等到主会话出现 `firecode-round`（主会话与全部 Worker 都歇下）。花费取主会话 + 全部 Worker 会话记录里的 usage。结束时按父子关系杀掉整棵进程树（pi 的 bash 工具把命令放进自己的进程组，只杀 pi 的组会留下孤儿）。
- **隔离**：被测会话（主会话、Worker 及其全部子进程）跑在 `sandbox-exec` 里，整个 `$EVAL_DIR`、本仓库的全部 git 工作树与 `.git`、你 Agent 目录下的 `sessions/` 都不可读写，只放开本次运行目录、变体目录与 `host-modules`（`decide.ts` 另放开探针文件）。所以真值（`t9-truth.json`、`tasks.ts`、`fixtures.ts`、`accept.ts`）与其他运行的副本、报告、会话记录在运行期间都找不到；变体里的 firecode 副本也不带 `evals/`。起因是 grok 在实现题里跳出副本翻 `$EVAL_DIR`，读到了 t9 真值与别的运行结果。判分与汇总在沙箱外的评测脚本里做。
- 子进程环境不继承任何 `PI_*` 与 `HERDR_*`：只给评测自己设的 `PI_CODING_AGENT_DIR`（变体目录）、`PI_OFFLINE`、`PI_TELEMETRY`，所以外层 pi 给工具设的会话变量和你的 `PI_CACHE_RETENTION` 等个人设置不会混进来，也不会回写你的 herdr pane；不加载 cuepad-bridge、herdr-agent-state。

## 任务

| 任务 | 类型 | 理想首步 | 备注 |
| --- | --- | --- | --- |
| t1 / t2 | 一行改动 / 简单问答 | 亲手 | |
| t3 | 联网调研 Markdown 终端渲染库 | 委派调研员 | 完成跑；真值：npm registry |
| t4 | 跑 15 分钟的 e2e | 亲手 | |
| t5 | 三件小工单（带测试） | 亲手 | 边界题，理想依据是用户提供的调研结论，未独立核实 |
| t6 | 三处文案小改 | 亲手 | 对照“并行”条款会不会被滥用 |
| t7 | 审计 `review/` | 亲手 | 完成跑；真值：16 条已核实缺陷（`tasks.ts` 的 `T7_TRUTH`，非穷举） |
| t8 | 单模块实现 | 亲手 | |
| t11 | 高影响实现（持久化与崩溃恢复） | 亲手 | 汇报里建议用户运行 `/fire-review` |
| t9-big | 六目录审计（约 1.06 万行，14 处植入缺陷） | 无预设 | 完成跑；真值：`t9-truth.json` |
| t9-hand | 同上，末尾加“完全亲手” | — | 亲手基线 |
| t9-rounds | t9 按目录分三批逐条下发、最后汇总，全程亲手 | — | 多轮长会话，`run.ts` 每歇下一次发下一条（`followUps`）；可判分的植入缺陷 M1–M4、T1–T5 |

任务原话与理想决策只在 `tasks.ts`；改理想只改它再 `decide.ts report`，不用重跑。

## 花费与耗时

一个变体跑 t3 / t7 / t9-big 各 3 次约 $20–30（单次 t3 $0.6–1.5、t7 $1.7–3.3、t9-big $2.9–6.3，t9-big 最长约 18 分钟）；`decide.ts` 全套 t1–t8 ×2 约 $5。务必带 `--budget`。

## 并发与隔离

- 每次运行独立的仓库副本、会话目录和 `TMPDIR`；但 `TMPDIR` 只是环境变量，**拦不住命令里写死的 `/tmp/xxx`**。t3/t7 的 Worker 爱写 `/tmp/mdeval`、`/tmp/fc-audit*.ts` 这类路径，同时跑会互相覆盖或误删，所以带 `serial` 的任务单独走一条串行通道（与其它任务并行，总并发 = `--concurrency` + 1）。t9 的任务文本要求临时文件只放 `TMPDIR`，仍可能违反。
- 跑完用 `bun $D/check.ts iso` 扫一遍：被多个运行共用的写死路径要人工看是不是真有串扰。
- 共享你的真实凭据与 settings（符号链接）；令牌刷新经 pi 自己的锁。并发太高会触发限流、拖慢墙钟，墙钟对比务必让各变体**同批交错**（`run.ts A,B,C`）。
- 模型偶尔会跳出副本去 grep 整个 `~/Project` 或 `find /`（见过拖满 300 秒超时，也见过一次审计卡 13 分钟）：沙箱只挡读写真值，挡不住这种耗时；这是模型的表现，计入墙钟，`decide.ts` 里表现为 `亲手†`。

## 盲评

分组身份会影响判断，所以先去标识再核对：

1. `bun $D/blind.ts` 把 t3/t7/t9 的最终报告打乱编号写到 `$EVAL_DIR/blind/`（X=t3、Y=t7、Z=t9），t3/t7 报告里“我派了几个调研员”之类的叙述行会被去掉；编号到变体的映射写在 `$EVAL_DIR/blind-map.json`，**打完分之前不要打开**。
2. 核对（输出只是候选，仍须人读报告确认）：
   - t3：`check.ts t3` 把表里的版本与发布日期对 npm registry；依赖数、表格/高亮支持要实测（唯一抓到的事实错误是 markdown-it-terminal 遇表格会抛错，只有没渲染实测的报告标错）。
   - t7：`check.ts t7` 按关键词预筛覆盖了 16 条里的哪几条，逐条读报告确认。报告里新出现的条目要回代码核实，成立就加进 `T7_TRUTH` 并重数旧报告。
   - t9：`check.ts t9` 列出指到“同文件且行号相差 ≤5”的植入缺陷；其余的人读确认是否说清缺陷。每份报告另有的 16–31 条其他条目不计命中，精度没测。
3. 打完分再读映射，对回变体。

## 真实会话重放

`decide.ts` 是冷启动短任务，与真实会话里的行为对不上（两版提示词各跑 10 次决策完全一样）。`replay.ts` 改为截取你本机主会话（Agent 目录下的 `sessions/`）里指挥官要做下一步决定的时点，在隔离环境里让变体的指挥官从那一刻接着跑，只记它的第一个动作。

```bash
export EVAL_DIR=~/.cache/firecode-eval                  # 产物在 $EVAL_DIR/replay/
bun $D/replay.ts scan [--max-tokens 120000]             # 候选时点 → candidates.json，按项目/时点类型/原始动作计数
bun $D/replay.ts pick [--count 20]                      # 分层抽取 → points.json（定下后就别重抽，对比都用这份）
bun $D/variant.ts main                                  # 变体同上
bun $D/replay.ts run main --runs 2 --budget 30          # 每个时点跑 N 次，并发默认 3；超预算即停，已跑完的跳过
bun $D/replay.ts report main,B                          # 变体对比表与汇总行
bun $D/replay.ts report B,C --base main                 # 与 base 比：多数动作一致率（base 自己留一作噪声底）、首 token、请求耗时、输入、缓存读占比、花费，及不一致的动作原文
bun $D/replay.ts compact C [--points …] [--summary-model <provider/模型/思考档>] [--instructions-file f]   # 先在每个时点做一次宿主压缩；变体 C 之后的 run 从压缩后的会话接着跑
```

- **时点**：`event`：子代理事件送达后的下一步。探针用自定义消息加 triggerTurn 重发原来那条 `firecode-master-event`，和生产投递走同一条路径。`user`：用户新需求到达后的第一步，原话与图片经 RPC prompt 发出。会话的工作目录须在本机，且属于 CuePad、yuanzhuoai（含 `yz-*` 检出）或 firecode。只收原会话里指挥官已激活、原回应没出错的时点，模型须在你的模型表里，上下文按截取前最后一次用量计，不超过 `--max-tokens`。审查停在进行中的时点不收：重开会话会自动续审，而审查会话不带探针。
- **抽取**：每组（项目 × 类型）的名额均分，不够的让给别组；组内按原始动作分桶轮流取，桶内按时间均匀取。
- **前缀**：只把截取点父条目的整条分支复制进运行目录再 `--session` 打开，原文件不动；未确认的事件补一条 ack，免得 Master 重开会话时自己重投。模型与思考档取原回应用的那一个。
- **不执行任何工具**：被重放的项目有生产权限。探针 `replay-probe.ts` 拦下每个工具调用，第一条助手消息一结束就杀掉整棵进程树。另有第二道保险：沙箱（`lib.ts` 的 lockdown）只许写运行目录、变体目录与 `/dev`，项目目录只读。供应商在本机时，网络只通它的端口，本机 HTTP 代理也不通（经 `NO_PROXY` 直连）；供应商不在本机就只剩文件这一层。
- **动作分类**：静态看参数，codemode 只看脚本里调了哪些 `tools.*`，字符串与注释里的不算，循环里的只计一次。一条消息里有多个调用时取分量最重的：start（几个、角色、是否 review:true）> send > review（记为“其他(review)”）> 亲手读/改 > 其他 > 歇着（结束回合不调工具）。kill、ack、list、tail 旁边有读改就算亲手。结果只存原始调用，报表读时再分类，改了规则用 `report` 重打即可。
- **口径**：“一致”指同一时点多次结果的标签全同（另列只比大类）。“与原会话同大类”只作参考：原会话跑的是当时的提示词。花费取第一条助手消息的 usage。首 token 从助手消息的 timestamp（宿主记的请求开始）算到第一条增量；第 1 次写缓存记为冷，其余几次读缓存记为热。
- **压缩**：`compact` 与 `/compact` 同一路径，写摘要的模型默认用时点原模型，`--summary-model` 换成别的（换了模型宿主会往会话里追加 model_change / thinking_level_change，压缩后摘掉并接回父链，免得接着跑的会话多出切点前的条目）；`--instructions-file` 的内容作压缩的附加指令。每个时点的 `compact/compact.json` 记摘要的用量、花费、整条命令耗时与 RPC 往返耗时，`compacted.jsonl` 是接着跑的前缀，`detail.ts` 也读它。
- **时点清单**：含个人会话路径，不进仓库；`REPLAY_POINTS` 指向仓库外的 points.json（`pick` 也写那里），不设则用 `$EVAL_DIR/replay/points.json`。
- **提示词的位置**：会话前缀里记的是当时的系统提示。宿主打开会话时比对当前的提示段，有差异就追加一条系统更新，所以变体提示词是以更新的形式送达的，不是位于会话开头。生产里 reload 后改了提示词也是这样；全新会话里提示词在开头，权重可能不同。

基线（2026-11-05，当时 main 的提示词，20 个时点，三个项目各有 event 与 user，每个时点 2 次）：一致 14/20。首次每个时点平均 $0.31（写提示缓存），第二次 $0.03（命中缓存），合计 $6.74，单次约 12 秒。同一时点的几次是顺序跑的。动作的分歧集中在“审查失败或子代理返回后，是 send 续派、送审还是亲手看”这类边界时点，要分辨变体差异须加次数（建议每个时点 ≥5 次）。

## 角色选型

新模型发布或某家额度变化时，用 `worker.ts` 决定角色表里的原子。它把每个原子直接当 Worker 跑（带 `worker.zh.md`，firecode 只开 claudeSub），不经指挥官，所以只比模型本身：

```bash
bun $D/worker.ts anthropic/claude-haiku-5-5/low,anthropic/claude-sonnet-5-5/medium --tasks audit,research --runs 2
bun $D/worker.ts report
```

| 组 | 任务 | 判分 |
| --- | --- | --- |
| audit | t9 fixture 的两块（master/+format.ts 8 处、session/statusbar 4 处植入缺陷） | 自动：指到植入行 ±5；漏指行号的人读 |
| research | 同 t3 | 人读，版本日期用 `check.ts t3 <final.md…>` |
| wait | 2 分半 e2e、后台部署盯到终态 | 自动：失败场景与原因原文 |
| impl | formatDuration 进位到天；quota 8 秒超时；/tokens 日期范围与按天分组（中等规模，带接口规格） | duration 与 stats 跑 `accept.ts` 的隐藏用例（通过数/总数，列出未过的），quota 读 diff 与测试 |

**工具形态**（only / on / off）：`worker.ts --forms only,on,off` 与 `variant.ts --form <形态>`（指挥官变体，配 `run.ts`；或 `--tools … --codemode-mode …` 自定）按 `lib.ts` 的 `TOOL_FORMS` 在变体自己的 settings 副本里覆盖 `defaultTools` 与 `codemode.mode`，不动你的文件。同一轮同一任务各形态各一次，组内顺序按 `--seed` 洗牌；`--budget` 是 `$EVAL_DIR` 下全部运行的累计上限；结果带回合、顶层与嵌套调用数、总 token、工具失败数（`worker.ts report --json`）。跑之前先 `tools-check.ts <原子>` 抓第一次请求的 tools 列表与 codemode 描述，核对各形态暴露的确是预期的（`--prefix cmd-` 查指挥官变体）。指挥官并行题 `t5-delegate3m`（含隐藏验收 `parallel3`）用 `run.ts`。`forms-report.ts` 出 模型 × 任务 × 形态 的表和按轮配对（以 only 为基线）的差值，差异不足 15% 或范围跨 0 记“无差异”。

结论（2026-11-05/06，Opus 5.5 每格 4 次、Terra 每格 6 次）：on 对 only，Terra 的 /tokens 实现题墙钟 −43%、总 token −39%（6 对同向），Opus 全部无差异；通过率不受形态影响，本机改用 on。

fixture 不含测试目录，impl 运行前把一份指向 pi 源码的 `node_modules`（`$EVAL_DIR/host-modules`，宿主包改指 `src`）链进副本，Worker 自己写的测试与隐藏验收才能导入被测模块。隐藏验收以 `TZ=Asia/Shanghai` 跑，按 UTC 解析日期的实现会挂。

结果在 `$EVAL_DIR/worker/<任务>[__<形态>]__<原子>__<第几次>/`（`final.md`、`result.json`、`repo/`），已跑完的跳过。`report` 每格依次是质量、墙钟、花费、回合数（模型回复条数）、工具调用数（顶层调用，codemode 脚本里的嵌套调用不计）、输出 token，过程量从会话记录现数。token/秒高不等于任务快：回合与工具调用多的模型墙钟照样长，按任务综合看。
