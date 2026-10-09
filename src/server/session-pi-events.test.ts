import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../shared/protocol.js";
import { applySessionEvents, emptyTranscript, hydrateTranscript } from "../client/transcript.js";
import type { ActiveSession } from "./session-active.js";
import { EventHub } from "./event-hub.js";
import { projectHistory } from "./projection.js";
import { SessionPiEvents, type SessionPiHost } from "./session-pi-events.js";

const timestamp = Date.parse("2026-08-09T00:00:01.000Z");
const signature = (phase: "commentary" | "final_answer") => JSON.stringify({ v: 1, id: phase, phase });

function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant", content, timestamp, api: "openai-responses", provider: "openai", model: "fixture",
    stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function setup() {
  const hub = new EventHub();
  const events: SessionEvent[] = [];
  const publish = hub.publishSession.bind(hub);
  vi.spyOn(hub, "publishSession").mockImplementation((ref, event) => {
    const envelope = publish(ref, event);
    events.push(envelope);
    return envelope;
  });
  const appendCustomEntry = vi.fn();
  const active = {
    ref: { workspaceId: "workspace", sessionId: "session" }, cwd: "D:/fixture",
    state: { sessionId: "session", runState: "running", activeRun: { id: "run", startedAt: new Date(timestamp - 1000).toISOString() } },
    session: { sessionManager: { appendCustomEntry } } as unknown as ActiveSession["session"],
    liveMessages: new Map(), liveThinking: new Map(), liveErrors: new Map(), partialAssistantItems: new Map(),
    streamingMessageIds: new Set(), toolStartedAt: new Map(), activeTools: new Map(),
  } as unknown as ActiveSession;
  const publishUsage = vi.fn();
  const host = {
    events: hub,
    publishTool: (session, tool) => {
      session.activeTools.set(tool.id, tool);
      hub.publishSession(session.ref, { type: "tool.upsert", runId: "run", payload: { tool } });
    },
    publishContextUsage: vi.fn(), publishUsage, publishSummary: vi.fn(),
  } as Pick<SessionPiHost, "events" | "publishTool" | "publishContextUsage" | "publishUsage" | "publishSummary"> as SessionPiHost;
  const handler = new SessionPiEvents(host);
  const update = (partial: AssistantMessage, event: AssistantMessageEvent) => handler.handle(active, { type: "message_update", message: partial, assistantMessageEvent: event });
  const snapshot = () => ({
    seq: hub.currentSeq(active.ref), status: active.state, model: { available: [] },
    thinking: { current: "off" as const, available: ["off" as const] },
    liveMessages: [...active.liveMessages.values()], liveThinking: [...active.liveThinking.values()],
    partialAssistantItems: [...active.partialAssistantItems.values()], streamingMessageIds: [...active.streamingMessageIds],
    activeTools: [...active.activeTools.values()],
    ...(active.partial === undefined ? {} : { partial: active.partial }),
    ...(active.partialThinking === undefined ? {} : { partialThinking: active.partialThinking }),
  });
  return { active, events, handler, update, snapshot, publishUsage, close: () => hub.terminateAll() };
}

