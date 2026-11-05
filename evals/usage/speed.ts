/**
 * 只读本机 Pi 会话，统计指挥官等待、子代理运行与审查、耗时分解和模型速度。
 * 用法：bun evals/usage/speed.ts [--since YYYY-MM-DD] [--project 目录名子串]
 * 按会话文件名日期和 sessions 下项目目录筛选；百分位取排序后 floor(n*p) 项。
 * 等待从无工具调用的助手回复到下一次事件，用户消息会终止等待；运行和审查耗时取事件正文。
 * 生成时间是用户消息或工具结果到下一助手回复；并发工具分别计时，合计可能超过墙钟时间。
 * 输出速度包含主会话和子会话，取输出至少 300 token、耗时 1–600 秒的回复，含首 token 等待。
 * 审查耗时仅取事件中的本次运行，缺失时只计终态次数，不以当前任务耗时代替。
 * 首次编辑从子会话首条任务到首次 edit/write 调用；未发生编辑的会话不计。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Obj = Record<string, any>;
const args = process.argv.slice(2);
let since = "", project = "";
for (let i = 0; i < args.length; i++) {
 const key = args[i], value = args[++i];
 if (!value || (key !== "--since" && key !== "--project")) throw new Error("用法: [--since YYYY-MM-DD] [--project 目录名子串]");
 if (key === "--since") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("日期须为 YYYY-MM-DD");
  since = value;
 } else project = value;
}
const root = join(getAgentDir(), "sessions");
const waits: number[] = [], edits: number[] = [];
const runtimes = new Map<string, number[]>(), reviews = new Map<string, number[]>(), rates = new Map<string, number[]>();
const starts = new Map<string, number>(), reviewCounts = new Map<number, number>(), reviewTotals = new Map<string, number>();
const time = new Map<string, number>();
function add(map: Map<string, number[]>, key: string, value: number) { const list = map.get(key) ?? []; list.push(value); map.set(key, list); }
function count<K>(map: Map<K, number>, key: K, n = 1) { map.set(key, (map.get(key) ?? 0) + n); }
function stats(values: number[], scale = 1) {
 if (!values.length) return "0\t-\t-\t0.0";
 const v = values.toSorted((a, b) => a - b);
 return `${v.length}\t${(v[Math.floor(v.length * .5)] / scale).toFixed(1)}\t${(v[Math.floor(v.length * .9)] / scale).toFixed(1)}\t${(v.reduce((a, b) => a + b, 0) / 3600).toFixed(1)}`;
}
function duration(s: string) {
 let seconds = 0;
 for (const m of s.matchAll(/(\d+)(h|m|s)/g)) seconds += Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]] ?? 0);
 return seconds;
}
function toolKind(call: Obj) {
 const s = call.arguments?.command ?? call.arguments?.code ?? '';
 if (/\b(bun|npm|pnpm|yarn) (run )?test|go test|pytest|cargo test|vitest|jest|xcodebuild test|swift test|make test/.test(s)) return '测试';
 if (/gh run watch|gh pr checks|sleep /.test(s)) return '等待';
 if (/build|tsc|typecheck|lint|xcodebuild/.test(s)) return '构建/类型检查';
 return '其他';
}
function rememberRoles(value: unknown, roles: Map<string, string>) {
 if (!value || typeof value !== 'object') return;
 if (Array.isArray(value)) { for (const item of value) rememberRoles(item, roles); return; }
 const obj = value as Obj;
 if (typeof obj.name === 'string' && typeof obj.role === 'string') roles.set(obj.name, obj.role);
 for (const child of Object.values(obj)) {
  if (typeof child === 'string') {
   for (const match of child.matchAll(/"name"\s*:\s*"([^"]+)"\s*,\s*"role"\s*:\s*"([^"]+)"/g)) roles.set(match[1], match[2]);
   if (/^[\s]*[\[{]/.test(child)) { try { rememberRoles(JSON.parse(child), roles); } catch {} }
  } else if (typeof child === 'object') rememberRoles(child, roles);
 }
}
function startCall(a: Obj, roles: Map<string, string>) {
 if (a.action !== 'start' || typeof a.role !== 'string') return;
 count(starts, a.role);
 if (typeof a.worker === 'string') roles.set(a.worker, a.role);
}
const title = /^(?:<firecode_master_event>\s*)?(\S+) (已返回|审查通过|审查停止|审查未完成|审查被中断|审查被取消|失败|被中断|returned|review passed|review stopped|review incomplete|review interrupted|review cancelled|failed|interrupted)(?:（(\d+) 轮）| \((\d+) rounds?\))?/;
async function processFile(path: string, worker: boolean) {
 const roles = new Map<string, string>(), perWorkerReviews = new Map<string, number>();
 const pending = new Map<string, [number, string]>();
 let lastEnd: number | undefined, inTurn = false, previous: number | undefined, task: number | undefined, edited = false;
 const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
 for await (const line of lines) {
  let e: Obj;
  try { e = JSON.parse(line); } catch { continue; }
  const t = Date.parse(e.timestamp) / 1000;
  if (!Number.isFinite(t)) continue;
  if (!worker && e.type === 'custom_message' && e.customType === 'firecode-master-event') {
   if (!inTurn && lastEnd !== undefined) waits.push(t - lastEnd);
   inTurn = true;
   const body = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '');
   const blocks = body.split(/\n(?=\S+ (?:已返回|审查通过|审查停止|审查未完成|审查被中断|审查被取消|失败|被中断|returned|review passed|review stopped|review incomplete|review interrupted|review cancelled|failed|interrupted))/);
   for (const block of blocks) {
    const m = block.match(title);
    if (!m) continue;
    const run = block.match(/(?:耗时：本次运行 |Elapsed: This run )([0-9hms]+)/);
    const seconds = run ? duration(run[1]) : undefined;
    if (seconds !== undefined) add(runtimes, roles.get(m[1]) ?? '?', seconds);
    if (m[2].startsWith('审查') || m[2].startsWith('review ')) {
     const key = m[2] + (m[3] || m[4] ? ` (${m[3] || m[4]} 轮)` : '');
     count(reviewTotals, key);
     const list = reviews.get(key) ?? [];
     if (seconds !== undefined) list.push(seconds);
     reviews.set(key, list);
     count(perWorkerReviews, m[1]);
    }
   }
   continue;
  }
  if (e.type !== 'message' || !e.message) continue;
  const m = e.message as Obj;
  if (m.role === 'user' || m.role === 'toolResult') {
   previous = t;
   if (m.role === 'user') { inTurn = true; if (worker && task === undefined) task = t; }
   if (m.role === 'toolResult') {
    if (!worker) rememberRoles(m, roles);
    const p = pending.get(m.toolCallId);
    if (p) { count(time, p[1], t - p[0]); pending.delete(m.toolCallId); }
   }
   continue;
  }
  if (m.role !== 'assistant') continue;
  if (previous !== undefined) {
   const elapsed = t - previous;
   if (worker) count(time, '模型生成', elapsed);
   if (m.usage?.output >= 300 && elapsed > 1 && elapsed < 600) add(rates, m.model ?? '?', m.usage.output / elapsed);
   previous = undefined;
  }
  const calls = (m.content ?? []).filter((c: Obj) => c.type === 'toolCall');
  if (!worker && calls.length === 0) { inTurn = false; lastEnd = t; }
  for (const c of calls) {
   const a = c.arguments ?? {};
   if (!worker && c.name === 'subagents') startCall(a, roles);
   if (!worker && c.name === 'codemode' && typeof a.code === 'string' && a.code.includes('tools.subagents')) {
    for (const object of a.code.matchAll(/\{[^{}]*\}/gs)) {
     const action = object[0].match(/\baction["']?\s*:\s*["']([^"']+)/);
     const role = object[0].match(/\brole["']?\s*:\s*["']([^"']+)/);
     const name = object[0].match(/\bworker["']?\s*:\s*["']([^"']+)/);
     if (action && role) startCall({ action: action[1], role: role[1], worker: name?.[1] }, roles);
    }
   }
   if (worker) {
    pending.set(c.id, [t, toolKind(c)]);
    if (!edited && task !== undefined && (c.name === 'edit' || c.name === 'write' || (c.name === 'codemode' && /tools\.(edit|write)\b/.test(a.code ?? '')))) { edits.push(t - task); edited = true; }
   }
  }
 }
 for (const name of roles.keys()) if (!perWorkerReviews.has(name)) perWorkerReviews.set(name, 0);
 for (const n of perWorkerReviews.values()) count(reviewCounts, n);
}
const projects = await readdir(root, { withFileTypes: true });
let files = 0;
for (const dir of projects) {
 if (!dir.isDirectory() || !dir.name.includes(project)) continue;
 const base = join(root, dir.name);
 for (const entry of await readdir(base, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.slice(0, 10) >= since) { await processFile(join(base, entry.name), false); files++; }
  if (entry.isDirectory() && entry.name === 'subagents') {
   for (const name of await readdir(join(base, entry.name))) {
    if (name.endsWith('.jsonl') && name.slice(0, 10) >= since) { await processFile(join(base, entry.name, name), true); files++; }
   }
  }
 }
}
console.log(`会话文件 ${files}；日期 ${since || '全部'}；项目 ${project || '全部'}`);
console.log('指标\t次数\tp50 分钟\tp90 分钟\t合计小时');
console.log(`指挥官等待\t${stats(waits, 60)}`);
for (const [role, values] of runtimes) console.log(`运行 ${role}\t${stats(values, 60)}`);
console.log('审查结局与轮数\t终态次数\t带耗时次数\tp50 分钟\tp90 分钟\t合计小时');
for (const [key, values] of reviews) console.log(`${key}\t${reviewTotals.get(key)}\t${stats(values, 60)}`);
console.log(`首次编辑\t${stats(edits, 60)}`);
console.log('角色 start 次数');
for (const [role, n] of starts) console.log(`${role}\t${n}`);
console.log('每个子代理审查次数分布（同一主会话同名计一个）');
for (const [n, workers] of [...reviewCounts].sort((a, b) => a[0] - b[0])) console.log(`${n} 次\t${workers} 个`);
console.log('子代理时间分解（小时）');
for (const [kind, seconds] of time) console.log(`${kind}\t${(seconds / 3600).toFixed(1)}`);
console.log('模型\t次数\tp50 token/秒\tp90 token/秒');
for (const [model, values] of rates) { const v = values.toSorted((a, b) => a - b); console.log(`${model}\t${v.length}\t${v[Math.floor(v.length * .5)].toFixed(1)}\t${v[Math.floor(v.length * .9)].toFixed(1)}`); }
