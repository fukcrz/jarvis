import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySessionEvents, emptyTranscript } from "../client/transcript.js";
import type { SessionEvent, ToolTimelineItem } from "../shared/protocol.js";
import { projectHistory, toolFromCall } from "./projection.js";
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
    const handler = new SessionPiEvents({
      publishTool(session: ActiveSession, updated: ToolTimelineItem) {
        session.activeTools.set(updated.id, updated);
        events.push(hub.publishSession(session.ref, { type: "tool.upsert", payload: { tool: updated } }));
      },
    } as unknown as SessionPiHost);
    const unsubscribe = bus.on("pi-subagent:live:v1", (data) => handler.handleSubagentUpdate(active, data));
    try {
      bus.emit("pi-subagent:live:v1", { version: 1, thread });
      const running = applySessionEvents(emptyTranscript, events);
      expect(running.items).toHaveLength(1);
      expect(running.items[0]).toMatchObject({ id: tool.id, state: "completed", subagent: { running: 1, results: [{ recentSteps: [{ text: "Reading" }], usage: { total: 15 } }] } });
      // The root's next turn clears activeTools; child identity must survive it.
      active.activeTools.clear();
      bus.emit("pi-subagent:live:v1", { version: 1, thread: { ...thread, state: "completed", output: "OK", elapsedMs: 800, outputTokens: 5 } });
      const completed = applySessionEvents(running, events.slice(1));
      expect(completed.items).toHaveLength(1);
      expect(completed.items[0]).toMatchObject({ id: tool.id, subagent: { running: 0, completed: 1, results: [{ state: "completed", output: "OK", durationMs: 800, usage: { total: 17 } }] } });
      expect(active.state.runState).toBe("idle");
      unsubscribe();
      bus.emit("pi-subagent:live:v1", { version: 1, thread });
      expect(events).toHaveLength(2);
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
});
