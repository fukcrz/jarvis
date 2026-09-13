import { isRecord, type SessionEvent, type SessionSummary } from "../../shared/protocol";
import { sortSessionSummaries } from "../../shared/session-sort";

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

/**
 * HTTP 会话列表是权威快照；当前列表里尚未出现在快照中的项（刚创建、事件已到列表未到）保留。
 * 已标记删除的 id 两侧都丢掉。
 */
export function mergeSessionSnapshots(
  current: Record<string, SessionSummary[]>,
  snapshots: Record<string, SessionSummary[]>,
  workspaceIds: string[],
  deleted: Record<string, Set<string> | undefined>,
): Record<string, SessionSummary[]> {
  const next: Record<string, SessionSummary[]> = {};
  for (const workspaceId of workspaceIds) {
    const deletedIds = deleted[workspaceId];
    const byId = new Map<string, SessionSummary>();
    for (const session of snapshots[workspaceId] ?? []) {
      if (deletedIds?.has(session.id) === true) continue;
      byId.set(session.id, session);
    }
    for (const session of current[workspaceId] ?? []) {
      if (byId.has(session.id) || deletedIds?.has(session.id) === true) continue;
      byId.set(session.id, session);
    }
    next[workspaceId] = sortSessionSummaries([...byId.values()]);
  }
  return next;
}
