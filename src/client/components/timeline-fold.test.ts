import { describe, expect, it } from "vitest";
import type { SubagentCallView, ToolTimelineItem } from "../../shared/protocol";
import { activityGroupId, collapseUntouchedTimelineProcess, collapsedToolActivityItems, emptyTimelineFoldState, subagentCallDetailId, toggleTimelineDetail, toggleTimelineGroup, toggleTimelineProcess, toggleTimelineThinking, visibleToolActivityItemIds } from "./timeline-fold";

function item(id: string, state: ToolTimelineItem["state"] = "completed"): ToolTimelineItem {
  return { kind: "tool", id, createdAt: "", name: "read", title: "Read file", state };
}

describe("timeline fold state", () => {
  it("keeps a manual thinking fold through later tokens and lets it reopen", () => {
    const closed = toggleTimelineThinking(emptyTimelineFoldState(), "thinking-1", true);
    expect(closed.closedDetailIds.has("thinking-1")).toBe(true);
    expect(closed.openThinkingIds.has("thinking-1")).toBe(false);
    const reopened = toggleTimelineThinking(closed, "thinking-1", false);
    expect(reopened.closedDetailIds.has("thinking-1")).toBe(false);
    expect(reopened.openThinkingIds.has("thinking-1")).toBe(true);
  });

  it("toggles a detail without opening the process", () => {
    const opened = toggleTimelineDetail(emptyTimelineFoldState("session"), "process-1", "detail-1", true);
    expect(opened.openProcessIds.has("process-1")).toBe(false);
    expect(opened.openDetailIds.has("detail-1")).toBe(true);
    expect(toggleTimelineDetail(opened, "process-1", "detail-1", true).openDetailIds.has("detail-1")).toBe(false);
  });

  it("toggles a tool group without opening the process", () => {
    const collapsed = toggleTimelineGroup(emptyTimelineFoldState(), "process-1", activityGroupId("tool-1"));
    expect(collapsed.openGroupIds.has("group:tool-1")).toBe(true);
    expect(collapsed.openProcessIds.has("process-1")).toBe(false);
    expect(toggleTimelineGroup(collapsed, "process-1", activityGroupId("tool-1")).openGroupIds.has("group:tool-1")).toBe(false);
  });

  it("auto-collapses only an untouched open process", () => {
    const untouched = { ...emptyTimelineFoldState(), openProcessIds: new Set(["process-1"]) };
    const collapsed = collapseUntouchedTimelineProcess(untouched, "process-1");
    expect(collapsed.openProcessIds.has("process-1")).toBe(false);

    const touched = toggleTimelineProcess(untouched, "process-1");
    const reopened = toggleTimelineProcess(touched, "process-1");
    const preserved = collapseUntouchedTimelineProcess(reopened, "process-1");
    expect(preserved.openProcessIds.has("process-1")).toBe(true);
    expect(preserved.touchedProcessIds.has("process-1")).toBe(true);
  });

  it("closes a process that is open by default without being in the open set", () => {
    const closed = toggleTimelineProcess(emptyTimelineFoldState(), "live", true);
    expect(closed.openProcessIds.has("live")).toBe(false);
    expect(closed.touchedProcessIds.has("live")).toBe(true);
    expect(toggleTimelineProcess(closed, "live", false).openProcessIds.has("live")).toBe(true);
  });
});

describe("collapsed tool visibility", () => {
  it("keeps active work, ordinary failures, and partial subagent failures in the summary", () => {
    const completed = item("completed");
    const running = item("running", "running");
    const failed = item("failed", "failed");
    const partialFailure = {
      ...item("subagent", "running"),
      subagent: {
        kind: "pi-subagent" as const,
        results: [{ agent: "scout", prompt: "Inspect", state: "failed" as const }],
        total: 1,
        completed: 0,
        running: 0,
        failed: 1,
      },
    };
    expect(collapsedToolActivityItems([completed, running, failed, partialFailure], true, true)).toEqual([running, failed, partialFailure]);
    expect(visibleToolActivityItemIds([completed, running, failed, partialFailure], true, true)).toEqual(new Set(["running", "failed", "subagent"]));
  });
});

describe("subagent call detail identity", () => {
  it("uses callIndex for calls without session handles so reordering preserves identity", () => {
    const first: SubagentCallView = { callIndex: 0, agent: "worker", prompt: "same", state: "completed" };
    const second: SubagentCallView = { callIndex: 1, agent: "worker", prompt: "same", state: "completed" };
    expect(subagentCallDetailId("tool-1", first)).not.toBe(subagentCallDetailId("tool-1", second));
    expect(subagentCallDetailId("tool-1", first)).toBe(subagentCallDetailId("tool-1", { ...first }));
  });

  it("adds a render fallback for identical legacy calls", () => {
    const call: SubagentCallView = { agent: "worker", prompt: "same", state: "completed" };
    expect(subagentCallDetailId("tool-1", call, 0)).not.toBe(subagentCallDetailId("tool-1", call, 1));
  });

  it("keeps the call index stable when a later result adds a session handle", () => {
    const seeded: SubagentCallView = { callIndex: 1, agent: "worker", prompt: "same", state: "running" };
    const completed: SubagentCallView = { ...seeded, state: "completed", sessionHandle: "worker-session" };
    expect(subagentCallDetailId("tool-1", seeded)).toBe(subagentCallDetailId("tool-1", completed));
  });
});
