import type { SubagentCallState, SubagentCallView, SubagentUsageView, ThinkingLevel, TimelineItem } from "../../shared/protocol";
import { formatElapsedMs } from "./subagents";

/** 侧栏里的一行线程：由时间线里的 agent_* 工具卡片摊平而来。 */
export interface SubagentPanelThread {
  /** 同一会话内稳定唯一，用于选中态。 */
  key: string;
  /** 线程路径（/root/...）；插件没给路径时缺省。 */
  path?: string;
  agent: string;
  /** 任务的短标签。 */
  label?: string;
  prompt: string;
  state: SubagentCallState;
  /** path 的层级深度，用来缩进。 */
  depth: number;
  startedAt?: string;
  durationMs?: number;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  usage?: SubagentUsageView;
  steps: Array<{ kind: "thinking" | "text" | "tool"; label?: string; text: string }>;
  output?: string;
  error?: string;
  /** 列表页第二行：当前动作。 */
  line: string;
}

const LINE_MAX_CHARS = 80;
const TOOL_STATE_WORD = /^(?:finished|started|running|failed|ok)$/i;

export function isActiveThread(thread: SubagentPanelThread): boolean {
  return thread.state === "running" || thread.state === "partial";
}

/** 摊平时间线里的子代理调用；同一线程出现多次时保留最后一次的状态。 */
export function subagentPanelThreads(items: readonly TimelineItem[]): SubagentPanelThread[] {
  const byPath = new Map<string, SubagentPanelThread>();
  const collected: SubagentPanelThread[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.subagent === undefined) continue;
    item.subagent.results.forEach((call, index) => {
      const thread = threadFromCall(call, `${item.id}:${String(call.callIndex ?? index)}`);
      if (thread.path !== undefined && byPath.has(thread.path)) {
        const previous = byPath.get(thread.path) as SubagentPanelThread;
        collected[collected.indexOf(previous)] = thread;
        byPath.set(thread.path, thread);
        return;
      }
      if (thread.path !== undefined) byPath.set(thread.path, thread);
      collected.push(thread);
    });
  }
  return collected.map((thread) => ({ ...thread, depth: pathDepth(thread.path) }));
}

/** 进行中在前（按开始时间），已结束在后（保持派发顺序）。 */
export function groupSubagentThreads(threads: readonly SubagentPanelThread[]): { active: SubagentPanelThread[]; finished: SubagentPanelThread[] } {
  const active: SubagentPanelThread[] = [];
  const finished: SubagentPanelThread[] = [];
  for (const thread of threads) (isActiveThread(thread) ? active : finished).push(thread);
  active.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));
  return { active, finished };
}

export function runningThreadCount(threads: readonly SubagentPanelThread[]): number {
  return threads.filter((thread) => thread.state === "running").length;
}

export function formatThreadElapsed(thread: SubagentPanelThread, now = Date.now()): string | undefined {
  if (thread.durationMs !== undefined) return formatElapsedMs(thread.durationMs);
  if (thread.startedAt === undefined || !isActiveThread(thread)) return undefined;
  const started = Date.parse(thread.startedAt);
  if (Number.isNaN(started)) return undefined;
  return formatElapsedMs(Math.max(0, now - started));
}

