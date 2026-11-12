import { expect, it, vi } from "vitest";
import { ThreadManager } from "../plugins/pi-subagent-manager/src/orch/manager.ts";
import { agentTools } from "../plugins/pi-subagent-manager/src/orch/tools.ts";

function fixture() {
  const manager = new ThreadManager({
    maxThreads: 3,
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "test", systemPrompt: "" }),
    toolsFor: () => [],
    createDriver: async () => ({
      prompt: async () => {}, steer: async () => {}, snapshot: () => [],
      output: () => "OK", abort: async () => {}, dispose: () => {}, sendUpdate: () => {},
    }),
  });
  const persist = vi.fn();
  const reap = (caller, params = {}) => agentTools(() => manager, caller, () => [], () => ({}), persist)
    .find((tool) => tool.name === "agent_reap").execute("test", params);
  const spawn = (path) => manager.spawn("/root", { path, type: "test", task: "Return OK" });
  return { manager, persist, reap, spawn };
}

it("reaps completed threads through the AI tool and releases total slots", async () => {
  const { manager, persist, reap, spawn } = fixture();
  try {
    await spawn("one"); await spawn("two"); await spawn("three");
    await expect(spawn("four")).rejects.toThrow("Total thread limit");
    const result = await reap("/root", { paths: ["one"] });
    expect(result.details).toEqual({ reaped: ["/root/one"], count: 1 });
    expect(persist).toHaveBeenCalledOnce();
    expect(manager.saved().map((thread) => thread.view.path)).not.toContain("/root/one");
    expect(() => manager.get("/root/one")).toThrow();
    await spawn("four");
    expect((await reap("/root")).details.count).toBe(3);
    expect((await reap("/root")).details.count).toBe(0);
    expect(persist).toHaveBeenCalledTimes(2);
  } finally { await manager.shutdown(); }
});

it("scopes cleanup to descendants and preserves ancestors needed by retained children", async () => {
  const { manager, reap, spawn } = fixture();
  try {
    await spawn("parent"); await spawn("other");
    await spawn("/root/parent/child");
    await expect(reap("/root/parent", { paths: ["/root/other"] })).rejects.toThrow("descendants");
    expect((await reap("/root", { paths: ["parent"] })).details.count).toBe(0);
    expect((await reap("/root/parent")).details.reaped).toEqual(["/root/parent/child"]);
    expect(manager.list().map((thread) => thread.path)).toEqual(["/root/parent", "/root/other"]);
  } finally { await manager.shutdown(); }
});

it("retains threads not in completed state", async () => {
  const { manager, reap } = fixture();
  try {
    manager.restore(["running", "paused", "stopped", "failed"].map((state, index) => ({
      view: { path: `/root/t${index}`, parent: "/root", owner: "/root", type: "test", state, task: "test", status: state, createdAt: index },
      definition: { name: "test", description: "test", systemPrompt: "" },
    })));
    expect((await reap("/root")).details.count).toBe(0);
    expect(manager.list()).toHaveLength(4);
  } finally { await manager.shutdown(); }
});
