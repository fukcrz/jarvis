import type { SubagentThreadRow } from "../../shared/protocol";

export interface SubagentThreadCounts {
  /** 正在执行（starting / running）。 */
  running: number;
  /** 停在轮边界、不会自己往前走的线程。 */
  paused: number;
}

export function subagentThreadCounts(threads: SubagentThreadRow[] | undefined): SubagentThreadCounts {
  let running = 0;
  let paused = 0;
  for (const thread of threads ?? []) {
    if (thread.state === "running") running += 1;
    else paused += 1;
  }
  return { running, paused };
}

/** 未结束的线程总数；为 0 时不显示状态行。 */
export function subagentThreadTotal(threads: SubagentThreadRow[] | undefined): number {
  const { running, paused } = subagentThreadCounts(threads);
  return running + paused;
}

/** 状态行文案：只说现在有几个没结束，不报历史、不报失败。 */
export function subagentStatusLabel(threads: SubagentThreadRow[] | undefined): string | undefined {
  const { running, paused } = subagentThreadCounts(threads);
  if (running > 0 && paused > 0) return `${String(running)} 个子代理执行中 · ${String(paused)} 已暂停`;
  if (running > 0) return `${String(running)} 个子代理执行中`;
  if (paused > 0) return `${String(paused)} 个子代理已暂停`;
  return undefined;
}

/** 窄屏只保留计数与状态。 */
export function subagentStatusLabelCompact(threads: SubagentThreadRow[] | undefined): string | undefined {
  const { running, paused } = subagentThreadCounts(threads);
  if (running > 0) return `${String(running + paused)} 执行中`;
  if (paused > 0) return `${String(paused)} 已暂停`;
  return undefined;
}

/** 线程本次运行已跑多久，m:ss。paused 线程的时长已冻结，不随当前时间增长。 */
export function subagentElapsed(thread: Pick<SubagentThreadRow, "startedAt" | "elapsedMs">, now: number): string | undefined {
  if (thread.elapsedMs !== undefined) return formatElapsedMs(thread.elapsedMs);
  if (thread.startedAt === undefined) return undefined;
  const started = Date.parse(thread.startedAt);
  if (!Number.isFinite(started)) return undefined;
  return formatElapsedMs(now - started);
}

function formatElapsedMs(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 点状态行里的线程，滚到对应的子代理卡片并闪一下。
 * 卡片不在已加载的时间线里时就什么都不做——那说明它已经滚出窗口，用户自己翻即可。
 */
export function revealSubagentThread(path: string): void {
  const target = document.querySelector<HTMLElement>(`[data-subagent-paths~="${CSS.escape(path)}"]`);
  if (target === null) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("subagent-flash");
  // 同一帧里 remove + add 会被合并，先读一次布局强制重排。
  void target.offsetWidth;
  target.classList.add("subagent-flash");
  window.setTimeout(() => target.classList.remove("subagent-flash"), 1_200);
}
