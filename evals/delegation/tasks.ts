// 任务集。prompt 是用户原话；ideal 是评测者对首步决策的判断（t5 是边界题，依据是用户提供的调研结论，未独立核实）。
// 有 ideal 的任务用 decide.ts 测首步决策；有 timeoutSec 的任务用 run.ts 跑到完成。
type Mode = "hand" | "delegate" | "parallel";
export type FixtureKind = "base" | "t9";

export interface Task {
	id: string;
	kind: string;
	prompt: string;
	fixture: FixtureKind;
	ideal?: { mode: Mode; roles?: string[] };
	timeoutSec?: number;
	/** Worker 爱用写死的 /tmp 路径，这类任务只能一个接一个跑。 */
	serial?: boolean;
}

/** Worker 爱用写死的 /tmp 路径，要求它只用 TMPDIR。 */
export const TMP_NOTE = "需要临时文件时只能放在环境变量 TMPDIR 指向的目录里。";
export const auditPrompt = (scope: string) =>
	`审计这个仓库的 ${scope}：找真实缺陷——代码行为与各目录 AGENTS.md、代码注释和命名所表达的契约不符，或会导致错误结果、状态错乱、数据丢失的逻辑错误。给我一份带文件:行号和触发条件的清单，按严重度排序，不要改任何代码。${TMP_NOTE}`;
const T9_AUDIT = auditPrompt("master/、tools/、review/、session/、statusbar/、watcher/ 六个目录和根目录的 format.ts");

const MINUTES = 60;

export const TASKS: Task[] = [
	{ id: "t1-oneline", kind: "一行小改动", fixture: "base", ideal: { mode: "hand" }, prompt: "把指挥官空闲时合并唤醒的安静窗口从 1.5 秒改成 2 秒。" },
	{ id: "t2-qa", kind: "简单问答", fixture: "base", ideal: { mode: "hand" }, prompt: "同时在跑的子代理最多几个？超了会怎样？只回答，不要改任何东西。" },
	{
		id: "t3-research",
		kind: "大量搜索的调研",
		fixture: "base",
		ideal: { mode: "delegate", roles: ["调研员"] },
		timeoutSec: 25 * MINUTES,
		serial: true,
		prompt: "联网调研一下：现在 Node/Bun 生态里能在终端渲染 Markdown 的库有哪些（至少 8 个，pi-tui 自带的不算）。逐个查最新版本、最近一次发布时间、依赖数量、是否支持表格和代码高亮，最后给对比表和你的推荐。",
	},
	{ id: "t4-longwait", kind: "跑很久的等待", fixture: "base", ideal: { mode: "delegate", roles: ["哨兵"] }, prompt: "把 scripts/e2e.sh 完整跑一遍（全套大约 15 分钟），告诉我哪些场景挂了。" },
	{
		id: "t5-parallel3",
		kind: "三件独立小工单（带测试）",
		fixture: "base",
		ideal: { mode: "hand" },
		prompt: "三件互不相关的事，都要补测试并跑通对应测试文件：1）format.ts 的 formatDuration 超过 24 小时现在显示成 25h30m，改成 1d1h30m；2）/tokens 输出（session/stats.ts）的汇总里增加一行缓存命中率（cacheRead / (input + cacheRead)）；3）header.ts 的副标题在 git 仓库内追加当前分支名。",
	},
	{
		id: "t6-trivial3",
		kind: "三处文案小改",
		fixture: "base",
		ideal: { mode: "hand" },
		prompt: "三处小改：1）README.md 末尾追加一行“欢迎提 issue。”；2）format.ts 里 formatModelName 上方注释“去掉模型 id 的 provider 前缀与日期后缀。”改成“去掉 provider 前缀与日期后缀。”；3）package.json 的 description 末尾加一个句号。",
	},
	{
		id: "t7-audit",
		kind: "整模块代码审计",
		fixture: "base",
		ideal: { mode: "parallel", roles: ["调研员", "工程师"] },
		timeoutSec: 25 * MINUTES,
		serial: true,
		prompt: "审计 review/ 整个模块：找状态机、并发、持久化和错误处理上的真实缺陷，给我一份带文件和行号证据的清单（按严重度排序），不要改代码。",
	},
	{ id: "t8-single", kind: "单模块中等实现", fixture: "base", ideal: { mode: "hand" }, prompt: "给 session/quota.ts 的供应商查询加 8 秒超时：超时算该家失败、报超时原因，不影响另一家的结果；补测试并跑通。" },
	{ id: "t9-big", kind: "大任务：六目录审计（植入缺陷）", fixture: "t9", timeoutSec: 50 * MINUTES, prompt: T9_AUDIT },
	{ id: "t9-hand", kind: "t9 强制亲手基线", fixture: "t9", timeoutSec: 60 * MINUTES, prompt: T9_AUDIT + " 本次请完全亲手完成，不要使用 subagents。" },
];

