import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../shared/protocol";
import { applySessionEvents, emptyTranscript, hydrateTranscript } from "./transcript";

describe("transcript reducer", () => {
  it("drops events at or below the snapshot watermark and merges a tool by id", () => {
    const hydrated = hydrateTranscript(emptyTranscript, {
      items: [{ kind: "message", id: "m1", role: "user", createdAt: "2026-08-09T00:00:00.000Z", text: "Hello" }],
      start: 0,
      total: 1,
      hasMore: false,
    }, {
      seq: 4,
      status: { sessionId: "session", runState: "running", activeRun: { id: "run", startedAt: "2026-08-09T00:00:00.000Z" } },
      model: { current: { provider: "provider", id: "model-a", name: "Model A", reasoning: true }, available: [{ provider: "provider", id: "model-a", name: "Model A", reasoning: true }, { provider: "provider", id: "model-b", name: "Model B", reasoning: false }] },
      liveMessages: [],
      activeTools: [],
    });

    const events: SessionEvent[] = [
      { version: 1, sessionId: "session", runId: "run", seq: 4, emittedAt: "2026-08-09T00:00:01.000Z", type: "assistant.delta", payload: { messageId: "a1", delta: "ignored" } },
      { version: 1, sessionId: "session", runId: "run", seq: 5, emittedAt: "2026-08-09T00:00:02.000Z", type: "tool.upsert", payload: { tool: { kind: "tool", id: "t1", createdAt: "2026-08-09T00:00:02.000Z", name: "read", title: "Read file", state: "running" } } },
      { version: 1, sessionId: "session", runId: "run", seq: 6, emittedAt: "2026-08-09T00:00:03.000Z", type: "tool.upsert", payload: { tool: { kind: "tool", id: "t1", createdAt: "2026-08-09T00:00:02.000Z", name: "read", title: "Read file", state: "completed", output: "done" } } },
    ];

    const result = applySessionEvents(hydrated, events);
    expect(result.seq).toBe(6);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({ id: "t1", state: "completed", output: "done" });
  });

  it("adds the server message.created payload without relying on an optimistic echo", () => {
    const result = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "message.created",
      payload: { message: { kind: "message", id: "user", role: "user", createdAt: "2026-08-09T00:00:00.000Z", text: "Hello" } },
    }]);

    expect(result.items).toEqual([expect.objectContaining({ id: "user", role: "user", text: "Hello" })]);
  });

  it("updates the selected model from a server event", () => {
    const result = applySessionEvents({ ...emptyTranscript, model: { available: [{ provider: "provider", id: "first", name: "First", reasoning: false }, { provider: "provider", id: "second", name: "Second", reasoning: true }] } }, [{
      version: 1,
      sessionId: "session",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "model.changed",
      payload: { model: { current: { provider: "provider", id: "second", name: "Second", reasoning: true }, available: [{ provider: "provider", id: "first", name: "First", reasoning: false }, { provider: "provider", id: "second", name: "Second", reasoning: true }] } },
    }]);

    expect(result.model.current).toMatchObject({ id: "second", name: "Second" });
    expect(result.model.available).toHaveLength(2);
  });

  it("creates an assistant partial from a text delta", () => {
    const result = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "assistant.delta",
      payload: { messageId: "partial", delta: "Streaming" },
    }]);

    expect(result.items).toEqual([expect.objectContaining({ id: "partial", role: "assistant", text: "Streaming" })]);
    expect(result.streamingMessageId).toBe("partial");
  });

  it("marks only the active assistant message as streaming and clears it after completion", () => {
    const streaming = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "assistant.delta",
      payload: { messageId: "partial", delta: "# Incomplete" },
    }]);
    const completed = applySessionEvents(streaming, [{
      version: 1,
      sessionId: "session",
      runId: "run",
      seq: 2,
      emittedAt: "2026-08-09T00:00:01.000Z",
      type: "assistant.completed",
      payload: { message: { kind: "message", id: "partial", role: "assistant", createdAt: "2026-08-09T00:00:00.000Z", text: "# Complete" } },
    }]);

    expect(streaming.streamingMessageId).toBe("partial");
    expect(completed.streamingMessageId).toBeUndefined();
    expect(completed.items).toEqual([expect.objectContaining({ id: "partial", text: "# Complete" })]);
  });
});
