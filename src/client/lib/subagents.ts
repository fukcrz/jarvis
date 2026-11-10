import type { SubagentThreadRow } from "../../shared/protocol";

/** 点线程要回溯多少页历史；超过就承认找不到。 */
const SUBAGENT_REACH_PAGE_LIMIT = 20;

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

/** 状态行文案：只在有线程真正在跑时出现。
 * paused 只作为后缀：它停在轮边界、不会自己往前走，单独挂着只会在工具栏里长期占位。
 */
export function subagentStatusLabel(threads: SubagentThreadRow[] | undefined): string | undefined {
  const { running, paused } = subagentThreadCounts(threads);
  if (running === 0) return undefined;
  if (paused > 0) return `${String(running)} 个子代理执行中 · ${String(paused)} 已暂停`;
  return `${String(running)} 个子代理执行中`;
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
 * 找到线程对应的卡片元素。卡片可能因所在回合的过程块折叠而未渲染。
 */
export function subagentCard(path: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-subagent-paths~="${CSS.escape(path)}"]`);
}

/** 下一页渲染完后才算真正可见，等两帧。 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
  });
}

/**
 * 点状态行里的线程，滚到对应的子代理卡片并闪一下。
 * 卡片在折叠的过程块里时逐层展开（从最近的回合往上找），展开后仍没有则返回 false。
 */
export async function revealSubagentThread(path: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  let card = subagentCard(path);
  if (card === null) {
    const collapsed = [...document.querySelectorAll<HTMLElement>(".turn-process-summary[aria-expanded='false']")].reverse();
    for (const summary of collapsed) {
      summary.click();
      await nextPaint();
      card = subagentCard(path);
      if (card !== null) break;
    }
  }
  if (card === null) return false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("subagent-flash");
  // 同一帧里 remove + add 会被合并，先读一次布局强制重排。
  void card.offsetWidth;
  card.classList.add("subagent-flash");
  window.setTimeout(() => card?.classList.remove("subagent-flash"), 1_200);
  return true;
}

/** 往回翻页直到卡片出现；每翻一页先试着展开+滚动。loadEarlier 返回是否还有更早的历史。 */
export async function reachSubagentCard(path: string, loadEarlier: () => Promise<boolean>): Promise<boolean> {
  if (await revealSubagentThread(path)) return true;
  for (let page = 0; page < SUBAGENT_REACH_PAGE_LIMIT; page += 1) {
    if (!(await loadEarlier())) break;
    if (await revealSubagentThread(path)) return true;
  }
  return false;
}
