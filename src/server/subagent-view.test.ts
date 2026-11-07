import { describe, expect, it } from "vitest";
import type { ToolTimelineItem } from "../shared/protocol.js";
import { attachLiveSubagentThread, attachSubagentView, subagentViewFromArgs } from "./subagent-view.js";

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

const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

describe("parke.dev/pi-subagent shape", () => {
  it("seeds a running card from a single task", () => {
    const view = subagentViewFromArgs("subagent", {
      agent: "scout",
      description: "Map auth",
      task: "Map the auth flow",
      profile: "explore",
      model: "anthropic/claude-haiku-4.5",
      thinking: "high",
      isolation: "worktree",
    }, dispatchedAt);
    expect(view).toMatchObject({
      results: [{
        agent: "scout",
        label: "Map auth",
        prompt: "Map the auth flow",
        fullPrompt: "Map the auth flow",
        state: "running",
        startedAt: dispatchedAt,
        model: "anthropic/claude-haiku-4.5",
        thinkingLevel: "high",
        profile: "explore",
        worktree: true,
      }],
    });
  });

  it("seeds one call per parallel task and falls back to the profile as the name", () => {
    const view = subagentViewFromArgs("subagent", {
      tasks: [
        { task: "Read auth", description: "auth scout" },
        { task: "Review auth", agent: "reviewer", profile: "review" },
      ],
    }, dispatchedAt);
    expect(view?.results.map((call) => [call.agent, call.prompt, call.profile])).toEqual([
      ["子代理", "Read auth", undefined],
      ["reviewer", "Review auth", "review"],
    ]);
  });

  it("ignores management actions so they render as their own compact row", () => {
    expect(subagentViewFromArgs("subagent", { action: "status", id: "run-1" }, dispatchedAt)).toBeUndefined();
    expect(subagentViewFromArgs("subagent_wait", { id: "run-1" }, dispatchedAt)).toBeUndefined();
  });

  it("maps the result snapshot onto the existing card fields", () => {
    const seeded = { ...tool(), subagent: subagentViewFromArgs("subagent", { agent: "scout", task: "Map the auth flow" }, dispatchedAt) };
    expect(attachSubagentView(seeded, result(-1, [])).subagent?.results[0]?.state).toBe("running");
    const done = attachSubagentView(seeded, {
      details: {
        mode: "single",
        state: "completed",
        startedAt: base,
        endedAt: base + 95_000,
        results: [{
          label: "Map auth",
          task: "Map the auth flow",
          state: "completed",
          usage: { turns: 4 },
          model: "anthropic/claude-haiku-4.5",
          thinking: "high",
          profile: "explore",
          sessionId: "8f4d2c1b-0000-4000-8000-000000000000",
          finalOutput: "Auth lives in src/server/auth.ts",
          transcript: "Reading the router\n→ read {\"path\":\"src/server/auth.ts\"}\n← read export function auth()",
        }],
      },
    });
    expect(done.subagent).toMatchObject({
      total: 1,
      completed: 1,
      running: 0,
      failed: 0,
      results: [{
        agent: "scout",
        label: "Map auth",
        state: "completed",
        turns: 4,
        startedAt: dispatchedAt,
        durationMs: 95_000,
        profile: "explore",
        sessionHandle: "8f4d2c1b-0000-4000-8000-000000000000",
        output: "Auth lives in src/server/auth.ts",
        recentSteps: [
          { kind: "text", text: "Reading the router" },
          { kind: "tool", name: "read", summary: "auth.ts" },
        ],
      }],
    });
  });

  it("keeps a seeded call running when an async start returns before the child finishes", () => {
    const seeded = subagentViewFromArgs("subagent", { agent: "scout", task: "Map auth", async: true }, dispatchedAt);
    const running = { ...tool(), state: "completed" as const, subagent: seeded };
    const after = attachSubagentView(running, { details: { mode: "single", state: "running", results: [] } });
    expect(after.subagent?.results[0]?.state).toBe("running");
  });

  it("distinguishes a budget-stopped partial run", () => {
    const done = attachSubagentView(tool(), {
      details: { mode: "single", state: "partial", startedAt: base, endedAt: base + 1_000, results: [{ label: "task-1", task: "Do it", state: "partial", finalOutput: "half done" }] },
    });
    expect(done.subagent).toMatchObject({ completed: 0, partial: 1, results: [{ state: "partial", output: "half done" }] });
  });

  it("keeps tokens and cost for the card and drawer", () => {
    const done = attachSubagentView(tool(), {
      details: { mode: "single", state: "completed", startedAt: base, endedAt: base + 1_000, results: [{ label: "task-1", task: "Do it", state: "completed", finalOutput: "done", usage: { input: 1_200, output: 800, cacheRead: 300, cost: 0.0123, turns: 4 } }] },
    });
    expect(done.subagent?.results[0]?.usage).toEqual({ input: 1_200, output: 800, cacheRead: 300, total: 2_300, cost: 0.0123 });
    expect(done.subagent?.results[0]?.turns).toBe(4);
  });
});

