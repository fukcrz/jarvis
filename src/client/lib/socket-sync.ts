import { isRecord, type SessionEvent, type SessionSummary } from "../../shared/protocol";
import { isEmptySession, sortSessionSummaries } from "../../shared/session-sort";

const EMPTY_VIEWED_IDLE_KEYS: ReadonlySet<string> = new Set();

export {
  parseSocketHeartbeat,
  SOCKET_HEARTBEAT_INTERVAL_MS,
  SOCKET_PING_TYPE,
  SOCKET_PONG_TYPE,
  socketHeartbeatMessage,
} from "../../shared/socket-heartbeat";

/** 前台期间若这么久收不到任何帧（含 ping），视为半开连接并重连。 */
export const SOCKET_STALE_MS = 20_000;
/** 前台客户端主动 ping，撑住 NAT / 反向代理空闲超时。 */
export const SOCKET_CLIENT_PING_INTERVAL_MS = 12_000;
export const SOCKET_WATCHDOG_INTERVAL_MS = 4_000;
export const SOCKET_RECONNECT_COOLDOWN_MS = 1_200;

/** CONNECTING / OPEN / CLOSING / CLOSED — 与浏览器 WebSocket 常量一致。 */
export type SocketReadyState = 0 | 1 | 2 | 3;

export function shouldReconnectVisibleSocket(input: {
  visible: boolean;
  online: boolean;
  readyState: SocketReadyState | number;
  lastEventAt: number;
  now: number;
  lastReconnectAt: number;
  staleMs?: number;
  cooldownMs?: number;
}): boolean {
  if (!input.visible || !input.online) return false;
  const cooldown = input.cooldownMs ?? SOCKET_RECONNECT_COOLDOWN_MS;
  if (input.now - input.lastReconnectAt < cooldown) return false;
  if (input.readyState === 0 || input.readyState === 2) return false;
  if (input.readyState !== 1) return true;
  return input.now - input.lastEventAt >= (input.staleMs ?? SOCKET_STALE_MS);
}

export function shouldFlushStreamEventImmediately(hidden: boolean, type: string): boolean {
  if (hidden) return true;
  return type === "run.settled" || type === "run.failed";
}

export function coalesceStreamEvents(events: SessionEvent[]): SessionEvent[] {
  const result: SessionEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    const previousPayload = previous?.type === "assistant.delta" && isRecord(previous.payload) ? previous.payload : undefined;
    const payload = event.type === "assistant.delta" && isRecord(event.payload) ? event.payload : undefined;
    const sameMessage = previousPayload?.["messageId"] === payload?.["messageId"];
    if (previous !== undefined && previous.type === "assistant.delta" && event.type === "assistant.delta" && sameMessage && typeof previousPayload?.["delta"] === "string" && typeof payload?.["delta"] === "string") {
      result[result.length - 1] = { ...event, payload: { messageId: payload["messageId"], delta: previousPayload["delta"] + payload["delta"] } };
      continue;
    }
    const previousBash = previous?.type === "bash.delta" && isRecord(previous.payload) ? previous.payload : undefined;
    const bashPayload = event.type === "bash.delta" && isRecord(event.payload) ? event.payload : undefined;
    if (previous !== undefined && previous.type === "bash.delta" && event.type === "bash.delta" && previous.runId === event.runId && typeof previousBash?.["delta"] === "string" && typeof bashPayload?.["delta"] === "string") {
      result[result.length - 1] = { ...event, payload: { delta: previousBash["delta"] + bashPayload["delta"] } };
      continue;
    }
    const previousThinking = previous?.type === "thinking.delta" && isRecord(previous.payload) ? previous.payload : undefined;
    const thinkingPayload = event.type === "thinking.delta" && isRecord(event.payload) ? event.payload : undefined;
    const sameThinking = previousThinking?.["thinkingId"] === thinkingPayload?.["thinkingId"];
    if (previous !== undefined && previous.type === "thinking.delta" && event.type === "thinking.delta" && sameThinking && typeof previousThinking?.["delta"] === "string" && typeof thinkingPayload?.["delta"] === "string") {
      result[result.length - 1] = { ...event, payload: { thinkingId: thinkingPayload["thinkingId"], createdAt: thinkingPayload["createdAt"], delta: previousThinking["delta"] + thinkingPayload["delta"] } };
      continue;
    }
    result.push(event);
  }
  return result;
}

export function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

