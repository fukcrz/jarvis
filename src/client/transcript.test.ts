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
      model: { current: { provider: "provider", id: "model-a", name: "Model A", reasoning: true, vision: false }, available: [{ provider: "provider", id: "model-a", name: "Model A", reasoning: true, vision: false }, { provider: "provider", id: "model-b", name: "Model B", reasoning: false, vision: false }] },
      thinking: { current: "medium", available: ["off", "low", "medium", "high"] },
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

  it("keeps an absolute retry deadline and compaction status from a server event", () => {
    const retryAt = "2026-08-09T00:00:30.000Z";
    const result = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "run.compactionRetrying",
      payload: {
        status: {
          sessionId: "session",
          runState: "running",
          activeRun: { id: "run", startedAt: "2026-08-09T00:00:00.000Z" },
          compacting: {
            reason: "overflow",
            startedAt: "2026-08-09T00:00:02.000Z",
            retrying: { attempt: 2, maxAttempts: 4, delayMs: 28_000, retryAt, errorMessage: "rate limited" },
          },
        },
      },
    }]);

    expect(result.status.compacting).toEqual({
      reason: "overflow",
      startedAt: "2026-08-09T00:00:02.000Z",
      retrying: { attempt: 2, maxAttempts: 4, delayMs: 28_000, retryAt, errorMessage: "rate limited" },
    });
  });

  it("adds a live context summary only once by its persisted entry id", () => {
    const item = { kind: "context-summary" as const, id: "context-summary:compact", createdAt: "2026-08-09T00:00:00.000Z", summaryType: "compaction" as const, summary: "Summary", tokensBefore: 90_000 };
    const result = applySessionEvents(emptyTranscript, [
      { version: 1, sessionId: "session", seq: 1, emittedAt: "2026-08-09T00:00:00.000Z", type: "timeline.upsert", payload: { item } },
      { version: 1, sessionId: "session", seq: 2, emittedAt: "2026-08-09T00:00:01.000Z", type: "timeline.upsert", payload: { item: { ...item, summary: "Updated summary" } } },
    ]);

    expect(result.items).toEqual([expect.objectContaining({ id: "context-summary:compact", summary: "Updated summary" })]);
  });

  it("updates the selected model from a server event", () => {
    const result = applySessionEvents({ ...emptyTranscript, model: { available: [{ provider: "provider", id: "first", name: "First", reasoning: false, vision: false }, { provider: "provider", id: "second", name: "Second", reasoning: true, vision: false }] } }, [{
      version: 1,
      sessionId: "session",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "model.changed",
      payload: { model: { current: { provider: "provider", id: "second", name: "Second", reasoning: true, vision: false }, available: [{ provider: "provider", id: "first", name: "First", reasoning: false, vision: false }, { provider: "provider", id: "second", name: "Second", reasoning: true, vision: false }] } },
    }]);

    expect(result.model.current).toMatchObject({ id: "second", name: "Second" });
    expect(result.model.available).toHaveLength(2);
  });

  it("updates the thinking snapshot from a server event", () => {
    const result = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "thinking.changed",
      payload: { thinking: { current: "high", available: ["off", "low", "high"] } },
    }]);

    expect(result.thinking).toEqual({ current: "high", available: ["off", "low", "high"] });
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

  it("creates a running bash item from run.started and streams deltas into it", () => {
    const started = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "bash-run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "run.started",
      payload: {
        status: { sessionId: "session", runState: "running", activeRun: { id: "bash-run", startedAt: "2026-08-09T00:00:00.000Z", kind: "bash" } },
        bash: { kind: "tool", id: "bash:bash-run", createdAt: "2026-08-09T00:00:00.000Z", name: "bash", title: "Run command", state: "running", target: "npm test", inputPreview: "npm test", excludeFromContext: true, output: "" },
      },
    }]);
    expect(started.status.activeRun).toMatchObject({ id: "bash-run", kind: "bash" });
    expect(started.items).toEqual([expect.objectContaining({ id: "bash:bash-run", name: "bash", state: "running", excludeFromContext: true })]);

    const streamed = applySessionEvents(started, [
      { version: 1, sessionId: "session", runId: "bash-run", seq: 2, emittedAt: "2026-08-09T00:00:01.000Z", type: "bash.delta", payload: { delta: "one\n" } },
      { version: 1, sessionId: "session", runId: "bash-run", seq: 3, emittedAt: "2026-08-09T00:00:02.000Z", type: "bash.delta", payload: { delta: "two" } },
    ]);
    expect(streamed.items).toEqual([expect.objectContaining({ id: "bash:bash-run", output: "one\ntwo" })]);
  });

  it("replaces the live bash item with the persisted entry on bash.settled", () => {
    const live = applySessionEvents(emptyTranscript, [{
      version: 1,
      sessionId: "session",
      runId: "bash-run",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "run.started",
      payload: {
        status: { sessionId: "session", runState: "running", activeRun: { id: "bash-run", startedAt: "2026-08-09T00:00:00.000Z", kind: "bash" } },
        bash: { kind: "tool", id: "bash:bash-run", createdAt: "2026-08-09T00:00:00.000Z", name: "bash", title: "Run command", state: "running", target: "npm test", inputPreview: "npm test", output: "partial" },
      },
    }]);
    const settled = applySessionEvents(live, [{
      version: 1,
      sessionId: "session",
      runId: "bash-run",
      seq: 2,
      emittedAt: "2026-08-09T00:00:02.000Z",
      type: "bash.settled",
      payload: {
        item: { kind: "tool", id: "bash:entry-1", createdAt: "2026-08-09T00:00:02.000Z", name: "bash", title: "Run command", state: "completed", target: "npm test", inputPreview: "npm test", exitCode: 0, output: "all good" },
        cancelled: false,
        exitCode: 0,
      },
    }]);
    expect(settled.items).toEqual([expect.objectContaining({ id: "bash:entry-1", state: "completed", exitCode: 0, output: "all good" })]);
    expect(settled.items.some((item) => item.kind === "tool" && item.id === "bash:bash-run")).toBe(false);
  });

  it("hydrates a live bash item from the runtime snapshot after a reconnect", () => {
    const hydrated = hydrateTranscript(emptyTranscript, {
      items: [],
      start: 0,
      total: 0,
      hasMore: false,
    }, {
      seq: 9,
      status: { sessionId: "session", runState: "running", activeRun: { id: "bash-run", startedAt: "2026-08-09T00:00:00.000Z", kind: "bash" } },
      model: { available: [] },
      thinking: { current: "off", available: ["off"] },
      liveMessages: [],
      activeTools: [],
      activeBash: { kind: "tool", id: "bash:bash-run", createdAt: "2026-08-09T00:00:00.000Z", name: "bash", title: "Run command", state: "running", target: "npm test", inputPreview: "npm test", output: "so far" },
    });
    expect(hydrated.items).toEqual([expect.objectContaining({ id: "bash:bash-run", output: "so far" })]);
  });
});
