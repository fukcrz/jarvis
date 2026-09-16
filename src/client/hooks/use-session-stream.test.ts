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
  it("clears the previous transcript as soon as another session is selected", () => {
    const previous = hydrated("ws:a", "Hello");
    const selected = reduceSessionStream(previous, { type: "select", sessionKey: "ws:b" });
    expect(selected.sessionKey).toBe("ws:b");
    expect(selected.transcript.items).toEqual([]);
    expect(selected.connection).toBe("connecting");

    const stale = reduceSessionStream(selected, { type: "hydrate", sessionKey: "ws:a", page: page("stale"), snapshot: snapshot() });
    expect(stale).toBe(selected);

    const next = reduceSessionStream(selected, { type: "hydrate", sessionKey: "ws:b", page: page("Next"), snapshot: snapshot(), connection: "live" });
    expect(next.sessionKey).toBe("ws:b");
    expect(next.connection).toBe("live");
    expect(next.transcript.items).toEqual(page("Next").items);
  });

  it("keeps the empty transcript when hydrate fails", () => {
    const previous = hydrated("ws:a", "Hello");
    const selected = reduceSessionStream(previous, { type: "select", sessionKey: "ws:b" });
    const failed = reduceSessionStream(selected, { type: "hydrate-error", sessionKey: "ws:b", error: "无法加载此会话" });
    expect(failed.sessionKey).toBe("ws:b");
    expect(failed.transcript.items).toEqual([]);
    expect(failed.error).toBe("无法加载此会话");
  });
});
