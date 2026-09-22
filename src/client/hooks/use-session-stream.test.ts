import { describe, expect, it } from "vitest";
import type { SessionStreamSnapshot, TimelinePage } from "../../shared/protocol";
import { emptyTranscript } from "../transcript";
import { applyOutlineEvents, reduceSessionStream, shouldApplySessionRefresh, type StreamState } from "./use-session-stream";

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

  it("restores a cached transcript while another session hydrates", () => {
    const previous = hydrated("ws:a", "Hello");
    const cached = hydrated("ws:b", "Cached").transcript;
    const selected = reduceSessionStream(previous, { type: "select", sessionKey: "ws:b", transcript: cached });
    expect(selected.sessionKey).toBe("ws:b");
    expect(selected.connection).toBe("connecting");
    expect(selected.transcript.items).toEqual(page("Cached").items);

    const stale = reduceSessionStream(selected, { type: "hydrate", sessionKey: "ws:a", page: page("stale"), snapshot: snapshot() });
    expect(stale).toBe(selected);
    const failed = reduceSessionStream(selected, { type: "hydrate-error", sessionKey: "ws:b", error: "无法加载此会话" });
    expect(failed.transcript.items).toEqual(page("Cached").items);
    expect(failed.error).toBe("无法加载此会话");
  });

  it("ignores an earlier-history response from a no-longer-selected session", () => {
    const selected = hydrated("ws:b", "Current");
    const stale = reduceSessionStream(selected, { type: "prepend", sessionKey: "ws:a", page: page("Stale") });
    expect(stale).toBe(selected);
  });

  it("accepts only the latest refresh for the same session and history generation", () => {
    const current = { currentKey: "ws:a", currentHistoryGeneration: 4, currentRequestGeneration: 2 };
    const base = { selectedKey: "ws:a", selectedHistoryGeneration: 4, requestGeneration: 2, ...current };
    expect(shouldApplySessionRefresh(base)).toBe(true);
    expect(shouldApplySessionRefresh({ ...base, requestGeneration: 1 })).toBe(false);
    expect(shouldApplySessionRefresh({ ...base, selectedHistoryGeneration: 3 })).toBe(false);
    expect(shouldApplySessionRefresh({ ...base, currentKey: "ws:b" })).toBe(false);
  });
});

describe("applyOutlineEvents", () => {
  it("rebuilds the outline after a session rewrite", () => {
    const transcript = hydrated("ws:a", "Hello").transcript;
    const rewritten = {
      ...transcript,
      items: [
        { kind: "message" as const, id: "u1", role: "user" as const, createdAt: "2026-08-09T00:00:00.000Z", text: "One" },
        { kind: "message" as const, id: "a1", role: "assistant" as const, createdAt: "2026-08-09T00:00:01.000Z", text: "Two" },
      ],
      start: 0,
      total: 2,
      hasMore: false,
    };
    expect(applyOutlineEvents([{ id: "old", preview: "stale", itemIndex: 0 }], [{ version: 1, sessionId: "session", type: "session.rewritten", seq: 2, emittedAt: "2026-08-09T00:00:02.000Z", payload: {} }], rewritten)).toEqual([
      { id: "u1", preview: "One", itemIndex: 0 },
    ]);
  });

  it("appends a newly created user message", () => {
    const transcript = {
      ...emptyTranscript,
      start: 4,
      total: 6,
      items: [
        { kind: "message" as const, id: "u2", role: "user" as const, createdAt: "2026-08-09T00:00:00.000Z", text: "Next" },
      ],
    };
    expect(applyOutlineEvents(
      [{ id: "u1", preview: "First", itemIndex: 0 }],
      [{ version: 1, sessionId: "session", type: "message.created", seq: 3, emittedAt: "2026-08-09T00:00:01.000Z", payload: { message: { id: "u2", role: "user" } } }],
      transcript,
    )).toEqual([
      { id: "u1", preview: "First", itemIndex: 0 },
      { id: "u2", preview: "Next", itemIndex: 4 },
    ]);
  });
});
