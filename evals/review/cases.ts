// 审查评测用例：每条是“某个会话做完的一次改动”，真实缺陷取自后续修复，另有显式标记的约定违例植入。
// 需求按公开的提交与 PR 描述重建，不取用户会话原文。
import type { Source } from "./lib.ts";

/** 审查只该拦的三类：真 bug、偏离需求、违背项目约定。 */
export type DefectKind = "bug" | "requirement" | "convention";

export interface Defect {
	id: string;
	kind: DefectKind;
	/** 缺陷本身：在什么情况下出什么错、违反了哪条约定。裁判按它判命中。 */
	summary: string;
	/** 后来修掉它的提交；植入的缺陷写 "inject"（裁判看到的是植入前后的差异）。 */
	fix: string;
}

/** 已知会诱发有害修复的误报：审查者若把它当成要修的阻塞项，执行模型会照做把代码改坏。 */
export interface Trap {
	id: string;
	summary: string;
	/** 正确的处理方式（例如交用户裁决）；裁判据此区分“指出冲突”与“逼着修”。 */
	right: string;
}

/** 植入：在原提交之上再改一处（`find` 在文件里须恰好出现一次），并进这一轮的最后一个提交。 */
export interface Injection {
	file: string;
	find: string;
	replace: string;
}

/** 会话里的一轮：用户这句话之后，执行模型把仓库从上一轮的状态改到 `to`。 */
export interface Turn {
	user: string;
	to: string;
	/** 公开提交提及的验证命令；本工具不伪造成功回执。 */
	checks: string[];
	inject?: Injection[];
}

export interface Case {
	id: string;
	source: Source;
	base: string;
	turns: Turn[];
	/** 优化集用来爬坡，留出集只在确认时看。 */
	set: "opt" | "hold";
	tags: string[];
	truth: Defect[];
	traps?: Trap[];
}

/** FireCode 工作说明的固定收尾，与指挥官派活的写法一致。 */
const FC_TAIL = "先读 AGENTS.md 与改动目录的 AGENTS.md、WORDS.md；跑 bun run typecheck 与受影响的测试，提交在本分支，不推送。";

const MODEL_CHAINS_REQUEST = `在本检出实现“角色模型链”，替换现有三套回退。
1. 配置：所有指定模型的位置（master.roles.<名>.model、review.advisor、review.reviewers[i]、watcher.model）都是一个原子字符串或非空有序原子数组；原子仍是 "<模型>/<强度>"，模型可省略供应商，先精确匹配 provider/id，否则按段边界匹配所有以 "/<模型>" 结尾的可用模型，按 pi 模型列表顺序成为候选。presets 用同一个原子解析。删除 fallback 字段与审查者 {model,fallback} 写法，旧写法报配置问题。
2. 运行时：唯一一个路由模块给 FireCode 的所有子会话挑物理模型，优先用 pi 的虚拟模型（每次请求前 route()）。进程内唯一的冷却表：报错里能读到重置时间就用，否则连续失败依次 5→15→60 分钟，成功清零。进行中的活留在当前模型保缓存，下一次派活从链首重选；只有最终错误才沿链换下一个候选并在同一回合续跑。
3. 删除 Master 的 resumeWithFallback/nextFallback、审查席位的 fallback 链与跨轮记忆、config 的 fallbackChain，以及只复述这些实现的测试。
4. Master：start 必须给 role，保留 thinking 参数覆盖本次实际运行候选的强度。系统提示的角色表只写角色名与 use，不写模型；没有任何可用候选的角色不进角色表与 role 枚举，session_start 提示一次缺哪些模型。链用尽时派活失败交给 Master，带每个模型的原因和最早恢复时间，绝不静默改用主会话模型。
5. 审查：每个审查席位、顾问、观察员各是一条链；席位用尽仍记缺席，顾问用尽仍跳过本次咨询。
6. 模板、文档与 CHANGELOG（Breaking）同步；端到端用例覆盖：首选额度用尽后同一回合换下一个候选完成、省略供应商的原子能解析、没有可用候选的角色不进角色表、审查席位沿链换模型。
${FC_TAIL}`;


/** 对照提交：暂未定位到后续修复；没有真值不等于没有缺陷。 */
function clean(id: string, source: Source, commit: string, set: "opt" | "hold", tags: string[], user: string, checks: string[]): Case {
	return { id, source, base: `${commit}^`, set, tags: ["control", ...tags], turns: [{ user, to: commit, checks }], truth: [] };
}

