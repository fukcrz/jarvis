import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectUsageStats, UsageLedger, usageRecordFrom } from "./usage-ledger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-ledger-"));
  directories.push(directory);
  return directory;
}

describe("usage ledger", () => {
  it("drops empty usage and keeps a call with tokens", () => {
    expect(usageRecordFrom(call({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBeUndefined();
    expect(usageRecordFrom(call({ input: 5, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1, cost: { total: 0.02 } }))).toMatchObject({ provider: "openai", model: "gpt", cost: 0.02, reasoning: 1 });
  });

  it("sums recorded calls and keeps them grouped after the session is gone", async () => {
    const directory = await home();
    const ledger = new UsageLedger(join(directory, "usage.jsonl"));
    await ledger.record(usageRecordFrom(call({ input: 10, output: 4, cacheRead: 3, cacheWrite: 1, cost: { total: 0.3 } }))!);
    const earlier = usageRecordFrom(call({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, provider: "openai", model: "gpt", sessionId: "s3", cost: { total: 1.2 } }))!;
    earlier.at = "2026-08-01T00:00:00.000Z";
    await ledger.record(earlier);
    await ledger.record(usageRecordFrom(call({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0, provider: "anthropic", model: "sonnet", sessionId: "s2", cost: { total: 0.5 } }))!);
    await appendRaw(directory, "{not json\n");

    const stats = await collectUsageStats([{ id: "w1", label: "工作区", cwd: "/work", sortOrder: 0, createdAt: "", updatedAt: "", lastOpenedAt: "" }], "all", Date.now(), directory);
    expect(stats.sessions).toBe(3);
    expect(stats.totals).toMatchObject({ calls: 3, input: 13, cacheRead: 3, cacheWrite: 1, cost: 2, pricedCalls: 3 });
    expect(stats.byProvider.map((row) => row.provider)).toEqual(["openai", "anthropic"]);
    expect(stats.byModel[0]).toMatchObject({ provider: "openai", model: "gpt" });
    expect(stats.byWorkspace[0]).toMatchObject({ label: "工作区" });
    expect(stats.byDay.map((row) => row.day)).toEqual(["2026-08-02", "2026-08-01"]);
    expect(stats.byDay[0]).toMatchObject({ topProvider: "openai", models: 2 });
    expect(stats.byDay[1]).toMatchObject({ topProvider: "openai", models: 1 });
  });

  it("limits a range to calls inside it", async () => {
    const directory = await home();
    const ledger = new UsageLedger(join(directory, "usage.jsonl"));
    const old = usageRecordFrom(call({ input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }))!;
    old.at = "2020-01-01T00:00:00.000Z";
    await ledger.record(old);
    const recent = usageRecordFrom(call({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }))!;
    recent.at = new Date().toISOString();
    await ledger.record(recent);

    const stats = await collectUsageStats([], "30d", Date.now(), directory);
    expect(stats.totals).toMatchObject({ calls: 1, input: 1 });
  });

  it("keeps today to calls since local midnight", async () => {
    const directory = await home();
    const ledger = new UsageLedger(join(directory, "usage.jsonl"));
    const now = Date.now();
    const yesterday = usageRecordFrom(call({ input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }))!;
    yesterday.at = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    await ledger.record(yesterday);
    const today = usageRecordFrom(call({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }))!;
    today.at = new Date(now).toISOString();
    await ledger.record(today);

    const stats = await collectUsageStats([], "today", now, directory);
    expect(stats.range).toBe("today");
    expect(stats.totals).toMatchObject({ calls: 1, input: 3 });
  });

  it("limits every breakdown to one workspace while keeping the workspace list", async () => {
    const directory = await home();
    const ledger = new UsageLedger(join(directory, "usage.jsonl"));
    await ledger.record(usageRecordFrom(call({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, provider: "openai" }))!);
    await ledger.record(usageRecordFrom(call({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0, provider: "anthropic", workspaceId: "w2", sessionId: "s2" }))!);

    const stats = await collectUsageStats([], "all", Date.now(), directory, "w1");
    expect(stats.workspaceId).toBe("w1");
    expect(stats.totals).toMatchObject({ calls: 1, input: 10 });
    expect(stats.byProvider.map((row) => row.provider)).toEqual(["openai"]);
    expect(stats.byWorkspace.map((row) => row.workspaceId)).toEqual(["w1", "w2"]);
  });
});

function call(overrides: Record<string, unknown>): Parameters<typeof usageRecordFrom>[0] {
  const { provider, model, sessionId, workspaceId, ...usage } = overrides;
  return {
    at: "2026-08-02T00:00:00.000Z",
    workspaceId: typeof workspaceId === "string" ? workspaceId : "w1",
    sessionId: typeof sessionId === "string" ? sessionId : "s1",
    provider: typeof provider === "string" ? provider : "openai",
    model: typeof model === "string" ? model : "gpt",
    usage: { cacheRead: 0, cacheWrite: 0, ...usage },
  };
}

async function appendRaw(directory: string, text: string): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(directory, "usage.jsonl"), text, "utf8");
}
