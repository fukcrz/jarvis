import { describe, expect, it } from "vitest";
import type { ToolTimelineItem } from "../shared/protocol.js";
import { attachSubagentView, subagentViewFromArgs } from "./subagent-view.js";

const dispatchedAt = "2026-01-01T00:00:00.000Z";

function tool(createdAt = dispatchedAt): ToolTimelineItem {
  return { kind: "tool", id: "sa", createdAt, name: "subagent", title: "Subagent", state: "running" };
}

function result(exitCode: number, timestamps: number[]) {
  return {
    details: {
      kind: "pi-subagent",
      results: [{
        agent: "scout",
        prompt: "Map the auth flow",
        exitCode,
        ...(exitCode === -1 ? {} : { stopReason: "stop" }),
        usage: { turns: 3 },
        messages: timestamps.map((timestamp) => ({ role: "assistant", timestamp, content: [{ type: "text", text: "ok" }] })),
      }],
    },
  };
}

const base = Date.parse("2026-01-01T00:01:00.000Z");

describe("subagent call timing", () => {
  it("runs the clock from the first child message while the call is live", () => {
    const view = attachSubagentView(tool(), result(-1, [base, base + 30_000])).subagent;
    expect(view?.results[0]).toMatchObject({ state: "running", startedAt: new Date(base).toISOString() });
    expect(view?.results[0]?.durationMs).toBeUndefined();
  });

  it("reports the finished span as the call duration", () => {
    const view = attachSubagentView(tool(), result(0, [base, base + 30_000, base + 95_000])).subagent;
    expect(view?.results[0]).toMatchObject({ state: "completed", startedAt: new Date(base).toISOString(), durationMs: 95_000 });
  });

  it("starts from dispatch time before the child has any message", () => {
    const view = subagentViewFromArgs("subagent", { calls: [{ agent: "scout", prompt: "Map the auth flow" }] }, dispatchedAt)?.results[0];
    expect(view).toMatchObject({ state: "running", startedAt: dispatchedAt });
  });
});
