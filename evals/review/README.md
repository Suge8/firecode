# 审查评测

维护者工具，会真实调用模型并花钱；不属于插件，不进 `bun test`。所有仓库副本、凭据链接、会话与结果只写 `$EVAL_DIR`（默认系统临时目录下的 `firecode-review-eval`）。不要将真实会话或运行产物提交到仓库。

## 准备与运行

需要 `bun`、`git`、`npm`、pi，以及 Agent 目录里的模型表、认证与 FireCode 运行配置。运行 `/fire-review` 的 pi 沿用委派评测的选择规则；历史被审代码的宿主单独安装在评测目录。`PI_REPO` 指向含样本提交的完整 [pi 仓库](https://github.com/earendil-works/pi)，默认 `~/Project/pi`；FireCode 提交来自当前检出。

```bash
export EVAL_DIR=/tmp/firecode-review-eval
bun evals/review/setup.ts           # FireCode 历史提交需要的宿主源码（v1.1–v1.4）
bun evals/review/setup.ts pi        # 每份 pi 历史仓库按自己的 lockfile 装依赖；再在各仓库 npm run build:offline
bun evals/review/setup.ts fixtures  # FireCode 样本预先构建 dist（pi-smoke 要它）
bun evals/review/setup.ts check     # 每个样本在改动后的树上实跑验证命令，写 envcheck.json

bun evals/review/run.ts --code 199abf3 --label baseline \
  --models gpt-6.1-terra/low,gpt-6.1-terra/medium,claude-sonnet-5-5/low,claude-sonnet-5-5/medium,claude-opus-5-5/low,gpt-6.1-sol/low,claude-haiku-5-5/low,gpt-6-luna/low,deepseek-flash/low \
  --cases all --runs 2 --concurrency 2 --budget 20

bun evals/review/judge.ts baseline --model gpt-6-luna/medium --verify gpt-6.1-terra/medium
bun evals/review/report.ts baseline --set opt
bun evals/review/report.ts baseline --set hold --threshold 20,8   # 按分数重算阻塞，扫描门槛用
```

先用少量 `--cases id,id` 跑通并人工核实判分，再跑整批。模型名从本机 `models.json` 解析；省略供应商时取首个段边界匹配项。用完整的 `provider/model/thinking` 原子固定供应商；运行结果记录实际使用的模型。`--models` 是比较矩阵，不代表生产推荐。

每次派审查和裁判前查 Magpie 的 `/v1/magpie/quotas`（`MAGPIE_URL` 可覆盖 `/v1` 根地址）。本次调用用到 Claude 模型且 Claude 5 小时剩余低于 20%，或查询失败/窗口缺失，就停止派新调用；Codex 超额后按 credit 计费，不设停止线。预算在每次运行完成后检查，在飞的运行会收尾，可能超出预算。

同批候选交错运行；一个 label 同时只开一个进程。已有完整结果跳过；输入变化则拒绝复用。`--force` 把旧运行移到 `attempts/` 后重跑。异常退出留下 `.running` 时，先确认原进程已退出再移除该目录。

默认 `detect` 只观察首轮：主会话的执行模型指向本地拒绝端点，避免首轮落盘后自动总结污染费用。`--mode loop --executor <原子> --advisor <原子>` 运行完整修复循环，保留最终仓库和会话。裁判目前只判首轮；后续轮没有代码快照，不能据最终仓库或首轮 diff 自动判“不必要修复”。这项指标须沿会话逐轮人工复核，不能从轮数代推。

## 样本与证据边界

用例来源、提交、缺陷与集合以 `cases.ts` 为准。真实缺陷取自后续修复提交；四个约定违例是显式植入，统计时应与真实缺陷分开看。相同缺陷的初稿、后续改动和修复对照放在同一集合，避免优化集与留出集泄漏。留出集结果不用于修改提示词。

对照提交是“目前没有定位到已知缺陷”，不是已证明无 bug。合并后未见修复只能作为筛选线索；新发现仍须看代码和需求核实，不能因不在真值表里就记误报。需求与约定冲突的场景单独设陷阱；正确做法是交用户裁决，不能为兼容旧版本而强迫写兼容投影。

fixture 把基准树重新建成一个提交，再重放待审改动；不带远端或后续修复对象。需求按公开提交与 PR 描述重建，不等同于当时完整的用户意图。合成会话的验证轨迹与交付声明取自 `setup.ts check` 在同一棵树上实跑的退出码与输出尾部（`envcheck.json`），不编造验证结果；正式比较前先看一遍里面的失败项是改动造成的还是环境造成的。审查者经生产 `/fire-review` 读取文件与自行验证。实际会话只能留在临时目录，不能用它的原文补公开样本。

宿主源码版本可固定，但旧版本的模型数据生成脚本会拉取今天的目录，可能产生上游类型错误；不删数据来伪装通过。没有 `scripts/pi-source.ts` 的旧 FireCode 样本暂用 v1.1.0，正式比较前须确认适配。pi 样本的依赖按各自 lockfile 安装，不链接维护者工作仓库的 `node_modules`，避免 workspace 包指回新代码。

正式基线还需要逐个确认基准与改动树上的验证环境、人工抽样校准裁判、重复运行以及真实修复循环验证。只跑通脚本不能证明模型质量；宿主错配、缺构建产物、主机负载与并发限流造成的耗时不能归因于模型。

## 判分与计量

裁判先看需求、项目约定、diff、后续修复与真值做匹配，再用只读工具核实未匹配的发现，包括第一裁判判假的发现。打分契约下门槛以下的发现被收成建议区的一行，同样逐条判，`--threshold` 才能离线重算门槛。只核实阻塞的发现；门槛以下的发现成不成立取第一段判定。核实默认用 Terra medium（DeepSeek 按量付费、余额会用完）；换核实模型前先在校准样本上对一遍旧结论。无法核实保留 `unsure`；裁判漏判、写错类别或 id 时整轮重判，三次都不合契约才记判分失败。每条裁判结论保存在运行目录，可人工改正并重新汇总。便宜裁判未经人工校准时，其输出只是待审标注。

- 命中率：首轮阻塞发现匹配的已知缺陷数 / 已判运行的已知缺陷总数；同一缺陷重复报告只计一次。建议区命中另列。
- 误报率：核实不成立的阻塞发现 / 全部已判阻塞发现。未定项单列，不能默认为正确。
- 吹毛求疵率：不属于真 bug、实现偏离需求、违背项目约定的阻塞发现 / 全部已判阻塞发现。包括泛泛的验证要求、风格建议和需要用户裁决的需求质疑；与误报可以重叠。用户显式要求的验收交付物确实缺失，按需求偏离处理。
- 对照 FAIL 率不等于误报率；已知缺陷样本 PASS 率不等于全部漏检率。
- 墙钟：发出 `/fire-review` 到首轮记录的时间，单独报中位数与 P90。某次请求超过 90 秒且出字少于每秒 20 个的运行是网关或上游卡住，不计入墙钟统计，表里列出剔除了几次。修复模式另报总墙钟、轮数与终态；不合并成一个总分。
- 花费：本地代理读取真实响应里的 input/output/cacheRead/cacheWrite，按模型表单价估算；不等同订阅实际扣额。仅支持有自定义 `baseUrl` 的供应商。用量缺失、HTTP 失败或单价缺失标记计量不完整，不能当免费请求。

`report.ts` 可以合并多个 label，但比较前先确认相同样本、配置、被测提交、协议和并发。没有判分的运行不计命中率分母，表里显式列出未判数量；部分批次不能冒充完整基线。