describe("Pi assistant block streaming", () => {
  it("reconciles mixed blocks in source order across end, refresh and later tool execution", () => {
    const fixture = setup();
    try {
      const complete = message([
        { type: "text", text: "正在检查\nPreparing", textSignature: signature("commentary") },
        { type: "thinking", thinking: "Reasoning after text" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
        { type: "text", text: "已完成\nDone", textSignature: signature("final_answer") },
      ]);
      fixture.update(complete, { type: "text_start", contentIndex: 0, partial: complete });
      fixture.update(complete, { type: "text_delta", contentIndex: 0, delta: "temporary", partial: complete });
      fixture.update(complete, { type: "text_end", contentIndex: 0, content: "正在检查\nPreparing", partial: complete });
      fixture.update(complete, { type: "thinking_delta", contentIndex: 1, delta: "Reasoning", partial: complete });
      fixture.update(complete, { type: "thinking_end", contentIndex: 1, content: "Reasoning after text", partial: complete });
      fixture.update(complete, { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }, partial: complete });
      fixture.update(complete, { type: "text_delta", contentIndex: 3, delta: "已完成", partial: complete });
      const streamed = applySessionEvents(emptyTranscript, fixture.events);
      const refreshed = hydrateTranscript(emptyTranscript, { items: [], start: 0, total: 0, hasMore: false }, fixture.snapshot());
      expect(refreshed.items).toEqual(streamed.items);
      expect(refreshed.streamingMessageIds).toEqual([`message:assistant:${timestamp}:text:3`]);
      expect(fixture.active.partial?.text).toBe("正在检查\nPreparing\n\n已完成");

      fixture.handler.handle(fixture.active, { type: "message_end", message: complete });
      fixture.handler.handle(fixture.active, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } });
      fixture.handler.handle(fixture.active, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "source" }] }, isError: false });
      const result = applySessionEvents(emptyTranscript, fixture.events);
      const history = projectHistory([
        { type: "message", id: "entry", message: complete },
        { type: "message", id: "result", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "source" }] } },
      ]);
      expect(result.items.map((item) => [item.id, item.kind, "contentIndex" in item ? item.contentIndex : undefined])).toEqual(
        history.map((item) => [item.id, item.kind, "contentIndex" in item ? item.contentIndex : undefined]),
      );
      expect(result.items[0]).toMatchObject({ text: "正在检查\nPreparing", phase: "commentary" });
      expect(result.items[3]).toMatchObject({ text: "已完成\nDone", phase: "final_answer" });
      expect(result.streamingMessageId).toBeUndefined();
      const hydrated = hydrateTranscript(result, { items: history, start: 0, total: history.length, hasMore: false }, fixture.snapshot());
      expect(hydrated.items).toEqual(result.items);
      expect(fixture.active.partialAssistantItems.size).toBe(0);
      expect(fixture.active.activeTools.get("read-1")).toMatchObject({ state: "completed", contentIndex: 2, assistantMessageId: `message:assistant:${timestamp}` });
    } finally { fixture.close(); }
  });

  it("does not copy mutable partial text at start and calibrates phase at text_end", () => {
    const fixture = setup();
    try {
      const partial = message([{ type: "text", text: "future response-so-far" }]);
      fixture.update(partial, { type: "text_start", contentIndex: 0, partial });
      fixture.update(partial, { type: "text_delta", contentIndex: 0, delta: "delta", partial });
      expect(fixture.active.partialAssistantItems.get(0)).toMatchObject({ text: "delta" });
      partial.content[0] = { type: "text", text: "authoritative", textSignature: signature("commentary") };
      fixture.update(partial, { type: "text_end", contentIndex: 0, content: "authoritative", partial });
      const result = applySessionEvents(emptyTranscript, fixture.events);
      expect(result.items).toEqual([expect.objectContaining({ text: "authoritative", phase: "commentary" })]);
      expect(result.streamingMessageId).toBeUndefined();
      expect(fixture.snapshot().streamingMessageIds).toEqual([]);
    } finally { fixture.close(); }
  });

  it("keeps prior responses when the next response reuses the same block indexes", () => {
    const fixture = setup();
    try {
      const first = message([{ type: "thinking", thinking: "First thought" }, { type: "text", text: "First reply" }]);
      fixture.update(first, { type: "thinking_delta", contentIndex: 0, delta: "First thought", partial: first });
      fixture.handler.handle(fixture.active, { type: "message_end", message: first });
      const second = { ...message([{ type: "text", text: "Second reply", textSignature: signature("final_answer") }]), timestamp: timestamp + 1000 };
      fixture.update(second, { type: "text_start", contentIndex: 0, partial: second });
      fixture.update(second, { type: "text_delta", contentIndex: 0, delta: "Second reply", partial: second });
      fixture.handler.handle(fixture.active, { type: "message_end", message: second });
      const result = applySessionEvents(emptyTranscript, fixture.events);
      expect(result.items.flatMap((item) => item.kind === "message" || item.kind === "thinking" ? [item.text] : [])).toEqual(["First thought", "First reply", "Second reply"]);
      expect(new Set(result.items.map((item) => item.id)).size).toBe(3);
      expect(fixture.active.liveThinking.size).toBe(1);
      expect(fixture.active.liveMessages.size).toBe(2);
      expect(fixture.snapshot().partialAssistantItems).toEqual([]);
      expect(fixture.active.assistantStreamId).toBeUndefined();
    } finally { fixture.close(); }
  });

  it("keeps live generation through text_end until message_end publishes exact usage", async () => {
    const fixture = setup();
    try {
      const complete = {
        ...message([{ type: "text", text: "Exact answer", textSignature: signature("final_answer") }]),
        usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 1, totalTokens: 20, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
      };
      fixture.update(complete, { type: "text_start", contentIndex: 0, partial: complete });
      fixture.update(complete, { type: "text_delta", contentIndex: 0, delta: "Exact answer", partial: complete });
      fixture.update(complete, { type: "text_end", contentIndex: 0, content: "Exact answer", partial: complete });
      const provisional = applySessionEvents(emptyTranscript, fixture.events);
      expect(provisional.liveGeneration).toMatchObject({ assistantMessageId: `message:assistant:${timestamp}`, estimatedOutputTokens: 3 });
      expect(provisional.streamingMessageId).toBeUndefined();

      fixture.handler.handle(fixture.active, { type: "message_end", message: complete });
      await Promise.resolve();
      const completed = applySessionEvents(emptyTranscript, fixture.events);
      expect(completed.liveGeneration).toBeUndefined();
      expect(completed.items).toEqual([expect.objectContaining({
        kind: "message", generation: expect.objectContaining({ usage: expect.objectContaining({ input: 12, output: 4, cacheRead: 3, cacheWrite: 1, total: 20 }) }),
      })]);
      expect(fixture.publishUsage).toHaveBeenCalledWith(fixture.active, "run");
      expect(fixture.active.session.sessionManager.appendCustomEntry).toHaveBeenCalledWith("jarvis.generation", expect.objectContaining({ assistantMessageId: `message:assistant:${timestamp}` }));
    } finally { fixture.close(); }
  });

  it("uses empty thinking_end content to clear the provisional thought", () => {
    const fixture = setup();
    try {
      const partial = message([{ type: "thinking", thinking: "mutable future" }]);
      fixture.update(partial, { type: "thinking_start", contentIndex: 0, partial });
      fixture.update(partial, { type: "thinking_delta", contentIndex: 0, delta: "temporary", partial });
      fixture.update(partial, { type: "thinking_end", contentIndex: 0, content: "", partial });
      expect(applySessionEvents(emptyTranscript, fixture.events).items).toEqual([expect.objectContaining({ text: "", state: "completed" })]);
      expect(fixture.snapshot().partialAssistantItems).toEqual([expect.objectContaining({ text: "", state: "completed" })]);
      fixture.handler.handle(fixture.active, { type: "message_end", message: message([]) });
      expect(applySessionEvents(emptyTranscript, fixture.events).items).toEqual([]);
    } finally { fixture.close(); }
  });

  it("removes discarded provisional blocks when authoritative content is empty", () => {
    const fixture = setup();
    try {
      const partial = message([{ type: "thinking", thinking: "temporary" }, { type: "text", text: "temporary" }]);
      fixture.update(partial, { type: "thinking_delta", contentIndex: 0, delta: "temporary", partial });
      fixture.update(partial, { type: "text_delta", contentIndex: 1, delta: "temporary", partial });
      fixture.handler.handle(fixture.active, { type: "message_end", message: message([]) });
      expect(applySessionEvents(emptyTranscript, fixture.events).items).toEqual([]);
      expect(fixture.active.liveMessages.size).toBe(0);
      expect(fixture.active.liveThinking.size).toBe(0);
    } finally { fixture.close(); }
  });
});
