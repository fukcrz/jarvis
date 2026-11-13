import { describe, expect, it } from "vitest";
import type { SubagentCallView, SubagentView, TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { formatCost, formatThreadElapsed, formatTokenCount, groupSubagentThreads, runningThreadCount, subagentPanelThreads, threadMeta } from "./subagent-panel";

function call(overrides: Partial<SubagentCallView> & { agent: string }): SubagentCallView {
  return { prompt: "do the thing", state: "running", ...overrides };
}

function toolItem(id: string, results: SubagentCallView[]): ToolTimelineItem {
  const view: SubagentView = { kind: "pi-subagent", results, total: results.length, completed: 0, running: results.length, failed: 0 };
  return { kind: "tool", id, createdAt: "2026-11-12T00:00:00.000Z", name: "agent_spawn", title: "agent_spawn", state: "running", subagent: view };
}

const items: TimelineItem[] = [
  { kind: "tool", id: "plain", createdAt: "2026-11-12T00:00:00.000Z", name: "read", title: "read", state: "completed" },
  toolItem("t1", [
    call({ agent: "planner", label: "/root/plan", startedAt: "2026-11-12T00:00:01.000Z", recentSteps: [{ kind: "tool", name: "read", summary: "read src/app.tsx" }] }),
    call({ agent: "executor", label: "/root/plan/exec", startedAt: "2026-11-12T00:00:02.000Z" }),
  ]),
];

describe("subagentPanelThreads", () => {
  it("flattens subagent calls and derives indentation from the thread path", () => {
    const threads = subagentPanelThreads(items);
    expect(threads.map((thread) => [thread.agent, thread.path, thread.depth])).toEqual([
      ["planner", "/root/plan", 0],
      ["executor", "/root/plan/exec", 1],
    ]);
    expect(threads[0]?.line).toBe("read src/app.tsx");
    expect(threads[1]?.line).toBe("do the thing");
  });

  it("keeps the newest state when the same path shows up again", () => {
    const threads = subagentPanelThreads([
      ...items,
      toolItem("t2", [call({ agent: "planner", label: "/root/plan", state: "completed", durationMs: 65_000, output: "换掉了三处调用" })]),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0]?.state).toBe("completed");
    expect(threads[0]?.line).toBe("换掉了三处调用");
  });

  it("strips markdown emphasis from the action line", () => {
    const threads = subagentPanelThreads([toolItem("t8", [call({ agent: "executor", recentSteps: [{ kind: "text", text: "**Changed** — 未改文件，`git status` 干净" }] })])]);
    expect(threads[0]?.line).toBe("Changed — 未改文件，git status 干净");
  });

  it("surfaces the error first when a thread failed", () => {
    const threads = subagentPanelThreads([toolItem("t3", [call({ agent: "verifier", state: "failed", error: "测试没通过", recentSteps: [{ kind: "tool", summary: "bash npm test" }] })])]);
    expect(threads[0]?.line).toBe("测试没通过");
  });

  it("groups running threads first and counts only the running ones", () => {
    const threads = subagentPanelThreads([
      toolItem("t4", [
        call({ agent: "executor", label: "/root/b", state: "completed", durationMs: 1_000 }),
        call({ agent: "planner", label: "/root/c", startedAt: "2026-11-12T00:00:05.000Z" }),
        call({ agent: "verifier", label: "/root/a", state: "partial", durationMs: 2_000 }),
      ]),
    ]);
    const { active, finished } = groupSubagentThreads(threads);
    expect(active.map((thread) => thread.agent)).toEqual(["verifier", "planner"]);
    expect(finished.map((thread) => thread.agent)).toEqual(["executor"]);
    expect(runningThreadCount(threads)).toBe(1);
  });
});

describe("subagent step labels", () => {
  it("uses the tool name as the step label and drops the plugin prefix", () => {
    const [thread] = subagentPanelThreads([toolItem("t9", [call({ agent: "executor", recentSteps: [{ kind: "tool", name: "bash", summary: "Tool: bash npm test" }, { kind: "thinking", text: "想想怎么做" }] })])]);
    expect(thread?.steps).toEqual([{ kind: "tool", label: "bash", text: "bash npm test" }, { kind: "thinking", text: "想想怎么做" }]);
    expect(thread?.line).toBe("想想怎么做");
  });

  it("turns the manager status line into a tool step with the tool name", () => {
    const [thread] = subagentPanelThreads([toolItem("t10", [call({ agent: "executor", recentSteps: [{ kind: "text", text: "Tool: Bash" }] })])]);
    expect(thread?.steps).toEqual([{ kind: "tool", label: "bash", text: "" }]);
    expect(thread?.line).toBe("bash");
  });

  it("handles the second manager status form and keeps the tool detail", () => {
    const [thread] = subagentPanelThreads([toolItem("t11", [call({ agent: "executor", recentSteps: [{ kind: "text", text: "Tool bash: finished" }] })])]);
    expect(thread?.steps).toEqual([{ kind: "tool", label: "bash", text: "" }]);
    expect(thread?.line).toBe("bash");

    const [withArgs] = subagentPanelThreads([toolItem("t12", [call({ agent: "executor", recentSteps: [{ kind: "text", text: "Tool: bash wc -l package.json" }] })])]);
    expect(withArgs?.steps).toEqual([{ kind: "tool", label: "bash", text: "wc -l package.json" }]);
    expect(withArgs?.line).toBe("wc -l package.json");
  });
});

describe("subagent panel formatting", () => {
  it("formats tokens and cost only when there is something to show", () => {
    expect(formatTokenCount(0)).toBeUndefined();
    expect(formatTokenCount(940)).toBe("940 tok");
    expect(formatTokenCount(12_400)).toBe("12k tok");
    expect(formatTokenCount(2_400_000)).toBe("2.4M tok");
    expect(formatCost(0)).toBeUndefined();
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(0.42)).toBe("$0.42");
  });

  it("freezes the clock for a paused thread and ticks for a running one", () => {
    const [running] = subagentPanelThreads([toolItem("t5", [call({ agent: "planner", startedAt: "2026-11-12T00:00:00.000Z" })])]);
    expect(running === undefined ? undefined : formatThreadElapsed(running, Date.parse("2026-11-12T00:01:12.000Z"))).toBe("1:12");
    const [paused] = subagentPanelThreads([toolItem("t6", [call({ agent: "planner", state: "partial", durationMs: 95_000 })])]);
    expect(paused === undefined ? undefined : formatThreadElapsed(paused, Date.parse("2026-11-12T09:00:00.000Z"))).toBe("1:35");
  });

  it("lists model, thinking, tokens and cost for the detail meta line", () => {
    const [thread] = subagentPanelThreads([toolItem("t7", [call({ agent: "executor", model: "sol", thinkingLevel: "high", usage: { total: 12_400, cost: 0.03 } })])]);
    expect(thread === undefined ? undefined : threadMeta(thread)).toEqual(["sol", "thinking high", "12k tok", "$0.03"]);
  });
});
