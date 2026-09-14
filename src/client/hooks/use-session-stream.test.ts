import { describe, expect, it } from "vitest";
import type { SessionStreamSnapshot, TimelinePage } from "../../shared/protocol";
import { emptyTranscript } from "../transcript";
import { reduceSessionStream, type StreamState } from "./use-session-stream";

function page(text: string): TimelinePage {
  return {
    items: [{ kind: "message", id: "m1", role: "user", createdAt: "2026-08-09T00:00:00.000Z", text }],
    start: 0,
    total: 1,
    hasMore: false,
  };
}

function snapshot(): SessionStreamSnapshot {
  return {
    seq: 1,
    status: { sessionId: "session", runState: "idle" },
    model: { available: [] },
    thinking: { current: "off", available: ["off"] },
    liveMessages: [],
    activeTools: [],
  };
}

function hydrated(sessionKey: string, text: string): StreamState {
  const selected = reduceSessionStream({ transcript: emptyTranscript, connection: "offline" }, { type: "select", sessionKey });
  return reduceSessionStream(selected, {
    type: "hydrate",
    sessionKey,
    page: page(text),
    snapshot: snapshot(),
    connection: "live",
  });
}

describe("session stream reducer", () => {
  it("keeps the previous transcript until the next session hydrates", () => {
    const previous = hydrated("ws:a", "Hello");
    const selected = reduceSessionStream(previous, { type: "select", sessionKey: "ws:b" });
    expect(selected.pendingSessionKey).toBe("ws:b");
    expect(selected.transcript.items).toEqual(previous.transcript.items);
    expect(selected.connection).toBe("connecting");

    const ignored = reduceSessionStream(selected, {
      type: "events",
      events: [{ version: 1, sessionId: "session", seq: 2, emittedAt: "2026-08-09T00:00:01.000Z", type: "assistant.delta", payload: { messageId: "a1", delta: "nope" } }],
    });
    expect(ignored).toBe(selected);

    const liveTooSoon = reduceSessionStream(selected, { type: "connection", value: "live" });
    expect(liveTooSoon).toBe(selected);

    const stale = reduceSessionStream(selected, { type: "hydrate", sessionKey: "ws:a", page: page("stale"), snapshot: snapshot() });
    expect(stale).toBe(selected);

    const next = reduceSessionStream(selected, { type: "hydrate", sessionKey: "ws:b", page: page("Next"), snapshot: snapshot(), connection: "live" });
    expect(next.pendingSessionKey).toBeUndefined();
    expect(next.sessionKey).toBe("ws:b");
    expect(next.connection).toBe("live");
    expect(next.transcript.items).toEqual(page("Next").items);
  });

  it("does not keep the previous session after a failed hydrate", () => {
    const previous = hydrated("ws:a", "Hello");
    const selected = reduceSessionStream(previous, { type: "select", sessionKey: "ws:b" });
    const failed = reduceSessionStream(selected, { type: "hydrate-error", sessionKey: "ws:b", error: "无法加载此会话" });
    expect(failed.pendingSessionKey).toBeUndefined();
    expect(failed.sessionKey).toBe("ws:b");
    expect(failed.transcript.items).toEqual([]);
    expect(failed.error).toBe("无法加载此会话");
  });
});
