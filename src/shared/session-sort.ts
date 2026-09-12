import type { SessionAttentionState, SessionSummary } from "./protocol.js";

export function isSessionRunning(session: SessionSummary): boolean {
  return session.runState === "running" || session.runState === "stopping";
}

export function sessionAttentionState(session: SessionSummary): SessionAttentionState {
  if (isSessionRunning(session)) return session.runState === "stopping" ? "running" : (session.attentionState === "waiting_interaction" ? "waiting_interaction" : "running");
  return session.attentionState ?? "idle";
}

/** Higher-priority attention states are kept visible before ordinary sessions. */
export function sessionAttentionRank(session: SessionSummary): number {
  const state = sessionAttentionState(session);
  if (state === "waiting_interaction") return 0;
  if (state === "running") return 1;
  if (state === "failed") return 2;
  if (state === "completed_unread") return 3;
  return 4;
}

function sessionAttentionAt(session: SessionSummary): string {
  return session.attentionAt ?? "";
}

function sessionLastUserMessageAt(session: SessionSummary): string {
  return session.lastUserMessageAt ?? session.createdAt;
}

/** Attention rank, then when that state was entered, then last user send. */
export function compareSessionSummaries(a: SessionSummary, b: SessionSummary): number {
  return sessionAttentionRank(a) - sessionAttentionRank(b)
    || sessionAttentionAt(b).localeCompare(sessionAttentionAt(a))
    || sessionLastUserMessageAt(b).localeCompare(sessionLastUserMessageAt(a));
}

export function sortSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => compareSessionSummaries(a.session, b.session) || a.index - b.index)
    .map((item) => item.session);
}