export const taskById = (id: string): Task => {
	const task = TASKS.find((t) => t.id === id);
	if (!task) throw new Error(`未知任务 ${id}；可选：${TASKS.map((t) => t.id).join(", ")}`);
	return task;
};

/** t7 的 16 条已核实真实缺陷（b0fb416 的 review/ 与宿主源码，读代码核实，非穷举）。pattern 只是预筛，命中后仍须人读。 */
export const T7_TRUTH: Array<{ id: number; desc: string; pattern: RegExp }> = [
	{ id: 1, desc: "修复阶段取消/超时不追加轮记录，历史最后一条仍是上一轮 failed，被读成“停止”，Master 清掉审查义务", pattern: /修复.{0,40}(取消|超时)|(取消|超时).{0,40}(上一轮|质量停止|叫停)/ },
	{ id: 2, desc: "checkpoint 冲突分支不调 clearUi，随后的取消因停写提前返回，编辑器与终端标题锁死", pattern: /clearUi|锁死/ },
	{ id: 3, desc: "看门狗先 abort 再派发超时，宿主忙时超时卡进待发队列，唯一的冲刷点在 abort 检查之后，永远发不出", pattern: /看门狗|watchdog|armWatchdog/i },
	{ id: 4, desc: "排队阶段取消/超时没有轮记录，读成“审查未完成：unknown”", pattern: /排队.{0,30}(取消|超时)|未完成[:：]\s*unknown/ },
	{ id: 5, desc: "“往轮发现清单（由新到旧）”标题与实际由旧到新相反", pattern: /由新到旧/ },
	{ id: 6, desc: "evidence.ts 超预算时 continue 跳过大块、保留更早的小块，省略标记却统一放在最前", pattern: /省略标记|超预算/ },
	{ id: 7, desc: "严重程度正则只认 高/中/High/Medium，与旁边“不校验取值”的注释矛盾，“高危”或冒号放进粗体就整票作废", pattern: /高危|严重程度.{0,20}(正则|High)/ },
	{ id: 8, desc: "两个推进请求并发进入时 FEEDBACK_DISPATCHED 第二次是空操作但两边都投递，修复反馈/总结提示重复发送", pattern: /FEEDBACK_DISPATCHED/ },
	{ id: 9, desc: "修复回合以 error 结束一律按“用户取消”处理；宿主在 agent_end 后自动重试，事件不带 willRetry，429/过载被当成取消", pattern: /willRetry|已按你的操作停止|按.{0,4}用户取消/ },
	{ id: 10, desc: "evidence.ts 轨迹只取 path/command，codemode 的 code 参数看不到，经 codemode 的编辑归因不到", pattern: /codemode.{0,30}(code|编辑|归因)/ },
	{ id: 11, desc: "证据为空且下一行是旧措辞“需要运行的验证命令”时被当成证据正文，空证据发现被放行", pattern: /需要运行的验证命令|空证据/ },
	{ id: 12, desc: "任意 agent_start 都被当成修复回合开始（awaiting_start → running，不核对来源）", pattern: /awaiting_start|任意.{0,6}agent_start/ },
	{ id: 13, desc: "spawn.ts 的 bindExtensions 抛错时不释放已创建的会话（review/ 之外）", pattern: /bindExtensions/ },
	{ id: 14, desc: "回合互锁后新旧票混在同一轮里结算", pattern: /互锁|新旧票/ },
	{ id: 15, desc: "进程内多个会话共用同一个 herdr 占用标签", pattern: /占用标签|herdr.{0,30}(标签|label)/ },
	{ id: 16, desc: "取消/超时的轮记录 details 为空，Master 只拿到枚举名", pattern: /枚举名|details.{0,20}空/ },
];
