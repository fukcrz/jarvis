import { describe, expect, it } from "vitest";
import type { ToolTimelineItem } from "../../shared/protocol";
import { isActivityOpenByDefault } from "./tool-activity";

function tool(id: string, name = "read"): ToolTimelineItem {
  return { kind: "tool", id, createdAt: "2026-01-01T00:00:00.000Z", name, title: name, state: "completed" };
}

describe("isActivityOpenByDefault", () => {
  it("keeps groups of up to three tool calls expanded", () => {
    expect(isActivityOpenByDefault([tool("a")])).toBe(true);
    expect(isActivityOpenByDefault([tool("a"), tool("b"), tool("c")])).toBe(true);
  });

  it("collapses ordinary groups with more than three tool calls", () => {
    expect(isActivityOpenByDefault([tool("a"), tool("b"), tool("c"), tool("d")])).toBe(false);
  });

  it("keeps explicit user commands visible regardless of group size", () => {
    expect(isActivityOpenByDefault([tool("a"), tool("b"), tool("c"), { ...tool("bash:run", "bash"), id: "bash:run" }])).toBe(true);
  });
});