/** 点开空闲会话后立刻去掉完成/失败圆点，不必等 /viewed 返回。 */
export function clearIdleAttention(session: SessionSummary): SessionSummary {
  if (session.runState !== "idle") return session;
  if (session.attentionState === undefined || session.attentionState === "idle" || session.attentionState === "waiting_interaction") return session;
  const next = { ...session, attentionState: "idle" as const };
  delete next.attentionAt;
  return next;
}

/**
 * 用户刚把空闲会话标为已读后，迟到的 completed_unread / failed 不得盖回圆点。
 * 新的 running / waiting 会清掉这个保护。
 */
export function shouldKeepViewedIdle(incoming: SessionSummary): boolean {
  return incoming.runState === "idle"
    && (incoming.attentionState === "completed_unread" || incoming.attentionState === "failed");
}

/** 新任务开始后，允许下一次完成/失败重新亮点。 */
export function touchViewedIdleKeys(keys: Set<string>, incoming: SessionSummary): void {
  const key = sessionKey(incoming.workspaceId, incoming.id);
  if (!keys.has(key) || shouldKeepViewedIdle(incoming)) return;
  if (incoming.runState !== "idle" || incoming.attentionState === "running" || incoming.attentionState === "waiting_interaction") {
    keys.delete(key);
  }
}

/** 冷会话 /viewed 只写 attention，name/preview 可能为空；侧栏已有文案时保留。 */
export function retainSessionListCopy(existing: SessionSummary | undefined, incoming: SessionSummary): SessionSummary {
  if (existing === undefined || incoming.name !== null || incoming.preview !== null) return incoming;
  return { ...incoming, name: existing.name, preview: existing.preview, createdAt: existing.createdAt, updatedAt: existing.updatedAt };
}

export function mergeSession(current: SessionSummary[], next: SessionSummary, viewedIdleKeys: ReadonlySet<string> = EMPTY_VIEWED_IDLE_KEYS): SessionSummary[] {
  const keepViewedIdle = viewedIdleKeys.has(sessionKey(next.workspaceId, next.id)) && shouldKeepViewedIdle(next);
  const incoming = keepViewedIdle ? { ...next, attentionState: "idle" as const } : next;
  const existing = current.findIndex((session) => session.id === incoming.id);
  if (existing === -1) {
    if (keepViewedIdle) delete incoming.attentionAt;
    return sortSessionSummaries([incoming, ...current]);
  }
  const copy = [...current];
  const merged = { ...copy[existing], ...incoming };
  if (incoming.starred !== true) delete merged.starred;
  if (keepViewedIdle || incoming.attentionState === "idle") delete merged.attentionAt;
  copy[existing] = merged;
  return sortSessionSummaries(copy);
}

/**
 * HTTP 会话列表是权威快照；当前列表里尚未出现在快照中的非空项（刚创建、事件已到列表未到）保留。
 * 空草稿不落盘，快照没有则丢掉，避免幽灵新会话。已标记删除的 id 两侧都丢掉。
 */
export function mergeSessionSnapshots(
  current: Record<string, SessionSummary[]>,
  snapshots: Record<string, SessionSummary[]>,
  workspaceIds: string[],
  deleted: Record<string, Set<string> | undefined>,
  viewedIdleKeys: ReadonlySet<string> = EMPTY_VIEWED_IDLE_KEYS,
): Record<string, SessionSummary[]> {
  const next: Record<string, SessionSummary[]> = {};
  for (const workspaceId of workspaceIds) {
    const deletedIds = deleted[workspaceId];
    const byId = new Map<string, SessionSummary>();
    for (const session of snapshots[workspaceId] ?? []) {
      if (deletedIds?.has(session.id) === true) continue;
      byId.set(session.id, applyViewedIdleGuard(session, viewedIdleKeys));
    }
    for (const session of current[workspaceId] ?? []) {
      if (byId.has(session.id) || deletedIds?.has(session.id) === true) continue;
      if (isEmptySession(session)) continue;
      byId.set(session.id, session);
    }
    next[workspaceId] = sortSessionSummaries([...byId.values()]);
  }
  return next;
}

function applyViewedIdleGuard(session: SessionSummary, viewedIdleKeys: ReadonlySet<string>): SessionSummary {
  if (!viewedIdleKeys.has(sessionKey(session.workspaceId, session.id)) || !shouldKeepViewedIdle(session)) return session;
  const next = { ...session, attentionState: "idle" as const };
  delete next.attentionAt;
  return next;
}
