import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySessionEvents, emptyTranscript } from "../client/transcript.js";
import type { SessionEvent, SessionRef, ToolTimelineItem } from "../shared/protocol.js";
import { projectHistory, toolFromCall } from "./projection.js";
import { attachLiveSubagentThread, subagentStreamItems } from "./subagent-view.js";
import { summaryFromActive } from "./session-catalog.js";
import { EventHub } from "./event-hub.js";
import type { ActiveSession } from "./session-active.js";
import { SessionPiEvents, type SessionPiHost } from "./session-pi-events.js";

const thread = { path: "/root/short-test", type: "scout", task: "Return OK", state: "running", status: "Reading", createdAt: 1000, inputTokens: 12, outputTokens: 3 };
const args = { path: "short-test", type: "scout", task: thread.task, wait: false };

describe("subagent live card bridge", () => {
  it("updates a detached card after root settlement and replaces the existing browser item", () => {
    const bus = createEventBus();
    const hub = new EventHub();
    const events: SessionEvent[] = [];
    const tool = { ...toolFromCall("spawn-1", "agent_spawn", args), state: "completed" as const };
    const active = { ref: { workspaceId: "workspace", sessionId: "session" }, state: { sessionId: "session", runState: "idle" }, activeTools: new Map(), subagentTools: new Map([[tool.id, tool]]) } as unknown as ActiveSession;
    let summaries = 0;
    const handler = new SessionPiEvents({
      publishTool(session: ActiveSession, updated: ToolTimelineItem) {
        session.activeTools.set(updated.id, updated);
        events.push(hub.publishSession(session.ref, { type: "tool.upsert", payload: { tool: updated } }));
      },
      publishSummary() { summaries += 1; },
    } as unknown as SessionPiHost);
    const unsubscribe = bus.on("pi-subagent:live:v1", (data) => handler.handleSubagentUpdate(active, data));
    try {
      bus.emit("pi-subagent:live:v1", { version: 1, thread });
      const running = applySessionEvents(emptyTranscript, events);
      expect(running.items).toHaveLength(1);
      expect(running.items[0]).toMatchObject({ id: tool.id, state: "completed", subagent: { running: 1, results: [{ recentSteps: [{ text: "Reading" }], usage: { total: 15 } }] } });
      // 会话状态点读这一份：刚出现的线程立刻发布会话摘要。
      expect([...active.subagentThreads!.values()]).toMatchObject([{ path: thread.path, type: "scout", state: "running", line: "Reading" }]);
      expect(summaries).toBe(1);
      // 只换了一行进度、数量没变：一秒内不重复发布会话摘要。
      bus.emit("pi-subagent:live:v1", { version: 1, thread: { ...thread, status: "Writing tests" } });
      expect(summaries).toBe(1);
      // The root's next turn clears activeTools; child identity must survive it.
      active.activeTools.clear();
      bus.emit("pi-subagent:live:v1", { version: 1, thread: { ...thread, state: "completed", output: "OK", elapsedMs: 800, outputTokens: 5 } });
      const completed = applySessionEvents(running, events.slice(1));
      expect(completed.items).toHaveLength(1);
      expect(completed.items[0]).toMatchObject({ id: tool.id, subagent: { running: 0, completed: 1, results: [{ state: "completed", output: "OK", durationMs: 800, usage: { total: 17 } }] } });
      // 线程结束就离开未结束列表，状态行随之消失。
      expect(active.subagentThreads!.size).toBe(0);
      expect(summaries).toBe(2);
      expect(active.state.runState).toBe("idle");
      unsubscribe();
      bus.emit("pi-subagent:live:v1", { version: 1, thread });
      expect(events).toHaveLength(3);
    } finally { bus.clear(); hub.terminateAll(); }
  });

  it("hydrates final card state from existing registry checkpoints without extra timeline entries", () => {
    const entries = [
      { type: "message", id: "assistant", message: { role: "assistant", timestamp: 1000, content: [{ type: "toolCall", id: "spawn-1", name: "agent_spawn", arguments: args }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolCallId: "spawn-1", toolName: "agent_spawn", details: thread, content: [] } },
      { type: "custom", customType: "pi-subagent:registry:v1", data: { version: 1, rootSessionId: "session", threads: [{ view: thread }] } },
      { type: "custom", customType: "pi-subagent:registry-delta:v1", data: { version: 1, rootSessionId: "session", changes: [{ path: thread.path, view: { state: "completed", output: "OK", elapsedMs: 800 } }] } },
    ];
    expect(projectHistory(entries)).toMatchObject([{ kind: "tool", id: "spawn-1", subagent: { completed: 1, results: [{ output: "OK", durationMs: 800 }] } }]);
    expect(projectHistory([...entries, { type: "custom", customType: "pi-subagent:registry-delta:v1", data: { version: 1, changes: [{ path: thread.path, view: { state: "paused" }, cleared: ["output"] }] } }])).toMatchObject([{ subagent: { partial: 1, completed: 0, results: [{ state: "partial" }] } }]);
  });

  it("carries unfinished threads in the session summary", () => {
    const active = { ref: { workspaceId: "workspace", sessionId: "session" }, state: { sessionId: "session", runState: "idle" }, attentionState: "idle", activeTools: new Map(), subagentTools: new Map(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", session: { sessionName: "Session", sessionManager: { getBranch: () => [] } } } as unknown as ActiveSession;
    const handler = new SessionPiEvents({ publishTool() {}, publishSummary() {} } as unknown as SessionPiHost);
    handler.handleSubagentUpdate(active, { version: 1, thread });
    expect(summaryFromActive(active)).toMatchObject({ subagentThreads: [{ path: thread.path, type: "scout", state: "running" }] });
    handler.handleSubagentUpdate(active, { version: 1, thread: { ...thread, state: "completed", output: "OK" } });
    expect(summaryFromActive(active).subagentThreads).toEqual([]);
  });
});

describe("subagent live stream bridge", () => {
  function streamHost(published: SessionEvent[]): SessionPiHost {
    return {
      events: {
        publishSession(ref: SessionRef, event: Omit<SessionEvent, "version" | "sessionId" | "seq" | "emittedAt">) {
          const full = { ...event, version: 1, sessionId: ref.sessionId, seq: published.length + 1, emittedAt: "2026-01-01T00:00:00.000Z" } as SessionEvent;
          published.push(full);
          return full;
        },
      },
    } as unknown as SessionPiHost;
  }

  function emptyActive(): ActiveSession {
    return { ref: { workspaceId: "workspace", sessionId: "session" }, state: { sessionId: "session", runState: "idle" }, activeTools: new Map() } as unknown as ActiveSession;
  }

  it("buffers increments by id and forwards only the changed batch", () => {
    const published: SessionEvent[] = [];
    const handler = new SessionPiEvents(streamHost(published));
    const active = emptyActive();
    handler.handleSubagentStream(active, { version: 1, path: "/root/a", items: [{ id: "text:1:0", kind: "text", text: "Hel", streaming: true }] });
    handler.handleSubagentStream(active, { version: 1, path: "/root/a", items: [{ id: "text:1:0", kind: "text", text: "Hello", streaming: false }, { id: "tool:t1", kind: "tool", name: "bash", state: "running" }] });
    const buffered = active.subagentStreams?.get("/root/a") ?? [];
    expect(buffered).toMatchObject([{ id: "text:1:0", text: "Hello", streaming: false }, { id: "tool:t1", name: "bash", state: "running" }]);
    // 第二批发的是本批变化项，不是整段缓冲。
    expect(published).toHaveLength(2);
    expect((published[1]?.payload as { items: unknown[] }).items).toHaveLength(2);
    // 缓冲按线程分开。
    handler.handleSubagentStream(active, { version: 1, path: "/root/b", items: [{ id: "text:1:0", kind: "text", text: "Other" }] });
    expect(active.subagentStreams?.get("/root/b")).toHaveLength(1);
    expect(active.subagentStreams?.get("/root/a")).toHaveLength(2);
  });

  it("drops malformed batches and keeps only the newest 200 items", () => {
    const published: SessionEvent[] = [];
    const handler = new SessionPiEvents(streamHost(published));
    const active = emptyActive();
    handler.handleSubagentStream(active, { version: 2, path: "/root/a", items: [{ id: "x", kind: "text" }] });
    handler.handleSubagentStream(active, { version: 1, path: "", items: [{ id: "x", kind: "text" }] });
    handler.handleSubagentStream(active, { version: 1, path: "/root/a", items: [{ kind: "text" }] });
    expect(published).toHaveLength(0);
    const items = Array.from({ length: 250 }, (_, index) => ({ id: `text:${String(index)}`, kind: "text", text: `line ${String(index)}` }));
    handler.handleSubagentStream(active, { version: 1, path: "/root/a", items });
    const buffered = active.subagentStreams?.get("/root/a") ?? [];
    expect(buffered).toHaveLength(200);
    expect(buffered[0]?.id).toBe("text:50");
    expect(buffered.at(-1)?.id).toBe("text:249");
  });

  it("whitelists stream fields without truncating long assistant text", () => {
    const long = "x".repeat(5000);
    const items = subagentStreamItems([
      { id: "text:1", kind: "text", text: long, streaming: true, bogus: 1 },
      { id: "tool:1", kind: "tool", name: "bash", state: "weird", output: "ok", error: "boom" },
      { id: "", kind: "text" },
      { id: "x", kind: "video" },
      "not-an-object",
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toHaveLength(5000);
    expect(items[0]?.streaming).toBe(true);
    expect(items[1]).toEqual({ id: "tool:1", kind: "tool", name: "bash", output: "ok", error: "boom" });
  });

  it("derives the child session id from the thread session file", () => {
    const tool = { ...toolFromCall("spawn-1", "agent_spawn", args), state: "running" as const };
    const withFile = attachLiveSubagentThread(tool, {
      ...thread,
      sessionFile: "C:/Users/x/.pi/agent/sessions/--C--x--/2026-11-13T09-25-15-642Z_01a1d439-bafa-775a-a2e1-6897e3bc66f7.jsonl",
    });
    expect(withFile.subagent?.results[0]?.threadSessionId).toBe("01a1d439-bafa-775a-a2e1-6897e3bc66f7");
    const withoutFile = attachLiveSubagentThread(tool, { ...thread, sessionFile: "not-a-session.jsonl" });
    expect(withoutFile.subagent?.results[0]?.threadSessionId).toBeUndefined();
  });
});