export const CASES: Case[] = [
	// ---- FireCode：真实缺陷（后来的修复提交为真值）----
	{
		id: "fc-model-chains",
		source: "firecode",
		base: "684d595",
		set: "opt",
		tags: ["large", "design"],
		turns: [{ user: MODEL_CHAINS_REQUEST, to: "b26c304", checks: ["bun run typecheck", "bun test", "bun run build"] }],
		truth: [
			{ id: "retry-switch", kind: "bug", summary: "route() 在 reason 为 retry（宿主对可重试错误的原地重试）时，只要链里还有备选就立刻换模型并让首选冷却，一次网络抖动就丢缓存、来回换模型；需求是进行中的活留在当前模型，只有宿主放弃后的最终错误才换", fix: "a0149d3" },
			{ id: "enum-mutation", kind: "convention", summary: "master/index.ts 为了把不可用角色剔出 role 枚举，原地改写 StringEnum 生成的 schema 内部 enum 数组（as unknown as 强转后 splice），依赖库内部结构、悄悄改掉已注册的工具定义", fix: "a0149d3" },
			{ id: "thinking-two-sources", kind: "convention", summary: "spawn 选项另收一个 thinking 传给 createAgentSession，而实际生效的强度来自虚拟模型路由（候选原子或本次覆盖），同一事实两个来源", fix: "a0149d3" },
			{ id: "truncation-no-chain", kind: "bug", summary: "输出被截断（stopReason length）时 Worker 与审查者都按失败处理，但路由的 agent_before_settle 只接 error 结局（宿主把截断记为 completed），链里还有候选也不换，直接交付失败", fix: "d3146af" },
		],
	},
	{
		id: "fc-model-chains-followup",
		source: "firecode",
		base: "684d595",
		set: "opt",
		tags: ["large", "design", "requirement-conflict"],
		turns: [
			{ user: MODEL_CHAINS_REQUEST, to: "b26c304", checks: ["bun run typecheck", "bun test", "bun run build"] },
			{
				user: `终审前先收口这几处，改完追加提交：
1. 只有最终错误才沿链换模型：retry 一律留在当前模型交给宿主原地重试，宿主放弃后的最终错误（agent_before_settle 那条）才记冷却并换下一个；补一条用例：一次可重试错误后仍在原模型上完成。
2. 审查检查点版本退回 8：这次席位只删了字段、顾问结果多了可选字段，旧快照按新类型照样能读，升版只会让升级时进行中的审查作废。
3. master/index.ts 不要改写 StringEnum 内部的 enum 数组：role 枚举保持配置里的全部角色，系统提示的角色表只列有可用候选的角色，start/send 选到没有可用候选的角色时直接报错并列出可用角色。
4. spawn 去掉 thinking 选项：强度只来自候选原子或本次覆盖，一个来源。
5. 重测 AGENTS.md 里指挥官提示词的字符数。`,
				to: "f88cdad",

				checks: ["bun run typecheck", "bun test", "bun run build"],
			},
		],
		truth: [
			{ id: "truncation-no-chain", kind: "bug", summary: "输出被截断（stopReason length）时 Worker 与审查者都按失败处理，但路由的 agent_before_settle 只接 error 结局，链里还有候选也不换，直接交付失败", fix: "d3146af" },
		],
		traps: [{ id: "compat-projection", summary: "要求新快照写入旧代码需要的 fallback 等字段、或加兼容投影/迁移，让旧代码能读新快照", right: "指出“旧代码不读新字段”的前提不成立，按约定升版本或交用户在“升版作废进行中审查”与“接受降级风险”之间裁决，不写兼容层" }],
	},
	{
		id: "fc-review-settled",
		source: "firecode",
		base: "77b1455",
		set: "opt",
		tags: ["state-machine"],
		turns: [{
			user: `fire-review 修复回合的结局判错了：宿主每次请求失败都会先发一次 agent_end（在自动重试与续跑之前），现在据此把修复回合记成“用户取消”，一次网络中断审查就被取消了，Worker 随后其实在重试里把活修完了。改为等回合真正落定（agent_settled）再判结局：被中断按取消；分支最后一条 assistant 是错误就按故障收尾并保留报错原文，让 Master 收到原文；其余算修复完成。目标是不再把不是用户操作的结局记成用户取消。补端到端用例：修复回合遇到一次可重试错误后审查继续进入下一轮；修复回合最终出错时 Master 收到含原文的故障。
${FC_TAIL}`,
			to: "26294f6",

			checks: ["bun run typecheck", "bun test tests/review-integration.test.ts tests/master-integration.test.ts"],
		}],
		truth: [
			{ id: "history-rewrite", kind: "convention", summary: "修复或总结回合出错时把已收口的末轮记录改写成故障（并让 CheckpointWriter 再追加一条同轮记录），违反 state.ts 头注释“history 只追加不改写”与轮记录只写一次的约定；改动还顺手把这条不变量注释改掉了", fix: "49c914f" },
			{ id: "summary-verdict-lost", kind: "bug", summary: "总结回合被中断或出错时把已经定下的质量裁决（通过/叫停/轮数用尽）改成取消或故障；总结是尽力而为，失败应静默收尾、不改变裁决", fix: "49c914f" },
			{ id: "delivery-failure-cancel", kind: "requirement", summary: "修复反馈投递失败仍按“用户取消”收尾，与本次“不再把非用户操作记成用户取消”的目标相悖，应按故障收尾并带原文", fix: "49c914f" },
		],
	},
	{
		id: "fc-checkpoint-version-bump",
		source: "firecode",
		base: "26294f6",
		set: "opt",
		tags: ["convention", "small"],
		turns: [{
			user: `审查终态的记录方式再收口：已收口的轮记录只追加、不改写，修复回合的故障说明作为可选字段 error 写在 settled 终态上；总结回合任何结局都保留已定的质量裁决；修复反馈投递失败按故障收尾；outcome.ts 的故障原因优先取终态的 error。
${FC_TAIL}`,
			to: "49c914f",

			checks: ["bun run typecheck", "bun test tests/review-integration.test.ts tests/master-integration.test.ts tests/review-outcome.test.ts"],
		}],
		truth: [
			{ id: "needless-bump", kind: "convention", summary: "只给 settled 相加了一个可选的 error 字段（旧快照照样能读），却把检查点 VERSION 从 8 升到 9：升版让升级时所有进行中的审查作废；约定只在不兼容的格式变化时升版本", fix: "95f25b1" },
		],
	},
	{
		id: "fc-damaged-notice",
		source: "firecode",
		base: "70a592e^",
		set: "opt",
		tags: ["requirement"],
		turns: [{
			user: `三件事：
1. 审查存档损坏时明确提示：没有存档与旧版本存档按没有处理、不出声；同版本存档损坏（字段无效，或快照记的轮数与轮记录条数对不上）作废，并在 session_start 提示用户重新 /fire-review。
2. ui.ts 还原终端标题时手抄了宿主默认标题格式，写明为什么只能手抄、升级 pi 时核对哪里。
3. evals 的文档标注维护者专用（要本机凭据、花真钱，贡献者不用跑）。
${FC_TAIL}`,
			to: "70a592e",

			checks: ["bun run typecheck", "bun test tests/review-integration.test.ts"],
		}],
		truth: [
			{ id: "settled-excluded", kind: "requirement", summary: "轮数与轮记录对不上时只对未收口的审查提示，已收口的审查被静默丢弃，自行缩小了需求范围（需求没有排除已收口审查）", fix: "784b6bf" },
			{ id: "repeat-notice", kind: "bug", summary: "提示后没有作废损坏的存档，它仍是分支上最新的快照，之后每次打开会话（reload、resume）都会重复同一条损坏提示", fix: "91ced54" },
		],
	},
	{
		id: "fc-setup-release",
		source: "firecode",
		base: "3dc1207^",
		set: "hold",
		tags: ["ci", "requirement"],
		turns: [{
			user: `1. 一条命令搭开发环境：bun run setup 按 scripts/pi-source.ts 里唯一的 PI_VERSION 把 pi 源码克隆到仓库外的缓存目录并装好依赖，已就绪则跳过，失败不留半成品；tests/loader.ts、typecheck 与 CI 共用同一套定位。
2. 加 .github/workflows/release.yml：GitHub Release 发布时复用 CI 检查，校验 tag 与 package.json 版本一致后用 npm Trusted Publishing 发布；workflow_dispatch 用来补发已存在的 tag——v1.3.0 当时没发到 npm，要能用它补发。
${FC_TAIL}`,
			to: "a0feec0",

			checks: ["bun run setup", "bun run typecheck", "bun test", "actionlint"],
		}],
		truth: [
			{ id: "exists-is-ready", kind: "bug", summary: "setup 只看目标目录存在就报“已就绪”退出 0：目录是半成品、别的版本或任意已有目录（如 FIRECODE_PI_DIR=/tmp）都会假成功；loader 的定位同样只看 packages 目录存在", fix: "65cdc51" },
			{ id: "old-tag-release", kind: "requirement", summary: "workflow_dispatch 补发 v1.3.0 时 CI 检出该 tag 后执行 bun run setup，而 v1.3.0 里没有这个脚本，检查必然失败，补发 v1.3.0 的需求做不到", fix: "65cdc51" },
		],
	},
	{
		id: "fc-ua-logout",
		source: "firecode",
		base: "4bac383^",
		set: "opt",
		tags: ["small", "provider"],
		turns: [{
			user: `Claude Code 的 user-agent 只在订阅（OAuth）会话里带：API key 与兼容代理的 anthropic 请求不再带这个标识；顺手删掉与宿主重复的 x-app（宿主已为 OAuth 请求带了）。
${FC_TAIL}`,
			to: "4bac383",

			checks: ["bun run typecheck", "bun test tests/claude-token-rotation.test.ts"],
		}],
		truth: [
			{ id: "stale-after-logout", kind: "bug", summary: "头只在首次检测到 OAuth 时注册一次、之后不撤销：同一进程里登出订阅改用 API key 后，anthropic 请求仍带 Claude Code 的 user-agent（代码注释假设“一个会话里只有一种凭据”不成立）", fix: "26426ca" },
		],
	},
	{
		id: "fc-compact-wait",
		source: "firecode",
		base: "5806647^",
		set: "hold",
		tags: ["race", "small"],
		turns: [{
			user: `手动 /compact 不在回合里：宿主 isIdle 为 false 但没有回合可续，deliver 这时 steer 只会被当场追加，指挥官事件送达却无人唤起。deliver 发送前先等手动压缩落定再做忙闲判断，signal 可中止等待。另外 inform 省略 triggerTurn 时宿主在回合进行中会把它当 steer 入队、等于唤醒，改为显式 triggerTurn:false。
${FC_TAIL}`,
			to: "5806647",

			checks: ["bun run typecheck", "bun test tests/delivery-contract.test.ts tests/master-integration.test.ts"],
		}],
		truth: [
			{ id: "one-macrotask", kind: "bug", summary: "压缩落定只让出一个宏任务就读 isIdle：宿主发出 session_compact 时还没清压缩状态，且逐个 await 全部扩展的处理器，排在后面的处理器较慢时一个宏任务后 isIdle 仍为 false，deliver 会 steer 并报已送达却无人唤起", fix: "cd14194" },
		],
	},
	{
		id: "fc-busy-settled",
		source: "firecode",
		base: "7ebcb89^",
		set: "opt",
		tags: ["race"],
		turns: [{
			user: `会话“歇下”边沿收进 busy.ts：指挥官回合结束且没有在飞子代理才算歇下，这是唯一的边沿；Bark 通知、输入框上边框与轮次时钟只消费 busy.ts 给出的歇下，不各自拼装判断。
先读 AGENTS.md 与改动目录的 AGENTS.md、WORDS.md；跑受影响的测试，提交在本分支，不推送。`,
			to: "7ebcb89",

			checks: ["bun test tests/statusbar.test.ts"],
		}],
		truth: [
			{ id: "settled-not-idle", kind: "bug", summary: "agent_settled 一到就把指挥官回合记为结束，但宿主在 agent_settled 时可能还有排队或延后的动作（ctx.isIdle() 为 false），紧接着会再 agent_start：歇下边沿提前触发，Bark 提前推、计时提前定格", fix: "3d9397f" },
		],
	},
	{
		id: "fc-claude-files",
		source: "firecode",
		base: "df8b488^",
		set: "hold",
		tags: ["provider", "cache"],
		turns: [{
			user: `新增 claudeFiles 功能（默认开）：发往 Anthropic 的请求里，每张内嵌 base64 图片换成经 Files API 上传一次得到的 file_id，订阅与 API key 都适用，子代理会话同样生效。只改发出的请求，不改会话历史；映射按内容哈希记在会话自定义条目里，重启、续开、fork 照用，每轮历史前缀逐字节不变（提示缓存和绑定前缀的思考块不能失效）。上传失败的图这一轮原样内嵌并提示，下一轮重试。
${FC_TAIL}`,
			to: "df8b488",

			checks: ["bun run typecheck", "bun test"],
		}],
		truth: [
			{ id: "org-keyed", kind: "bug", summary: "file_id 映射只按凭据类型（订阅/API key）区分，不按组织：换号或同类凭据切到别的组织后仍复用旧组织上传的 file_id，带图会话之后每轮请求 404", fix: "ec9baf9" },
			{ id: "gone-file", kind: "bug", summary: "文件失效（被删除）后映射永不作废，引用它的会话之后每轮请求都被拒且无法自愈，只在头注释里记成已知限制", fix: "ec9baf9" },
		],
	},
	{
		id: "fc-native-replay-notice",
		source: "firecode",
		base: "bf302cc^",
		set: "opt",
		tags: ["provider", "requirement"],
		turns: [{
			user: `原生压缩重放的两处修正：1. 重放比对不再要求条目 id 与宿主一致（跨供应商会话目前因此整段放弃重放）；2. 放弃重放时提醒用户：压缩窗口里的旧历史不在这次请求的上下文里。
${FC_TAIL}`,
			to: "bf302cc",

			checks: ["bun run typecheck", "bun test tests/openai-native.test.ts"],
		}],
		truth: [
			{ id: "switched-silent", kind: "requirement", summary: "只有“最近原生压缩比对不上”一种情况会提醒；最近一次压缩是原生压缩、当前请求却换到了不支持的供应商/模型或请求体不符时，replay 折叠成 undefined，旧历史同样丢了却不提醒", fix: "d2fa7e4" },
			{ id: "disabled-silent", kind: "requirement", summary: "openai.nativeCompaction 关闭时直接跳过重放也不提醒，会话里已有原生压缩时旧历史同样不在上下文里", fix: "30c7e11" },
		],
	},
	// ---- FireCode：植入的约定违例（真实提交之上改一处，违反 AGENTS.md 写明的硬约束）----
	{
		id: "fc-inject-system-prompt",
		source: "firecode",
		base: "3f99c44^",
		set: "opt",
		tags: ["convention", "injected", "small"],
		turns: [{
			user: `系统提示加当天日期：上游为保提示词缓存删掉了日期（earendil-works/pi#6621），模型因此常把去年当最新年份去搜。每次开跑时写入，同一次运行内不变，不能让日期变化重写已缓存的系统提示前缀。
${FC_TAIL}`,
			to: "3f99c44",

			checks: ["bun run typecheck", "bun test"],
			inject: [{
				file: "today.ts",
				find: `	pi.on("before_agent_start", (event) => {
		// sv-SE 的日期格式就是本地时区的 YYYY-MM-DD。
		event.systemPromptOptions.sections.date = msg.today(new Date().toLocaleDateString("sv-SE"));
	});`,
				replace: `	pi.on("before_agent_start", (event) => {
		// sv-SE 的日期格式就是本地时区的 YYYY-MM-DD；日期放在系统提示末尾，前面的内容不动。
		return { systemPrompt: \`\${event.systemPrompt}\\n\\n\${msg.today(new Date().toLocaleDateString("sv-SE"))}\` };
	});`,
			}, {
				file: "today.ts",
				find: " * 每次开跑时写入，同一次运行内不变；日期变了宿主只在对话末尾追加一条段更新，不改已缓存的前缀。",
				replace: " * 每次开跑时追加在系统提示末尾，同一次运行内不变。",
			}],
		}],
		truth: [{ id: "returns-system-prompt", kind: "convention", summary: "before_agent_start 返回 systemPrompt 而不是写 systemPromptOptions.sections：违反 AGENTS.md 硬约束，返回值会让宿主整段替换系统提示、丢掉段更新，日期一变就重写整个已缓存前缀", fix: "inject" }],
	},
	{
		id: "fc-inject-truncate",
		source: "firecode",
		base: "20d454b^",
		set: "hold",
		tags: ["convention", "injected", "ui"],
		turns: [{
			user: `清掉 master 与 watcher 里的冗余防御：宿主在渲染器抛错时本就退回默认消息渲染，事件卡自己再套一层 try/catch 与兜底组件是重复防御，去掉；观察员的 Advice 只含 note 一个字段，直接传字符串；未被外部引用的类型与常量去掉 export。
${FC_TAIL}`,
			to: "20d454b",

			checks: ["bun run typecheck", "bun test tests/master-integration.test.ts tests/watcher.test.ts"],
			inject: [{
				file: "master/event-card.ts",
				find: `/**
 * 单行截断：不用 pi-tui 的 TruncatedText——它的省略号带 \`\\x1b[0m\` 全量重置，
 * 会在截断点把外层 Box 的背景色掠断（行尾露底色、右缘参差）；
 * clip 是纯文本截断，Box 补位后背景整行连续。
 */
class CompactTitle implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		return [clip(oneLine(this.text), Math.max(1, width))];
	}
}`,
				replace: `/** 单行标题：超宽时按终端宽度截断。 */
class CompactTitle implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		return [truncateToWidth(oneLine(this.text), Math.max(1, width))];
	}
}`,
			}, {
				file: "master/event-card.ts",
				find: `import { Box, type Component, Markdown } from "@earendil-works/pi-tui";
import { clip, firstSentence, oneLine, textOf } from "../format.js";`,
				replace: `import { Box, type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { firstSentence, oneLine, textOf } from "../format.js";`,
			}],
		}],
		truth: [{ id: "truncate-in-card", kind: "convention", summary: "带背景的事件卡里用 pi-tui 的 truncateToWidth 截断：违反 AGENTS.md 硬约束，它的省略号带 \\x1b[0m 全量重置，会在截断点掐断外层背景色，单行截断须用 format.ts 的 clip", fix: "inject" }],
	},
	{
		id: "fc-inject-user-message",
		source: "firecode",
		base: "17571ca^",
		set: "opt",
		tags: ["convention", "injected", "requirement"],
		turns: [{
			user: `pi 1.2.0 起 triggerTurn 开的回合也经过 before_agent_start（pi#10739），空闲唤醒不再伪装成用户消息：插件发给模型的机器消息只剩自定义消息 + triggerTurn 一种形态，删掉前门 sendUserMessage、身份核对与 steer 补投，以及折叠界面、轮界、tail、审查证据里从用户消息认信封的分支。Worker 的 fallback 续跑提示同样改为自定义消息。要求 pi 1.2.0。
${FC_TAIL}`,
			to: "17571ca",

			checks: ["bun run typecheck", "bun test"],
			inject: [{
				file: "master/run.ts",
				find: "		void session.sendCustomMessage({ ...input, display: true }, { triggerTurn: true }).then(() => settled(), settled);",
				replace: "		void session.prompt(input.content).then(() => settled(), settled);",
			}],
		}],
		truth: [{ id: "resume-as-user", kind: "convention", summary: "Worker 的 fallback 续跑提示仍以用户消息（session.prompt）发出：违反“插件发给模型的消息一律是自定义消息、用户消息只表示人类输入”的约定，也没做到需求里“续跑提示同样改为自定义消息”，tail 与轮界会把它当成人类输入", fix: "inject" }],
	},
	{
		id: "fc-inject-legacy-config",
		source: "firecode",
		base: "b8facb7^",
		set: "hold",
		tags: ["convention", "injected", "compat"],
		turns: [{
			user: `配置解析收口：openai 节并入 config.ts 统一校验（未知字段、类型、verbosity 取值）；parseJsonc 认尾逗号与 BOM，与宿主 settings/models.json 同一宽容度；文件读不出来或顶层不是对象时只报一条文件级问题，不刷各节派生问题；删到不了的默认值。
${FC_TAIL}`,
			to: "b8facb7",

			checks: ["bun run typecheck", "bun test tests/config-seam.test.ts tests/openai-native-config.test.ts"],
			inject: [{
				file: "config.ts",
				find: "	rejectUnknownKeys(raw, REVIEW_KEYS, \"review\", problems);",
				replace: "	// 兼容旧配置：review.language 已移到顶层 language，旧文件里还写着的先放过，不报未知字段。\n	const { language: _legacyLanguage, ...current } = raw;\n	rejectUnknownKeys(current, REVIEW_KEYS, \"review\", problems);",
			}],
		}],
		truth: [{ id: "legacy-language", kind: "convention", summary: "review 节悄悄放过旧的 review.language：违反 AGENTS.md“不再有 review.language（旧写法按未知字段报错）”，属于为旧写法保留的兼容回退，用户写了也不生效且得不到提示", fix: "inject" }],
	},
	// ---- pi：真实缺陷 ----
	{
		id: "pi-durable-sleep",
		source: "pi",
		base: "f75b3240a^",
		set: "opt",
		tags: ["external", "large", "scheduler"],
		turns: [{
			user: `packages/durable：用持久的 sleeping 状态取代 runtime.sleep。任务以 runtime.sleepUntil() 或 { status: "sleeping", until, checkpoint } 结束一个阶段：不占用 invocation，截止时间跨重启保留，到点后从 checkpoint 恢复。生成的重试/轮询与压缩重试都改这样睡。Harness.wake() 与 HarnessOptions.onWake 让 Durable Object 这类宿主自己唤醒进程；HarnessOptions.setTimer 接管 Harness 的所有计时器，chord 的 Progress 改用可注入的时钟。SQLite 迁到 schema 2 以接纳 sleeping 状态。遵守仓库 AGENTS.md，跑受影响包的类型检查与相关测试。`,
			to: "f75b3240a",

			checks: ["cd packages/durable && npx tsc --noEmit -p tsconfig.build.json", "cd packages/durable && node ../../node_modules/vitest/dist/cli.js --run test/harness-sleep.test.ts test/sqlite-migrations.test.ts"],
		}],
		truth: [
			{ id: "due-sleep-stranded", kind: "bug", summary: "到点的 sleep 只由计时器或 resume() 唤醒：其他变化触发的调度轮次跑在截止时间之后也不处理已到期的 sleeping 任务，而为它排的计时器可能已被丢弃，任务就此搁浅", fix: "ec1be23eb" },
			{ id: "onwake-lost", kind: "bug", summary: "调度器在调用 onWake 之前就记下 lastWake：onWake 抛错后同一个 wake 值不会再提供给宿主，宿主永远不排唤醒", fix: "ec1be23eb" },
			{ id: "declined-foreground-timer", kind: "bug", summary: "宿主 setTimer 拒绝（返回 undefined）或抛错的前台计时器只上报、从不触发，依赖它的进度提交与 sleep 恢复就此停住；应退回 setTimeout", fix: "ec1be23eb" },
			{ id: "poll-checks-model-first", kind: "bug", summary: "生成的 poll 阶段先查模型可用性再判断 pollAt 是否到点：提前唤醒（或旧版本记录）时模型暂不可用会直接失败，而不是继续睡到 pollAt", fix: "ec1be23eb" },
		],
	},
	{
		id: "pi-durable-crash-loop",
		source: "pi",
		base: "a30c2a81d^",
		set: "hold",
		tags: ["external", "large", "scheduler"],
		turns: [{
			user: `packages/durable：
- Open 按任务数重启次数，到 settings.restartLimit（默认 5）时把任务停成 blocked（restart_limit），直到 Harness.retryTask()。
- onReport(error, info) 带 ReportInfo：session、task（faulted）、extension、listener、host、timer、wake；任务出错要上报。
- settings.afterFailedRun：keep、continue 或 withdraw 排在失败运行之后的输入。
- TaskGraphNode.blocked 跟随注册表变化与失败的迁移。
- README 的 Durable Object 示例在 Harness.open 之前排兜底闹钟。
遵守仓库 AGENTS.md，跑受影响包的类型检查与相关测试。`,
			to: "a30c2a81d",

			checks: ["cd packages/durable && npx tsc --noEmit -p tsconfig.build.json", "cd packages/durable && node ../../node_modules/vitest/dist/cli.js --run test/harness-reports.test.ts test/harness-blocked.test.ts test/harness-generation.test.ts"],
		}],
		truth: [
			{ id: "close-counts-restart", kind: "bug", summary: "正常 close 时停下的任务没有写回 pending，下次 open 也按一次崩溃计重启：反复正常开关就能把任务误停成 blocked(restart_limit)", fix: "440a5fcdb" },
			{ id: "abort-not-bounded", kind: "bug", summary: "abort 标记不让重启计数重新开始，abort 处理器被切断达到 restartLimit 次后也不会以 faulted 收尾，任务可能被错误地停住或无限重启", fix: "440a5fcdb" },
			{ id: "wake-during-reconcile", kind: "bug", summary: "reconcile 轮次已排定或正在进行（它的提交会收尾持有的结局、做恢复工作）时 wake() 报告不活跃，靠 onWake 唤醒的宿主可能在恢复工作完成前休眠", fix: "440a5fcdb" },
			{ id: "report-extension-missing", kind: "requirement", summary: "需求要求上报带 extension 来源，但钩子、包装器、提示段、工具与任务安装器里的代码出错时，上报没有点名是哪个扩展", fix: "440a5fcdb" },
		],
	},
	{
		id: "pi-stale-tree-revert",
		source: "pi",
		base: "c4cf7957b^",
		set: "opt",
		tags: ["external", "regression", "small"],
		turns: [{
			user: `packages/durable：per-model 压缩设置 compaction.modelOverrides，按精确的 "provider/modelId" 为每个模型单独设压缩阈值，阈值检查、溢出恢复与压缩范围选择都用它们所服务模型的那一项（closes #10942）。遵守仓库 AGENTS.md，跑受影响包的类型检查与相关测试。`,
			to: "c4cf7957b",

			checks: ["cd packages/durable && npx tsc --noEmit -p tsconfig.build.json", "cd packages/durable && node ../../node_modules/vitest/dist/cli.js --run test/harness-tools.test.ts test/harness-compaction.test.ts"],
		}],
		truth: [
			{ id: "terminate-reverted", kind: "bug", summary: "提交基于 6085986e4 之前的旧树，把 ToolControl.terminate 从 boolean 改回 true、删掉 terminate:false 的回归测试（#10858）与对应 changelog，属于与需求无关的回退", fix: "790271cd0" },
			{ id: "readme-rule-reverted", kind: "requirement", summary: "同样回退了 README 错误规则里“StorageRequestError 豁免只适用于读、commit()/mintId() 的同类错误照样结束 Harness”的修正（#11014）与 changelog 条目，文档重新说错", fix: "790271cd0" },
		],
	},
	// ---- 对照提交：已知缺陷为零；新发现仍要独立核实 ----
	clean("fc-interrupt-review", "firecode", "a2121dd", "opt", ["master"],
		`让审查中的子代理也能被 interrupt：对 reviewing 的子代理，先在它的会话里执行 /fire-review --cancel（与 esc 取消同一路径），再中止会话里可能在跑的修复或总结回合；审查以取消收场后按中断落定——回到 idle、带中断标记、审查义务保留，指挥官收到“审查被中断”事件而不是失败。取消没来得及生效、审查先以别的结局收场时按那个结局落定。全过程视图的中断键对审查中的子代理同样生效。补一条用例：Master 关闭不影响同池里正在跑的审查会话。
${FC_TAIL}`,
		["bun run typecheck", "bun test tests/master-integration.test.ts tests/worker-view.test.ts"]),
	clean("fc-spawn-trust", "firecode", "5061d35", "hold", ["small"],
		`spawn.ts 三处：1. 子会话按目标 cwd 起项目信任，与宿主非交互路径同一判定（没有需要信任的项目资源就信任，否则取信任存储里最近的显式决定，没有决定时看全局 defaultProjectTrust 是否为 always；子会话不能弹窗，ask 按不信任）；资源加载器与会话共用同一个 SettingsManager。2. bindExtensions 接上扩展错误回调。3. 建会话半途失败时释放已经建好的会话。
${FC_TAIL}`,
		["bun run typecheck", "bun test tests/master-integration.test.ts tests/watcher.test.ts"]),
	clean("fc-tree-deliver", "firecode", "9c5e578", "hold", ["race"],
		`带摘要的 /tree 切换期间也要等切换落定再投递：宿主 isCompacting 包含分支摘要，摘要期间 isIdle 为 false 却没有回合，steer 会被当场追加到即将丢下的旧分支，deliver 报已送达却无人唤起、模型之后也看不到这条消息。与手动压缩同处收口。补真实宿主用例：摘要期间不投、结束后恰好唤起一次且信封在当前分支；摘要被取消后照样唤起、不悬挂。
${FC_TAIL}`,
		["bun run typecheck", "bun test tests/delivery-contract.test.ts"]),
	clean("fc-test-seams", "firecode", "c728018", "hold", ["refactor", "large"],
		`删除生产代码里只为测试开的注入口（会话执行器、计时参数等的测试专用传参），等待时长统一收成子会话池的唯一 timing 入口（默认值与说明集中在根 timing.ts），测试改走真实的池与 faux 供应商。
${FC_TAIL}`,
		["bun run typecheck", "bun test"]),
	clean("fc-claude-files-org", "firecode", "ec9baf9", "hold", ["provider"],
		`Claude 图片文件的两个问题：换号或订阅与 API key 互换后，会话里旧组织上传的 file_id 仍被复用，带图会话每轮 404；同一组织里文件被删后映射也不会失效。改为映射记组织 id（凭据第一次带图时从接口响应头取，按凭据记在内存），只认当前组织的映射，不带组织 id 的旧映射不再认；文件失效时作废 404 点名的映射，失败回复从模型投影省略并续跑一次。另外修 claude-sub 的 agent_before_settle 返回值覆盖同轮其他处理器追加的条目。
${FC_TAIL}`,
		["bun run typecheck", "bun test"]),
	clean("fc-round-module", "firecode", "3b8197a", "hold", ["refactor", "large"],
		`轮记录收拢到根目录 round.ts：测量、格式、合成规则、读取、字样与写记录的记录器都在这一处；busy.ts 只做会话进行中的聚合；tools/round.ts 只留宿主渲染适配。输入框外壳的落定态与摘要行读同一份轮记录、同一条合成规则。
${FC_TAIL}`,
		["bun run typecheck", "bun test tests/round.test.ts tests/statusbar.test.ts tests/tool-groups.test.ts"]),
	clean("pi-list-files", "pi", "abfe62928", "opt", ["external"],
		`packages/env 与 packages/durable：ExecutionEnv 增加可选的 listFiles，列出目录下的文件、目录与符号链接——相对路径、深度优先按名字排序、跳过 .git 与工作树里 git 忽略的内容，有上限并带 truncated 标记。调用方在它缺失或报 not_supported 时退回自己的遍历。env 的一致性测试套件用新的 listFiles 选项检查它。遵守仓库 AGENTS.md，跑受影响包的类型检查与相关测试。`,
		["cd packages/env && npx tsc --noEmit -p tsconfig.build.json", "cd packages/durable && npx tsc --noEmit -p tsconfig.build.json"]),
	clean("pi-responses-tool-cache", "pi", "caa6967b6", "hold", ["external", "cache"],
		`packages/ai：Responses 上工具集变化时保住提示缓存（#10940）。带 additional_tools 的模型把每个工具都声明在 additional_tools 条目里、输入开头先放一条（与 Codex 一致）；后面的条目可以覆盖前面同名的定义，但不能覆盖顶层工具也不能移除工具，所以移除用文本宣布，之后的更新重述仍不可用的工具。工具搜索与 Kimi 的工具消息每次移除或重声明时只挪一次顶层工具表，之后的加载保持锚定，不在第一次移除后的每次加载都重发整张工具表。遵守仓库 AGENTS.md，跑受影响包的类型检查与相关测试。`,
		["cd packages/ai && npx tsc --noEmit -p tsconfig.build.json", "cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/transcript-tool-changes.test.ts"]),
];

export function caseById(id: string): Case {
	const found = CASES.find((item) => item.id === id);
	if (!found) throw new Error(`没有用例 ${id}`);
	return found;
}

export function selectCases(spec: string): Case[] {
	if (spec === "all") return CASES;
	if (spec === "opt" || spec === "hold") return CASES.filter((item) => item.set === spec);
	return spec.split(",").filter(Boolean).map(caseById);
}

export const headOf = (item: Case): string => item.turns.at(-1)!.to;
