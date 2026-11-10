import { describe, expect, it } from "vitest";
import type { SubagentThreadRow } from "../../shared/protocol";
import { reachSubagentCard, subagentElapsed, subagentStatusLabel, subagentThreadCounts } from "./subagents";

function row(path: string, state: SubagentThreadRow["state"]): SubagentThreadRow {
  return { path, type: "scout", state, line: "Reading" };
}

describe("subagent status line", () => {
  it("counts running and paused separately", () => {
    const threads = [row("/root/a", "running"), row("/root/b", "running"), row("/root/c", "paused")];
    expect(subagentThreadCounts(threads)).toEqual({ running: 2, paused: 1 });
    expect(subagentThreadCounts(undefined)).toEqual({ running: 0, paused: 0 });
  });

  it("reports only threads that are running", () => {
    expect(subagentStatusLabel(undefined)).toBeUndefined();
    expect(subagentStatusLabel([])).toBeUndefined();
    expect(subagentStatusLabel([row("/root/a", "running"), row("/root/b", "running")])).toBe("2 个子代理执行中");
    expect(subagentStatusLabel([row("/root/a", "running"), row("/root/c", "paused")])).toBe("1 个子代理执行中 · 1 已暂停");
    // paused 不会自己往前走，不单独占一行。
    expect(subagentStatusLabel([row("/root/c", "paused")])).toBeUndefined();
    expect(subagentStatusLabel([row("/root/c", "paused"), row("/root/d", "paused")])).toBeUndefined();
  });

  it("stops paging back once history runs out", async () => {
    let pages = 0;
    // node 环境没有 DOM，每页都找不到卡片，靠页数上限收口。
    expect(await reachSubagentCard("/root/a", () => { pages += 1; return Promise.resolve(false); })).toBe(false);
    expect(pages).toBe(1);
    pages = 0;
    expect(await reachSubagentCard("/root/a", () => { pages += 1; return Promise.resolve(true); })).toBe(false);
    expect(pages).toBe(20);
  });

  it("formats elapsed time from the run start", () => {
    expect(subagentElapsed({}, 0)).toBeUndefined();
    expect(subagentElapsed({ startedAt: "not-a-date" }, 0)).toBeUndefined();
    expect(subagentElapsed({ startedAt: "2026-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:04:12.000Z"))).toBe("4:12");
    // paused 线程的时长已冻结，不跟着当前时间涨。
    expect(subagentElapsed({ elapsedMs: 41_000 }, Date.parse("2026-01-01T09:00:00.000Z"))).toBe("0:41");
  });
});
