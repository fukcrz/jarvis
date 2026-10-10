import { describe, expect, it } from "vitest";
import type { SubagentCallView, ToolTimelineItem } from "../../shared/protocol";
import { collapseUntouchedTimelineProcess, collapsedToolActivityItems, emptyTimelineFoldState, subagentCallDetailId, toggleTimelineDetail, toggleTimelineProcess, visibleToolActivityItemIds } from "./timeline-fold";

function item(id: string, state: ToolTimelineItem["state"] = "completed"): ToolTimelineItem {
  return { kind: "tool", id, createdAt: "", name: "read", title: "Read file", state };
}

describe("timeline fold state", () => {
  it("opens a detail and its parent, then restores the detail after a parent fold", () => {
    const opened = toggleTimelineDetail(emptyTimelineFoldState("session"), "process-1", "detail-1", false);
    expect(opened.openProcessIds.has("process-1")).toBe(true);
    expect(opened.openDetailIds.has("detail-1")).toBe(true);
    expect(opened.touchedProcessIds.has("process-1")).toBe(true);

    const folded = toggleTimelineProcess(opened, "process-1");
    expect(folded.openProcessIds.has("process-1")).toBe(false);
    expect(folded.openDetailIds.has("detail-1")).toBe(true);

    const restored = toggleTimelineProcess(folded, "process-1");
    expect(restored.openProcessIds.has("process-1")).toBe(true);
    expect(restored.openDetailIds.has("detail-1")).toBe(true);
  });

  it("does not clear an already selected detail when a collapsed parent is clicked", () => {
    const selected = toggleTimelineDetail(emptyTimelineFoldState(), "process-1", "detail-1", true);
    const folded = toggleTimelineProcess(selected, "process-1");
    const reopened = toggleTimelineDetail(folded, "process-1", "detail-1", false);
    expect(reopened.openProcessIds.has("process-1")).toBe(true);
    expect(reopened.openDetailIds.has("detail-1")).toBe(true);
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
