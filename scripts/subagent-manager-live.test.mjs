import { expect, it } from "vitest";
import { ThreadManager } from "../plugins/pi-subagent-manager/src/orch/manager.ts";

it("keeps streamed child progress display-only and settles to the final result", async () => {
  const events = [];
  let options;
  let finish;
  const work = new Promise((resolve) => { finish = resolve; });
  const manager = new ThreadManager({
    rootSnapshot: () => [], getType: (name) => ({ name, description: "test", systemPrompt: "" }), toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: async (value) => {
      options = value;
      return { prompt: () => work, steer: async () => {}, snapshot: () => [], output: () => "OK", abort: async () => { finish(); }, dispose: () => {}, sendUpdate: () => {} };
    },
  });
  try {
    await manager.spawn("/root", { path: "short", type: "scout", task: "Return OK", wait: false });
    // Startup runs in a promise chain, without any model/network calls.
    for (let i = 0; manager.get("/root/short").state !== "running" && i < 40; i++) await Promise.resolve();
    expect(options).toBeDefined();
    events.length = 0;
    options.onEvent({ kind: "activity", text: "Streaming answer", partial: true });
    expect(events.map((event) => event.kind)).toEqual(["metrics"]);
    expect(manager.get("/root/short").status).toBe("Streaming answer");
    expect(manager.saved()[0]?.view.status).toBe("Working");
    finish();
    const completed = await manager.wait("/root", "/root/short");
    expect(completed).toMatchObject({ state: "completed", output: "OK" });
  } finally { await manager.shutdown(); }
});