export function formatTokenCount(total: number | undefined): string | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  if (total < 1000) return `${String(Math.round(total))} tok`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`;
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

export function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return undefined;
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** 详情页的一行元信息：模型 · 思考 · tokens · 费用。 */
export function threadMeta(thread: SubagentPanelThread): string[] {
  const parts: string[] = [];
  if (thread.model !== undefined && thread.model.length > 0) parts.push(thread.model);
  if (thread.thinkingLevel !== undefined) parts.push(`thinking ${thread.thinkingLevel}`);
  const tokens = formatTokenCount(thread.usage?.total);
  if (tokens !== undefined) parts.push(tokens);
  const cost = formatCost(thread.usage?.cost);
  if (cost !== undefined) parts.push(cost);
  return parts;
}

export function threadStateLabel(thread: SubagentPanelThread): string {
  switch (thread.state) {
    case "running": return "运行中";
    case "partial": return "已暂停";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已停止";
  }
}

function threadFromCall(call: SubagentCallView, key: string): SubagentPanelThread {
  const steps = (call.recentSteps ?? []).flatMap((step) => {
    const parsed = statusStep(step);
    return parsed === undefined ? [] : [parsed];
  });
  const thread: SubagentPanelThread = {
    key: call.label !== undefined && call.label.length > 0 ? call.label : key,
    agent: call.agent,
    prompt: call.prompt,
    state: call.state,
    depth: 0,
    steps,
    line: "",
  };
  if (call.label !== undefined && call.label.trim().length > 0) thread.label = call.label;
  if (call.label !== undefined && call.label.startsWith("/")) thread.path = call.label;
  if (call.startedAt !== undefined) thread.startedAt = call.startedAt;
  if (call.durationMs !== undefined) thread.durationMs = call.durationMs;
  if (call.model !== undefined) thread.model = call.model;
  if (call.thinkingLevel !== undefined) thread.thinkingLevel = call.thinkingLevel;
  if (call.usage !== undefined) thread.usage = call.usage;
  if (call.output !== undefined) thread.output = call.output;
  if (call.error !== undefined) thread.error = call.error;
  thread.line = threadLine(thread);
  return thread;
}

function threadLine(thread: SubagentPanelThread): string {
  if (thread.state === "failed" && thread.error !== undefined) return truncate(thread.error);
  const last = thread.steps.at(-1);
  if (last !== undefined) {
    if (last.text.length > 0) return truncate(last.text);
    if (last.label !== undefined) return last.label;
  }
  const output = thread.output?.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (output !== undefined) return truncate(output);
  return truncate(thread.prompt);
}

function truncate(text: string): string {
  const flat = plainText(text.replaceAll("\n", " ")).trim();
  return flat.length <= LINE_MAX_CHARS ? flat : `${flat.slice(0, LINE_MAX_CHARS - 1)}…`;
}

/** 工具步骤的摘要常带插件自己的前缀，去掉后行内才不会重复工具名。 */
function toolText(text: string): string {
  return text.replace(/^Tool:\s*/i, "");
}

/**
 * pi-subagent-manager 的过程只有一行状态文本，插件有两种写法：`Tool: bash` 与 `Tool bash: finished`，
 * 都没有工具名字段。这里解析出工具名当标签；`finished` 这类纯状态词只重复行内状态点，不入正文。
 * 只用于剥离开头这段状态提示，`Tool` 前缀只出现一次，正则不回溯。
 */
function statusStep(step: { kind: "thinking" | "text" | "tool"; text?: string; name?: string; summary?: string }): { kind: "thinking" | "text" | "tool"; label?: string; text: string } | undefined {
  if (step.kind === "tool") {
    const text = toolText(step.summary ?? step.name ?? "").trim();
    if (text.length === 0) return undefined;
    return step.name === undefined ? { kind: "tool", text: plainText(text) } : { kind: "tool", label: step.name, text: plainText(text) };
  }
  const raw = (step.text ?? "").trim();
  if (raw.length === 0) return undefined;
  const tool = /^Tool\s*:?\s*([^\s:]+)\s*:?\s*(.*)$/i.exec(raw);
  if (tool === null) return { kind: step.kind, text: plainText(raw) };
  const detail = plainText((tool[2] as string).trim());
  return { kind: "tool", label: (tool[1] as string).toLowerCase(), text: TOOL_STATE_WORD.test(detail) ? "" : detail };
}

/** 动作行是纯文本：去掉插件输出里的 markdown 强调与行内代码标记。 */
function plainText(text: string): string {
  return text.replaceAll(/\*\*(.+?)\*\*/g, "$1").replaceAll(/__(.+?)__/g, "$1").replaceAll(/`([^`]+)`/g, "$1");
}

function pathDepth(path: string | undefined): number {
  if (path === undefined) return 0;
  return Math.max(0, path.split("/").filter((part) => part.length > 0).length - 2);
}

/** 线程在契约里没有展示名时用路径尾段当标题。 */
export function threadTitle(thread: SubagentPanelThread): string {
  if (thread.path !== undefined) return thread.path;
  if (thread.label !== undefined) return thread.label;
  return thread.agent;
}
