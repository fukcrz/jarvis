/**
 * 长任务停滞保险：主代理结束回合后，若任务清单里还有未完成项、又没有任何子代理在跑，
 * 说明整条任务会静默卡死（没有任何事件会再唤醒主代理），此时由插件补一次唤醒。
 *
 * 判定留在纯函数里，便于测试；文件读取与唤醒交给调用侧。
 */

/** 两次自动唤醒的最小间隔。 */
export const TASK_WATCH_COOLDOWN_MS = 45_000;
/** 同一份清单最多自动唤醒几次，超过就停下等用户。 */
export const TASK_WATCH_MAX = 5;
/** 唤醒消息里最多列出多少条未完成项。 */
const TASK_WATCH_MAX_LINES = 10;

export interface TaskWatchState {
  /** 未完成项指纹；变化即视为有进展，唤醒计数归零。 */
  signature: string;
  wakes: number;
  at: number;
}

export const INITIAL_TASK_WATCH: TaskWatchState = { signature: "", wakes: 0, at: 0 };

/** 读取 `- [ ]` 形式的未完成项；已完成与普通行忽略。 */
export function unfinishedTasks(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[\s\]\s+(.+)$/.exec(line);
    if (!match) continue;
    items.push(match[1]!.trim());
    if (items.length >= TASK_WATCH_MAX_LINES) break;
  }
  return items;
}

export interface TaskWatchDecision {
  wake: boolean;
  pending: string[];
  signature: string;
  state: TaskWatchState;
}

export function taskWatchDecision(input: {
  /** 清单文件内容；文件不存在或未配置时为 undefined。 */
  text: string | undefined;
  /** 全局未结束的后台线程数（含孙代理）。 */
  outstandingAsync: number;
  /** 已有待执行的回合安排，不要再插一条。 */
  busy: boolean;
  state: TaskWatchState;
  now: number;
}): TaskWatchDecision {
  const pending = input.text === undefined ? [] : unfinishedTasks(input.text);
  const signature = pending.join("\n");
  if (pending.length === 0)
    return { wake: false, pending, signature, state: { ...INITIAL_TASK_WATCH, signature } };

  // 清单内容变了说明有进展，重新给自动唤醒配额。
  const state: TaskWatchState =
    signature === input.state.signature
      ? { ...input.state, signature }
      : { signature, wakes: 0, at: input.state.at };
  const skip = { wake: false, pending, signature, state };

  if (input.busy || input.outstandingAsync > 0) return skip;
  if (state.wakes >= TASK_WATCH_MAX) return skip;
  if (input.now - state.at < TASK_WATCH_COOLDOWN_MS) return skip;

  return {
    wake: true,
    pending,
    signature,
    state: { signature, wakes: state.wakes + 1, at: input.now },
  };
}
