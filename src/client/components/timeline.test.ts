import { describe, expect, it } from "vitest";
import type { TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { groupTimelineItems } from "./timeline";

function tool(id: string, name = "read"): ToolTimelineItem {
  return {
    kind: "tool",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    name,
    title: name === "read" ? "Read file" : "Run command",
    state: "completed",
  };
}

function message(id: string): TimelineItem {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    role: "assistant",
    text: "message",
  };
}

function thinking(id: string): TimelineItem {
  return {
    kind: "thinking",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "completed",
    text: "thinking",
  };
}

describe("groupTimelineItems", () => {
  it("groups only consecutive tool items", () => {
    const result = groupTimelineItems([tool("a"), tool("b", "bash"), message("m"), tool("c")]);

    expect(result).toEqual([
      { kind: "activity", items: [tool("a"), tool("b", "bash")] },
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("c")] },
    ]);
  });

  it("keeps message-only timelines unchanged", () => {
    expect(groupTimelineItems([message("a"), message("b")])).toEqual([
      { kind: "message", item: message("a") },
      { kind: "message", item: message("b") },
    ]);
  });

  it("keeps thinking cards as their own entries and splits tool runs around them", () => {
    const result = groupTimelineItems([tool("a"), thinking("t"), message("m"), tool("c")]);

    expect(result).toEqual([
      { kind: "activity", items: [tool("a")] },
      { kind: "thinking", item: thinking("t") },
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("c")] },
    ]);
  });

  it("returns an empty list for an empty timeline", () => {
    expect(groupTimelineItems([])).toEqual([]);
  });
});
