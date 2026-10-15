import type { SessionAttentionState, SessionSummary } from "./protocol.js";

export function isSessionRunning(session: SessionSummary): boolean {
  return session.runState === "running" || session.runState === "stopping";
}

/** 还没有第一条用户消息的草稿槽；不落盘，也不提供分支 / 收藏 / 改名。 */
export function isEmptySession(session: SessionSummary): boolean {
  return session.preview === null;
}

export function sessionAttentionState(session: SessionSummary): SessionAttentionState {
  if (isSessionRunning(session)) return session.runState === "stopping" ? "running" : (session.attentionState === "waiting_interaction" ? "waiting_interaction" : "running");
  return session.attentionState ?? "idle";
}

/** Higher-priority attention states are kept visible before ordinary sessions. */
export function sessionAttentionRank(session: SessionSummary): number {
  const state = sessionAttentionState(session);
  if (state === "waiting_interaction") return 0;
  if (state === "failed") return 1;
  if (state === "completed_unread") return 2;
  if (state === "running") return 3;
  return 4;
}

function sessionAttentionAt(session: SessionSummary): string {
  return session.attentionAt ?? "";
}

/** Later of the user send and the LLM reply end. Missing values fall back to createdAt. */
export function sessionRecencyAt(session: SessionSummary): string {
  const userAt = session.lastUserMessageAt ?? "";
  const replyAt = session.lastReplyEndedAt ?? "";
  const later = userAt.localeCompare(replyAt) >= 0 ? userAt : replyAt;
  return later === "" ? session.createdAt : later;
}

function sessionEmptyRank(session: SessionSummary): number {
  return isEmptySession(session) ? 0 : 1;
}

function sessionCreatedAt(session: SessionSummary): string {
  return session.createdAt;
}

/** Attention rank, then empty drafts, then when that state was entered, then created / later of user send and reply end. */
export function compareSessionSummaries(a: SessionSummary, b: SessionSummary): number {
  const attention = sessionAttentionRank(a) - sessionAttentionRank(b);
  if (attention !== 0) return attention;
  const empty = sessionEmptyRank(a) - sessionEmptyRank(b);
  if (empty !== 0) return empty;
  return sessionAttentionAt(b).localeCompare(sessionAttentionAt(a))
    || (isEmptySession(a) ? sessionCreatedAt(b).localeCompare(sessionCreatedAt(a)) : sessionRecencyAt(b).localeCompare(sessionRecencyAt(a)));
}

export function sortSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => compareSessionSummaries(a.session, b.session) || a.index - b.index)
    .map((item) => item.session);
}
