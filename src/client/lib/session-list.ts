import type { SessionSummary, Workspace } from "../../shared/protocol";
import { sessionCleanupTargets, sessionKey, sortSessionSummaries } from "./utils";

export function sessionCleanupConfirmMessage(sessions: SessionSummary[], keepSessionId?: string): string {
  const count = sessionCleanupTargets(sessions, keepSessionId).length;
  return `永久删除 ${String(count)} 个闲置会话，不可恢复。`;
}

export function markSessionUserActivity(sessions: SessionSummary[], sessionId: string, viewedIdleKeys?: Set<string>): SessionSummary[] {
  const at = new Date().toISOString();
  return sortSessionSummaries(sessions.map((session) => {
    if (session.id !== sessionId) return session;
    viewedIdleKeys?.delete(sessionKey(session.workspaceId, session.id));
    return { ...session, runState: "running" as const, attentionState: "running" as const, attentionAt: at, lastUserMessageAt: at, updatedAt: at };
  }));
}

export function mergeWorkspace(current: Workspace[], next: Workspace): Workspace[] {
  const existing = current.findIndex((workspace) => workspace.id === next.id);
  if (existing === -1) return [...current, next].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  const copy = [...current];
  copy[existing] = next;
  return copy.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}
