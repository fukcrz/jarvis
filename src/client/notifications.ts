/**
 * 会话运行结束的浏览器通知（Notification API）。
 *
 * 规则：
 * - 仅当 jarvis 标签页位于后台（document.hidden）时弹出，前台不打扰；
 * - 需要用户授予通知权限（在设置页开启开关时请求，浏览器要求用户手势）；
 * - 多个标签页同时在线时通过 BroadcastChannel 协调，同一 run 只弹一次
 *   （声明最早的那个标签页负责弹出）。
 */

const ENABLED_KEY = "jarvis:notifications:enabled";
const CHANNEL_NAME = "jarvis:run-notifications";
const CLAIM_WINDOW_MS = 300;
const REMEMBER_MS = 10_000;
const BODY_LIMIT = 140;

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";
export type NotificationResult = "skipped" | "unsupported";

export interface RunNotificationInfo {
  runId: string;
  failed: boolean;
  /** 最后一条助手消息文本，用作完成通知的正文预览。 */
  text?: string;
  /** 失败原因（run.failed 的 lastError.message）。 */
  errorMessage?: string;
  sessionName?: string;
}

export function isNotificationEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setNotificationEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(ENABLED_KEY);
    else window.localStorage.setItem(ENABLED_KEY, "0");
  } catch {
    // 存储不可用（隐私模式等）时忽略，默认开启。
  }
}

export function notificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  return window.Notification.permission;
}

/** 必须在用户手势中调用，否则浏览器会拒绝请求。返回最终权限状态。 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const current = notificationPermission();
  if (current === "unsupported" || current !== "default") return current;
  try {
    return (await window.Notification.requestPermission()) as NotificationPermissionState;
  } catch {
    return notificationPermission();
  }
}

/** 纯函数：组装通知标题与正文。 */
export function runNotificationContent(info: RunNotificationInfo): { title: string; body: string } {
  const name = info.sessionName === undefined || info.sessionName === "" ? "Jarvis" : info.sessionName;
  if (info.failed) {
    const message = info.errorMessage?.trim() ?? info.text?.trim() ?? "";
    return {
      title: `${name} · 运行失败`,
      body: message === "" ? "会话运行失败，请查看详情" : message,
    };
  }
  const text = (info.text ?? "").trim().replace(/\s+/g, " ");
  return {
    title: `${name} · 已完成`,
    body: text === "" ? "回答已完成" : text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text,
  };
}

interface ChannelMessage {
  type: "notified";
  runId: string;
  at: number;
}

let channel: BroadcastChannel | undefined;
function notificationChannel(): BroadcastChannel | undefined {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = undefined;
    }
  }
  return channel;
}

/** 本页最近弹过的 runId（冷却期，防同一 run 的重复事件再次触发）。 */
const notifiedLocally = new Set<string>();
/** 其他标签页对某个 runId 的最早声明时间戳。 */
const earliestOtherClaim = new Map<string, number>();
/** 本页待决声明：等待窗口结束后决定是否弹出。 */
const pendingClaims = new Map<string, { myAt: number; timer: ReturnType<typeof setTimeout> }>();
let channelListenerInstalled = false;

function installChannelListener(): void {
  if (channelListenerInstalled) return;
  channelListenerInstalled = true;
  const current = notificationChannel();
  if (current === undefined) return;
  current.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as ChannelMessage | undefined;
    if (message === undefined || message.type !== "notified" || typeof message.runId !== "string") return;
    const previous = earliestOtherClaim.get(message.runId);
    if (previous === undefined || message.at < previous) earliestOtherClaim.set(message.runId, message.at);
    const pending = pendingClaims.get(message.runId);
    // 他人声明更早：取消本页待决的弹出，避免重复。
    if (pending !== undefined && message.at < pending.myAt) {
      clearTimeout(pending.timer);
      pendingClaims.delete(message.runId);
    }
  });
}

function showRunNotification(info: RunNotificationInfo): void {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return;
  if (!document.hidden) return; // 等待窗口期间用户回到前台，不再打扰
  const { title, body } = runNotificationContent(info);
  const notification = new window.Notification(title, { body, tag: `jarvis-run:${info.runId}` });
  notification.addEventListener("click", () => {
    window.focus();
    notification.close();
  });
}

/**
 * 会话 run 结束时调用。
 * - "unsupported"：浏览器不支持通知；
 * - "skipped"：条件不满足（前台/未授权/开关关闭/他人已声明），或已进入
 *   延迟协调窗口（窗口结束后由最早声明者弹出）。
 */
export function notifyRunFinished(info: RunNotificationInfo): NotificationResult {
  const permission = notificationPermission();
  if (permission === "unsupported") return "unsupported";
  if (!isNotificationEnabled()) return "skipped";
  if (permission !== "granted") return "skipped";
  if (typeof document !== "undefined" && !document.hidden) return "skipped";
  if (notifiedLocally.has(info.runId) || earliestOtherClaim.has(info.runId)) return "skipped";

  installChannelListener();
  const current = notificationChannel();
  const myAt = Date.now();
  current?.postMessage({ type: "notified", runId: info.runId, at: myAt } satisfies ChannelMessage);

  const existing = pendingClaims.get(info.runId);
  if (existing !== undefined) {
    // 同页对同一 run 的重复事件：沿用首个声明，不叠加等待窗口。
    if (existing.myAt <= myAt) return "skipped";
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    pendingClaims.delete(info.runId);
    const earliest = earliestOtherClaim.get(info.runId);
    if (earliest !== undefined && earliest < myAt) return; // 其他标签页先声明，由它弹出
    notifiedLocally.add(info.runId);
    setTimeout(() => notifiedLocally.delete(info.runId), REMEMBER_MS);
    showRunNotification(info);
  }, CLAIM_WINDOW_MS);
  pendingClaims.set(info.runId, { myAt, timer });
  return "skipped";
}
