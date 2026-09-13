import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionSummary } from "../../shared/protocol";
import {
  coalesceStreamEvents,
  mergeSessionSnapshots,
  parseSocketHeartbeat,
  shouldFlushStreamEventImmediately,
  shouldReconnectVisibleSocket,
  socketHeartbeatMessage,
  SOCKET_PING_TYPE,
  SOCKET_PONG_TYPE,
  SOCKET_RECONNECT_COOLDOWN_MS,
  SOCKET_STALE_MS,
} from "./socket-sync";

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: "ws",
    name: id,
    preview: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    runState: "idle",
    attentionState: "idle",
    ...extra,
  };
}

function delta(seq: number, messageId: string, text: string): SessionEvent {
  return {
    version: 1,
    sessionId: "session",
    seq,
    emittedAt: "2026-01-01T00:00:00.000Z",
    type: "assistant.delta",
    payload: { messageId, delta: text },
  };
}

describe("socket heartbeat", () => {
  it("round-trips ping and pong frames", () => {
    expect(parseSocketHeartbeat(JSON.parse(socketHeartbeatMessage(SOCKET_PING_TYPE)))).toEqual({ version: 1, type: SOCKET_PING_TYPE });
    expect(parseSocketHeartbeat(JSON.parse(socketHeartbeatMessage(SOCKET_PONG_TYPE)))).toEqual({ version: 1, type: SOCKET_PONG_TYPE });
  });

  it("rejects session events and malformed frames", () => {
    expect(parseSocketHeartbeat({ version: 1, type: "assistant.delta", seq: 1 })).toBeUndefined();
    expect(parseSocketHeartbeat({ type: SOCKET_PING_TYPE })).toBeUndefined();
    expect(parseSocketHeartbeat(null)).toBeUndefined();
  });
});

describe("shouldReconnectVisibleSocket", () => {
  const base = {
    visible: true,
    online: true,
    readyState: 1,
    lastEventAt: 0,
    now: SOCKET_STALE_MS,
    lastReconnectAt: -SOCKET_RECONNECT_COOLDOWN_MS,
  };

  it("reconnects a stale open socket while the tab is visible and online", () => {
    expect(shouldReconnectVisibleSocket(base)).toBe(true);
  });

  it("does not reconnect while hidden, offline, connecting, or in cooldown", () => {
    expect(shouldReconnectVisibleSocket({ ...base, visible: false })).toBe(false);
    expect(shouldReconnectVisibleSocket({ ...base, online: false })).toBe(false);
    expect(shouldReconnectVisibleSocket({ ...base, readyState: 0 })).toBe(false);
    expect(shouldReconnectVisibleSocket({ ...base, lastReconnectAt: SOCKET_STALE_MS - 200 })).toBe(false);
  });

  it("reconnects a closed socket immediately when visible", () => {
    expect(shouldReconnectVisibleSocket({ ...base, readyState: 3, now: 0, lastEventAt: 0 })).toBe(true);
  });

  it("keeps a recently active open socket", () => {
    expect(shouldReconnectVisibleSocket({ ...base, lastEventAt: SOCKET_STALE_MS - 1, now: SOCKET_STALE_MS })).toBe(false);
  });
});

describe("shouldFlushStreamEventImmediately", () => {
  it("flushes every event while hidden and settled events while visible", () => {
    expect(shouldFlushStreamEventImmediately(true, "assistant.delta")).toBe(true);
    expect(shouldFlushStreamEventImmediately(false, "assistant.delta")).toBe(false);
    expect(shouldFlushStreamEventImmediately(false, "run.settled")).toBe(true);
    expect(shouldFlushStreamEventImmediately(false, "run.failed")).toBe(true);
  });
});

describe("coalesceStreamEvents", () => {
  it("merges consecutive deltas for the same message and keeps other events", () => {
    const events: SessionEvent[] = [
      delta(1, "a", "Hel"),
      delta(2, "a", "lo"),
      { version: 1, sessionId: "session", seq: 3, emittedAt: "2026-01-01T00:00:00.000Z", type: "tool.upsert", payload: {} },
      delta(4, "b", "Other"),
    ];
    const coalesced = coalesceStreamEvents(events);
    expect(coalesced).toHaveLength(3);
    expect(coalesced[0]).toMatchObject({ seq: 2, payload: { messageId: "a", delta: "Hello" } });
    expect(coalesced[1]?.type).toBe("tool.upsert");
    expect(coalesced[2]).toMatchObject({ payload: { messageId: "b", delta: "Other" } });
  });
});

describe("mergeSessionSnapshots", () => {
  it("lets the HTTP snapshot overwrite live fields and keeps unsynced local sessions", () => {
    const local = session("a", { runState: "running", attentionState: "running", starred: true });
    const snapshot = session("a", { runState: "idle", attentionState: "completed_unread" });
    const created = session("b", { runState: "running", attentionState: "running" });
    const merged = mergeSessionSnapshots(
      { ws: [local, created] },
      { ws: [snapshot] },
      ["ws"],
      {},
    );
    expect(merged.ws?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(merged.ws?.[0]).toMatchObject({ id: "a", runState: "idle", attentionState: "completed_unread" });
    expect(merged.ws?.[0]?.starred).toBeUndefined();
    expect(merged.ws?.[1]).toMatchObject({ id: "b", runState: "running" });
  });

  it("drops sessions marked deleted on either side", () => {
    const merged = mergeSessionSnapshots(
      { ws: [session("gone"), session("keep")] },
      { ws: [session("gone"), session("keep"), session("also-gone")] },
      ["ws"],
      { ws: new Set(["gone", "also-gone"]) },
    );
    expect(merged.ws?.map((item) => item.id)).toEqual(["keep"]);
  });
});