function managerTool(name: string, state: ToolTimelineItem["state"] = "running"): ToolTimelineItem {
  return { kind: "tool", id: "m", createdAt: dispatchedAt, name, title: name, state };
}

const thread = {
  path: "/root/map-auth",
  type: "scout",
  task: "Map the auth flow",
  state: "completed",
  status: "Completed; session retained",
  output: "Auth flows through src/server/app.ts",
  inputTokens: 1_400,
  outputTokens: 260,
  costUsd: 0.004,
  elapsedMs: 42_000,
  kind: "threadState",
};

describe("pi-subagent-manager shape", () => {
  it("updates only the matching call, including relative root paths", () => {
    const seeded = { ...managerTool("agent_spawn"), subagent: subagentViewFromArgs("agent_spawn", { path: "map-auth", type: "scout", task: thread.task }, dispatchedAt) };
    expect(attachLiveSubagentThread(seeded, { ...thread, path: "/root/other" })).toBe(seeded);
    expect(attachLiveSubagentThread(seeded, null)).toBe(seeded);
    const live = attachLiveSubagentThread(seeded, { ...thread, state: "running", status: "Reading auth", output: undefined });
    expect(live.subagent).toMatchObject({ running: 1, completed: 0, results: [{ label: thread.path, recentSteps: [{ text: "Reading auth" }], usage: { total: 1660 } }] });
    const stopped = attachLiveSubagentThread(live, { ...thread, state: "stopped", error: undefined });
    expect(stopped.subagent).toMatchObject({ running: 0, completed: 0, failed: 0, results: [{ state: "cancelled" }] });
    expect(attachLiveSubagentThread(live, { ...thread, state: "paused" }).subagent).toMatchObject({ completed: 0, partial: 1 });
  });

  it("seeds a running card from agent_spawn with the agent type as the name", () => {
    const view = subagentViewFromArgs("agent_spawn", { path: "/root/map-auth", type: "scout", task: "Map the auth flow" }, dispatchedAt)?.results[0];
    expect(view).toMatchObject({ agent: "scout", label: "/root/map-auth", prompt: "Map the auth flow", state: "running", startedAt: dispatchedAt });
    expect(view?.fullPrompt).toBe("Map the auth flow");
  });

  it("maps a thread snapshot onto the card fields", () => {
    const done = attachSubagentView(managerTool("agent_spawn"), { details: thread });
    expect(done.subagent).toMatchObject({ total: 1, completed: 1 });
    expect(done.subagent).not.toHaveProperty("partial");
    expect(done.subagent?.results[0]).toMatchObject({
      agent: "scout",
      label: "/root/map-auth",
      state: "completed",
      durationMs: 42_000,
      output: "Auth flows through src/server/app.ts",
    });
    expect(done.subagent?.results[0]?.usage).toEqual({ input: 1_400, output: 260, total: 1_660, cost: 0.004 });
  });

  it("shows a list of threads as one tile each and maps paused and stopped states", () => {
    const listed = attachSubagentView(managerTool("agent_status"), {
      details: [
        thread,
        { ...thread, path: "/root/review", type: "reviewer", state: "paused", status: "Paused", output: undefined },
        { ...thread, path: "/root/older", type: "coder", state: "stopped" },
      ],
    });
    expect(listed.subagent?.results.map((call) => [call.label, call.state])).toEqual([
      ["/root/map-auth", "completed"],
      ["/root/review", "partial"],
      ["/root/older", "cancelled"],
    ]);
    expect(listed.subagent).toMatchObject({ total: 3, running: 0, failed: 0 });
  });

  it("keeps a live thread's progress line as a step", () => {
    const running = attachSubagentView(managerTool("agent_wait"), { details: { ...thread, state: "running", output: undefined, status: "→ bash pnpm test" } });
    expect(running.subagent?.results[0]).toMatchObject({ state: "running", recentSteps: [{ kind: "text", text: "→ bash pnpm test" }] });
    expect(running.subagent?.results[0]?.durationMs).toBeUndefined();
  });

  it("leaves tools without a thread snapshot as plain rows", () => {
    const plain = attachSubagentView(managerTool("agent_types"), { details: [{ name: "scout", description: "look", model: "x", thinkingLevel: "low" }] });
    expect(plain.subagent).toBeUndefined();
  });
});
