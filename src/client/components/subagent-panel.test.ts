import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { subagentPanelThreads } from "../lib/subagent-panel";
import type { SubagentCallView, SubagentView, ToolTimelineItem } from "../../shared/protocol";
import { SubagentPanel } from "./subagent-panel";

function thread(overrides: Partial<SubagentCallView> & { agent: string }): ToolTimelineItem[] {
  const results: SubagentCallView[] = [{ prompt: "做事", state: "running", ...overrides }];
  const view: SubagentView = { kind: "pi-subagent", results, total: 1, completed: 0, running: 1, failed: 0 };
  return [{ kind: "tool", id: "t1", createdAt: "2026-11-12T00:00:00.000Z", name: "agent_spawn", title: "agent_spawn", state: "running", subagent: view }];
}

describe("SubagentPanel", () => {
  it("shows a single empty line when the session has no subagent", () => {
    const html = renderToStaticMarkup(createElement(SubagentPanel, { threads: [], onLocate: () => undefined }));
    expect(html).toContain("无子代理");
    expect(html).not.toContain("subagent-list");
  });

  it("renders one row per thread with its agent, elapsed clock and current action", () => {
    const threads = subagentPanelThreads(thread({ agent: "executor", label: "/root/plan/exec", durationMs: 192_000, output: "改完了" }));
    const html = renderToStaticMarkup(createElement(SubagentPanel, { threads, onLocate: () => undefined }));
    expect(html).toContain("executor");
    expect(html).toContain("3:12");
    expect(html).toContain("改完了");
    expect(html).toContain('data-depth="1"');
    expect(html).toContain("exec");
  });

  it("marks running threads and keeps finished ones under their own heading", () => {
    const threads = subagentPanelThreads([
      ...thread({ agent: "planner", label: "/root/a", startedAt: "2026-11-12T00:00:00.000Z" }),
      ...thread({ agent: "verifier", label: "/root/b", state: "failed", error: "没通过" }),
    ]);
    const html = renderToStaticMarkup(createElement(SubagentPanel, { threads, onLocate: () => undefined }));
    expect(html).toContain('data-state="running"');
    expect(html).toContain("已结束");
    expect(html).toContain("没通过");
  });

  it("nests a child under its parent and leaves a finished child out of the finished group", () => {
    const threads = subagentPanelThreads([
      { kind: "tool", id: "t1", createdAt: "2026-11-12T00:00:00.000Z", name: "agent_spawn", title: "agent_spawn", state: "running", subagent: { kind: "pi-subagent", total: 2, completed: 1, running: 1, failed: 0, results: [
        { agent: "planner", label: "/root/plan", prompt: "派活", state: "running", startedAt: "2026-11-12T00:00:01.000Z" },
        { agent: "executor", label: "/root/plan/exec", prompt: "写测试", state: "completed", durationMs: 1_000, output: "测完了" },
      ] } },
    ]);
    const html = renderToStaticMarkup(createElement(SubagentPanel, { threads, onLocate: () => undefined }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("subagent-children");
    expect(html).toContain("测完了");
    expect(html).not.toContain("已结束");
  });
});
