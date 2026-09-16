import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentView, ToolTimelineItem } from "../../shared/protocol";
import { ToolActivity } from "./tool-activity";

function subagentTool(state: ToolTimelineItem["state"], view: SubagentView): ToolTimelineItem {
  return {
    kind: "tool",
    id: "sa-1",
    createdAt: "2026-08-09T00:00:00.000Z",
    name: "subagent",
    title: "subagent",
    state,
    subagent: view,
  };
}

describe("ToolActivity subagent rows", () => {
  it("collapses a single running call to agent and status", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("running", {
        kind: "pi-subagent",
        results: [{ agent: "scout", prompt: "Find the auth flow", state: "running" }],
        total: 1,
        completed: 0,
        running: 1,
        failed: 0,
      })],
      active: true,
    }));
    expect(markup).toContain("scout · 执行中");
    expect(markup).not.toContain("Find the auth flow");
  });

  it("collapses parallel calls to a completion fraction", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("running", {
        kind: "pi-subagent",
        results: [
          { agent: "scout", prompt: "A", state: "completed", output: "done" },
          { agent: "worker", prompt: "B", state: "running" },
          { agent: "reviewer", prompt: "C", state: "running" },
        ],
        total: 3,
        completed: 1,
        running: 2,
        failed: 0,
      })],
      active: true,
    }));
    expect(markup).toContain("1/3 完成");
    expect(markup).not.toContain("done");
  });

  it("collapses a failed call without dumping output", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("failed", {
        kind: "pi-subagent",
        results: [{ agent: "scout", prompt: "Find auth", state: "failed", error: "boom" }],
        total: 1,
        completed: 0,
        running: 0,
        failed: 1,
      })],
      active: false,
    }));
    expect(markup).toContain("scout · 失败");
    expect(markup).not.toContain("boom");
  });
});
