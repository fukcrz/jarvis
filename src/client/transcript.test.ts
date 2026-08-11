import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../shared/protocol";
import { addOptimisticUserMessage, applySessionEvents, emptyTranscript, hydrateTranscript } from "./transcript";

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

  it("replaces the transcript and resets pagination when history is rewritten", () => {
    const previous = {
      ...emptyTranscript,
      items: [
        { kind: "message" as const, id: "old-user", role: "user" as const, createdAt: "2026-08-09T00:00:00.000Z", text: "Old" },
        { kind: "message" as const, id: "old-answer", role: "assistant" as const, createdAt: "2026-08-09T00:00:01.000Z", text: "Old answer" },
      ],
      start: 20,
      total: 24,
      hasMore: true,
      seq: 4,
    };
    const result = applySessionEvents(previous, [{
      version: 1,
      sessionId: "session",
      seq: 5,
      emittedAt: "2026-08-09T00:00:02.000Z",
      type: "session.rewritten",
      payload: {
        items: [{ kind: "message", id: "kept", role: "user", createdAt: "2026-08-09T00:00:00.000Z", text: "Kept" }],
        status: { sessionId: "session", runState: "idle" },
      },
    }]);
    expect(result).toMatchObject({ start: 0, total: 1, hasMore: false, streamingMessageId: undefined, status: { runState: "idle" } });
    expect(result.items).toEqual([expect.objectContaining({ id: "kept" })]);
  });

  it("shows optimistic image messages and replaces them with the server image message", () => {
    const image = { mimeType: "image/png", data: "abc" };
    const optimistic = addOptimisticUserMessage(emptyTranscript, "request-1", "See this", [image]);
    expect(optimistic.items).toEqual([expect.objectContaining({ id: "optimistic:user:request-1", images: [image] })]);
    const result = applySessionEvents(optimistic, [{
      version: 1,
      sessionId: "session",
      seq: 1,
      emittedAt: "2026-08-09T00:00:00.000Z",
      type: "message.created",
      payload: { message: { kind: "message", id: "user", role: "user", createdAt: "2026-08-09T00:00:00.000Z", text: "See this", images: [image] } },
    }]);
    expect(result.items).toEqual([expect.objectContaining({ id: "user", images: [image] })]);
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

  it("hydrates pending extension dialogs from the runtime snapshot", () => {
    const hydrated = hydrateTranscript(emptyTranscript, { items: [], start: 0, total: 0, hasMore: false }, {
      seq: 9,
      status: { sessionId: "session", runState: "running" },
      model: { available: [] },
      thinking: { current: "off", available: ["off"] },
      liveMessages: [],
      activeTools: [],
      extensionUi: {
        dialogs: [{ createdAt: "2026-08-09T00:00:00.000Z", request: { id: "a", method: "confirm", title: "Allow?", message: "Continue?", timeout: 5_000 } }],
        statuses: {}, widgets: {},
      },
    });
    expect(hydrated.items).toEqual([expect.objectContaining({ kind: "extension-ui", id: "ext:a", request: expect.objectContaining({ method: "confirm", timeout: 5_000 }) })]);
  });

  it("rehydrates extension cards at their original chronological position", () => {
    const hydrated = hydrateTranscript(emptyTranscript, {
      items: [
        { kind: "tool", id: "tool", createdAt: "2026-08-09T00:00:00.000Z", name: "question", title: "Question", state: "completed" },
        { kind: "message", id: "later", role: "assistant", createdAt: "2026-08-09T00:00:02.000Z", text: "Later message" },
      ],
      start: 0,
      total: 2,
      hasMore: false,
    }, {
      seq: 10,
      status: { sessionId: "session", runState: "idle" },
      model: { available: [] },
      thinking: { current: "off", available: ["off"] },
      liveMessages: [],
      activeTools: [],
      extensionUi: {
        dialogs: [],
        cards: [{
          kind: "extension-ui",
          id: "ext:answered",
          createdAt: "2026-08-09T00:00:01.000Z",
          request: { id: "answered", method: "input", title: "Name?", placeholder: "Type here" },
          outcome: "answered",
          value: "Ada",
        }],
        statuses: {}, widgets: {},
      },
    });
    expect(hydrated.items.map((item) => item.id)).toEqual(["tool", "ext:answered", "later"]);
    expect(hydrated.items[1]).toMatchObject({ outcome: "answered", value: "Ada" });
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

describe("extension UI events", () => {
  const requestEvent: SessionEvent = {
    version: 1, sessionId: "session", seq: 10, emittedAt: "2026-08-09T00:00:10.000Z",
    type: "extension.uiRequest",
    payload: { request: { id: "11111111-1111-4111-8111-111111111111", method: "select", title: "选择分支", options: ["main", "dev"] } },
  };

  it("adds a pending extension card from uiRequest", () => {
    const next = applySessionEvents(emptyTranscript, [requestEvent]);
    expect(next.items).toEqual([expect.objectContaining({
      kind: "extension-ui",
      id: "ext:11111111-1111-4111-8111-111111111111",
      request: expect.objectContaining({ method: "select", title: "选择分支", options: ["main", "dev"] }),
    })]);
  });

  it("keeps notify requests out of transcript history", () => {
    const next = applySessionEvents(emptyTranscript, [{
      version: 1, sessionId: "session", seq: 11, emittedAt: "2026-08-09T00:00:11.000Z",
      type: "extension.uiRequest",
      payload: { request: { id: "22222222-2222-4222-8222-222222222222", method: "notify", message: "已暂存 3 个文件", notifyType: "info" } },
    }]);
    expect(next.items).toEqual([]);
  });

  it("updates the card with the answered value on uiSettled", () => {
    const pending = applySessionEvents(emptyTranscript, [requestEvent]);
    const next = applySessionEvents(pending, [{
      version: 1, sessionId: "session", seq: 12, emittedAt: "2026-08-09T00:00:12.000Z",
      type: "extension.uiSettled",
      payload: { id: "11111111-1111-4111-8111-111111111111", outcome: "answered", value: "dev" },
    }]);
    expect(next.items).toEqual([expect.objectContaining({ kind: "extension-ui", outcome: "answered", value: "dev" })]);
  });

  it("ignores uiSettled for unknown cards", () => {
    const next = applySessionEvents(emptyTranscript, [{
      version: 1, sessionId: "session", seq: 12, emittedAt: "2026-08-09T00:00:12.000Z",
      type: "extension.uiSettled",
      payload: { id: "33333333-3333-4333-8333-333333333333", outcome: "timeout" },
    }]);
    expect(next.items).toEqual([]);
  });

  it("retains realtime editor timeout", () => {
    const next = applySessionEvents(emptyTranscript, [{
      version: 1, sessionId: "session", seq: 13, emittedAt: "2026-08-09T00:00:13.000Z",
      type: "extension.uiRequest",
      payload: { request: { id: "editor-timeout", method: "editor", title: "编辑内容", prefill: "draft", timeout: 5_000 } },
    }]);
    expect(next.items).toEqual([expect.objectContaining({ request: expect.objectContaining({ method: "editor", prefill: "draft", timeout: 5_000 }) })]);
  });

  it("retains realtime confirm timeout and marks its confirmed outcome", () => {
    const pending = applySessionEvents(emptyTranscript, [{
      version: 1, sessionId: "session", seq: 13, emittedAt: "2026-08-09T00:00:13.000Z",
      type: "extension.uiRequest",
      payload: { request: { id: "44444444-4444-4444-8444-444444444444", method: "confirm", title: "允许？", message: "执行 rm -rf dist", timeout: 5_000 } },
    }]);
    expect(pending.items).toEqual([expect.objectContaining({ request: expect.objectContaining({ timeout: 5_000 }) })]);
    const next = applySessionEvents(pending, [{
      version: 1, sessionId: "session", seq: 14, emittedAt: "2026-08-09T00:00:14.000Z",
      type: "extension.uiSettled",
      payload: { id: "44444444-4444-4444-8444-444444444444", outcome: "answered", confirmed: true },
    }]);
    expect(next.items).toEqual([expect.objectContaining({ kind: "extension-ui", outcome: "answered", confirmed: true })]);
  });

  it("rejects malformed requests", () => {
    const next = applySessionEvents(emptyTranscript, [{
      version: 1, sessionId: "session", seq: 15, emittedAt: "2026-08-09T00:00:15.000Z",
      type: "extension.uiRequest",
      payload: { request: { id: "55555555-5555-4555-8555-555555555555", method: "select", title: "x" } },
    }]);
    expect(next.items).toEqual([]);
  });
});
